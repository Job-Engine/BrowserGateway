# Deterministic Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zero LLM calls on the recurring job path: record a trace from the first successful LLM run per useCase and client, replay it deterministically afterwards, heal by falling back to the LLM when a portal changes.

**Architecture:** A new core module `src/replay.ts` holds trace types, parameterization, a fuzzy identity matcher, the deterministic executor `runReplay`, and the learn wrapper `runLearnAndRecord` (runLoop plus read-selector grounding). A new gateway store `src/gateway/traces.ts` persists versioned traces in Postgres. The runner picks replay when an active trace exists, learn otherwise, and heal (learn again) when replay fails. Spec: `docs/superpowers/specs/2026-07-14-deterministic-replay-design.md`.

**Tech Stack:** Node 20+, TypeScript 5.9 (pinned), ESM, Fastify, zod, pg, Vitest, Stagehand v3, React 19 + Vite (console).

## Global Constraints

- Writing style everywhere (docs, comments, UI copy): no em dashes, no emojis, concise.
- Coverage gate: >= 80 percent statements on `src/gateway`; `npm test` must stay green.
- Envelope changes are additive only. `failure` = clean negative, `error` = system problem. The replay path never emits `failure` on its own; it escalates.
- Secrets never appear in code, logs, traces, envelopes, or LLM prompts. Traces must be rejected at save time if they contain a credential literal.
- Read-only enforcement in code: replayed steps are checked against `READ_ONLY_METHODS`, fail closed.
- Agent core freeze: only `src/browser.ts` (one read primitive) and the new `src/replay.ts` may change in `src/` outside the gateway. `loop.ts`, `planner.ts`, `index.ts` stay untouched.
- Keep `AGENTS.md` and `GET /openapi.json` in sync with the shipped surface (Task 11).
- Tests that need Postgres use `createTestDb()` from `test/gateway/helpers/testdb.js` (needs `docker compose up -d`).
- Pre-commit hooks run prettier via lint-staged; commit messages follow the repo's conventional style.

---

### Task 1: Trace store and migration

**Files:**

- Create: `migrations/0003_action_traces.sql`
- Create: `src/gateway/traces.ts`
- Test: `test/gateway/traces.test.ts`

**Interfaces:**

- Consumes: `Pool` from `src/gateway/db.js`; `TraceStep` type is defined here temporarily-free: it imports `type { TraceStep } from "../replay.js"` only after Task 2 lands. To keep Task 1 independent, define the row shape with `steps: unknown[]` typed via the local `StoredStep` alias below, switched to `TraceStep` in Task 8 wiring (one-line import change, included in Task 8).
- Produces: `createTraceStore(pool)` returning `{ saveTrace, getActive, recordSuccess, invalidate, list }` and types `TraceRow`, `TraceStore`. Later tasks rely on these exact names.

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0003_action_traces.sql
-- Persistent per-action replay traces (deterministic replay feature).
create table action_traces (
  id uuid primary key default gen_random_uuid(),
  use_case text not null,
  client text not null,
  version int not null,
  state text not null default 'active' check (state in ('active', 'retired')),
  steps jsonb not null,
  read_selectors jsonb not null default '{}',
  recorded_from_job_id uuid,
  heal_count int not null default 0,
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  unique (use_case, client, version)
);

create unique index action_traces_one_active
  on action_traces (use_case, client) where state = 'active';
```

- [ ] **Step 2: Write the failing tests**

```typescript
// test/gateway/traces.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/testdb.js";
import { createTraceStore, type TraceStore } from "../../src/gateway/traces.js";

let db: TestDb;
let store: TraceStore;

const KEY = { useCase: "lightreach.ntpDate", client: "spartan" };
const steps = [
  {
    selector: "xpath=/html[1]/body[1]/div[1]/input[1]",
    method: "fill",
    arguments: ["%username%"],
    description: "Type %username% into the Email field",
    paramTemplate: null,
  },
];
const readSelectors = { matchedName: "xpath=/html[1]/body[1]/h1[1]" };

beforeAll(async () => {
  db = await createTestDb();
  store = createTraceStore(db.pool);
});
afterAll(async () => {
  await db.teardown();
});

describe("trace store", () => {
  it("saves an active trace at version 1 and finds it", async () => {
    const row = await store.saveTrace({
      ...KEY,
      steps,
      readSelectors,
      activate: true,
      secretValues: ["hunter2"],
    });
    expect(row.version).toBe(1);
    expect(row.state).toBe("active");
    const active = await store.getActive(KEY.useCase, KEY.client);
    expect(active?.id).toBe(row.id);
    expect(active?.steps).toEqual(steps);
  });

  it("bumps the version and retires the previous active on re-save", async () => {
    const v2 = await store.saveTrace({
      ...KEY,
      steps,
      readSelectors,
      activate: true,
      secretValues: [],
    });
    expect(v2.version).toBe(2);
    const active = await store.getActive(KEY.useCase, KEY.client);
    expect(active?.version).toBe(2);
    const all = await store.list(KEY.useCase);
    expect(all.filter((t) => t.state === "active")).toHaveLength(1);
  });

  it("carries heal_count forward and increments it on healed saves", async () => {
    const healed = await store.saveTrace({
      ...KEY,
      steps,
      readSelectors,
      activate: true,
      healed: true,
      secretValues: [],
    });
    expect(healed.healCount).toBe(1);
  });

  it("stores retired (not active) when activate is false", async () => {
    const inactive = await store.saveTrace({
      useCase: "lightreach.ntpDate",
      client: "lgcyco",
      steps,
      readSelectors: {},
      activate: false,
      secretValues: [],
    });
    expect(inactive.state).toBe("retired");
    expect(await store.getActive("lightreach.ntpDate", "lgcyco")).toBeNull();
  });

  it("rejects a trace containing a credential literal", async () => {
    const leaky = [{ ...steps[0], arguments: ["hunter2"] }];
    await expect(
      store.saveTrace({
        ...KEY,
        steps: leaky,
        readSelectors,
        activate: true,
        secretValues: ["hunter2"],
      }),
    ).rejects.toThrow(/credential/i);
  });

  it("records success and invalidates", async () => {
    const active = await store.getActive(KEY.useCase, KEY.client);
    await store.recordSuccess(active!.id);
    const after = await store.getActive(KEY.useCase, KEY.client);
    expect(after?.lastSuccessAt).toBeTruthy();
    expect(await store.invalidate(KEY.useCase, KEY.client)).toBe(true);
    expect(await store.getActive(KEY.useCase, KEY.client)).toBeNull();
    expect(await store.invalidate(KEY.useCase, KEY.client)).toBe(false);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/gateway/traces.test.ts`
Expected: FAIL, cannot resolve `../../src/gateway/traces.js`

- [ ] **Step 4: Implement the store**

```typescript
// src/gateway/traces.ts
// Versioned replay traces per useCase and client. At most one active trace
// per pair; old versions are retired, never deleted. Secrets must never be
// stored: saveTrace rejects any payload containing a credential literal.
import type pg from "pg";

/** Mirror of src/replay.ts TraceStep; kept structural to avoid a core import here. */
export interface StoredStep {
  selector: string;
  method: string;
  arguments: string[];
  description: string;
  paramTemplate: { selector: string; arguments: string[] } | null;
}

export interface TraceRow {
  id: string;
  useCase: string;
  client: string;
  version: number;
  state: "active" | "retired";
  steps: StoredStep[];
  readSelectors: Record<string, string>;
  recordedFromJobId: string | null;
  healCount: number;
  lastSuccessAt: string | null;
  createdAt: string;
}

export interface SaveTraceOpts {
  useCase: string;
  client: string;
  steps: StoredStep[];
  readSelectors: Record<string, string>;
  recordedFromJobId?: string;
  /** false stores the trace retired (incomplete grounding); it never replays. */
  activate: boolean;
  /** true when this save heals a failed replay; increments heal_count. */
  healed?: boolean;
  /** Credential values that must not appear anywhere in the trace. */
  secretValues: string[];
}

function rowToTrace(r: Record<string, unknown>): TraceRow {
  return {
    id: r.id as string,
    useCase: r.use_case as string,
    client: r.client as string,
    version: r.version as number,
    state: r.state as TraceRow["state"],
    steps: r.steps as StoredStep[],
    readSelectors: r.read_selectors as Record<string, string>,
    recordedFromJobId: (r.recorded_from_job_id as string) ?? null,
    healCount: r.heal_count as number,
    lastSuccessAt: r.last_success_at ? new Date(r.last_success_at as string).toISOString() : null,
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

export function createTraceStore(pool: pg.Pool) {
  return {
    async saveTrace(opts: SaveTraceOpts): Promise<TraceRow> {
      const serialized = JSON.stringify({ steps: opts.steps, readSelectors: opts.readSelectors });
      for (const secret of opts.secretValues) {
        if (secret && serialized.includes(secret)) {
          throw new Error("trace rejected: payload contains a credential literal");
        }
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const prev = await client.query(
          `select version, heal_count, state from action_traces
           where use_case = $1 and client = $2
           order by version desc limit 1 for update`,
          [opts.useCase, opts.client],
        );
        const prevVersion = (prev.rows[0]?.version as number) ?? 0;
        const prevHeals = (prev.rows[0]?.heal_count as number) ?? 0;
        if (opts.activate) {
          await client.query(
            `update action_traces set state = 'retired'
             where use_case = $1 and client = $2 and state = 'active'`,
            [opts.useCase, opts.client],
          );
        }
        const inserted = await client.query(
          `insert into action_traces
             (use_case, client, version, state, steps, read_selectors, recorded_from_job_id, heal_count)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning *`,
          [
            opts.useCase,
            opts.client,
            prevVersion + 1,
            opts.activate ? "active" : "retired",
            JSON.stringify(opts.steps),
            JSON.stringify(opts.readSelectors),
            opts.recordedFromJobId ?? null,
            opts.healed ? prevHeals + 1 : prevHeals,
          ],
        );
        await client.query("commit");
        return rowToTrace(inserted.rows[0]);
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    async getActive(useCase: string, client: string): Promise<TraceRow | null> {
      const res = await pool.query(
        `select * from action_traces
         where use_case = $1 and client = $2 and state = 'active'`,
        [useCase, client],
      );
      return res.rows[0] ? rowToTrace(res.rows[0]) : null;
    },

    async recordSuccess(id: string): Promise<void> {
      await pool.query(`update action_traces set last_success_at = now() where id = $1`, [id]);
    },

    /** Retire the active trace, forcing a learn run on the next job. */
    async invalidate(useCase: string, client: string): Promise<boolean> {
      const res = await pool.query(
        `update action_traces set state = 'retired'
         where use_case = $1 and client = $2 and state = 'active'`,
        [useCase, client],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async list(useCase?: string): Promise<TraceRow[]> {
      const res = useCase
        ? await pool.query(
            `select * from action_traces where use_case = $1 order by client, version desc`,
            [useCase],
          )
        : await pool.query(`select * from action_traces order by use_case, client, version desc`);
      return res.rows.map(rowToTrace);
    },
  };
}

export type TraceStore = ReturnType<typeof createTraceStore>;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/gateway/traces.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add migrations/0003_action_traces.sql src/gateway/traces.ts test/gateway/traces.test.ts
git commit -m "feat(traces): versioned action trace store with secret scrub"
```

---

### Task 2: Trace types, parameterization, and resolution

**Files:**

- Create: `src/replay.ts`
- Test: `test/replay.test.ts`

**Interfaces:**

- Consumes: `ActionRecord`, `ObservedAction` from `src/types.js`.
- Produces (exact, later tasks import these): `interface TraceStep { selector: string; method: string; arguments: string[]; description: string; paramTemplate: { selector: string; arguments: string[] } | null }`, `interface ReplayTrace { steps: TraceStep[]; readSelectors: Record<string, string> }`, `parameterizeSteps(records: ActionRecord[], input: Record<string, string>): TraceStep[]`, `resolveStep(step: TraceStep, input: Record<string, string>): ObservedAction`.

- [ ] **Step 1: Write the failing tests**

```typescript
// test/replay.test.ts
import { describe, expect, it } from "vitest";
import { parameterizeSteps, resolveStep, type TraceStep } from "../src/replay.js";
import type { ActionRecord } from "../src/types.js";

function record(
  action: Partial<ActionRecord["action"]>,
  outcome: ActionRecord["outcome"] = "executed",
): ActionRecord {
  return {
    step: 1,
    action: {
      selector: "xpath=/html[1]/body[1]/a[1]",
      description: "click something",
      method: "click",
      arguments: [],
      instruction: "click something",
      ...action,
    },
    risk: { level: "safe", reason: "test" },
    decision: "auto",
    outcome,
  };
}

describe("parameterizeSteps", () => {
  it("keeps input-independent steps verbatim with a null template", () => {
    const [step] = parameterizeSteps([record({})], { name: "Jason Marshall" });
    expect(step.paramTemplate).toBeNull();
    expect(step.selector).toBe("xpath=/html[1]/body[1]/a[1]");
  });

  it("templates an input value found in arguments and description", () => {
    const [step] = parameterizeSteps(
      [
        record({
          method: "type",
          arguments: ["Jason Marshall"],
          description: 'Type "Jason Marshall" into the Search box',
        }),
      ],
      { name: "Jason Marshall", address: "205 Morningside Ct" },
    );
    expect(step.paramTemplate).not.toBeNull();
    expect(step.paramTemplate!.arguments).toEqual(["%name%"]);
  });

  it("templates an input value embedded in the selector", () => {
    const [step] = parameterizeSteps(
      [record({ selector: 'xpath=//a[contains(., "Jason Marshall")]' })],
      { name: "Jason Marshall" },
    );
    expect(step.paramTemplate!.selector).toBe('xpath=//a[contains(., "%name%")]');
  });

  it("requires whole-token matches so short values cannot false-positive", () => {
    const [step] = parameterizeSteps(
      [record({ selector: "xpath=/html[1]/body[1]/div[12]/a[1]" })],
      { projectId: "12" },
    );
    expect(step.paramTemplate).toBeNull();
  });

  it("drops non-executed steps", () => {
    const steps = parameterizeSteps([record({}, "failed"), record({})], {});
    expect(steps).toHaveLength(1);
  });

  it("never touches credential placeholders", () => {
    const [step] = parameterizeSteps([record({ method: "fill", arguments: ["%username%"] })], {
      name: "Jason Marshall",
    });
    expect(step.arguments).toEqual(["%username%"]);
    expect(step.paramTemplate).toBeNull();
  });
});

describe("resolveStep", () => {
  const templated: TraceStep = {
    selector: 'xpath=//a[contains(., "Jason Marshall")]',
    method: "click",
    arguments: [],
    description: "click the customer link",
    paramTemplate: { selector: 'xpath=//a[contains(., "%name%")]', arguments: [] },
  };

  it("substitutes current input into the template", () => {
    const action = resolveStep(templated, { name: "Maria Lopez" });
    expect(action.selector).toBe('xpath=//a[contains(., "Maria Lopez")]');
  });

  it("uses the recorded selector when no template exists", () => {
    const action = resolveStep({ ...templated, paramTemplate: null }, { name: "Maria Lopez" });
    expect(action.selector).toBe('xpath=//a[contains(., "Jason Marshall")]');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/replay.test.ts`
Expected: FAIL, cannot resolve `../src/replay.js`

- [ ] **Step 3: Implement**

```typescript
// src/replay.ts
// Deterministic replay: trace types, input parameterization, identity
// matching, the replay executor, and the learn wrapper that records traces.
// Sanctioned core change 5 (see docs/superpowers/specs/2026-07-14-deterministic-replay-design.md).
import type { ActionRecord, ObservedAction } from "./types.js";

export interface TraceStep {
  selector: string;
  method: string;
  arguments: string[];
  description: string;
  /** Set when the step embeds an input value; tokens are %inputKey%. */
  paramTemplate: { selector: string; arguments: string[] } | null;
}

export interface ReplayTrace {
  steps: TraceStep[];
  /** Extract field name to selector, grounded at record time. */
  readSelectors: Record<string, string>;
}

const MIN_PARAM_LENGTH = 3;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-token, case-insensitive occurrence of value inside text. */
function tokenPattern(value: string): RegExp {
  return new RegExp(`(^|[^a-zA-Z0-9])(${escapeRegExp(value)})(?=[^a-zA-Z0-9]|$)`, "gi");
}

function substitute(text: string, key: string, value: string): { out: string; hit: boolean } {
  let hit = false;
  const out = text.replace(tokenPattern(value), (_m, pre: string) => {
    hit = true;
    return `${pre}%${key}%`;
  });
  return { out, hit };
}

/**
 * Build replayable steps from a successful run's actionsLog. Any step text
 * that embeds an input VALUE gets a template with the value swapped for its
 * %inputKey% token. Credentials never appear literally (they are always
 * placeholder tokens already), so only input fields are considered.
 */
export function parameterizeSteps(
  records: ActionRecord[],
  input: Record<string, string>,
): TraceStep[] {
  return records
    .filter((r) => r.outcome === "executed")
    .map((r) => {
      const args = r.action.arguments ?? [];
      let selector = r.action.selector;
      let outArgs = [...args];
      let touched = false;
      for (const [key, value] of Object.entries(input)) {
        if (!value || value.length < MIN_PARAM_LENGTH) continue;
        const sel = substitute(selector, key, value);
        if (sel.hit) {
          selector = sel.out;
          touched = true;
        }
        outArgs = outArgs.map((a) => {
          const sub = substitute(a, key, value);
          if (sub.hit) touched = true;
          return sub.out;
        });
      }
      return {
        selector: r.action.selector,
        method: r.action.method ?? "",
        arguments: args,
        description: r.action.description,
        paramTemplate: touched ? { selector, arguments: outArgs } : null,
      };
    });
}

/** Resolve a step against the current job's input for execution. */
export function resolveStep(step: TraceStep, input: Record<string, string>): ObservedAction {
  const fill = (text: string): string =>
    Object.entries(input).reduce((acc, [key, value]) => acc.split(`%${key}%`).join(value), text);
  const source = step.paramTemplate ?? { selector: step.selector, arguments: step.arguments };
  return {
    selector: step.paramTemplate ? fill(source.selector) : source.selector,
    method: step.method,
    // Credential tokens (%username%...) stay: Stagehand resolves them via variables.
    arguments: step.paramTemplate ? source.arguments.map(fill) : source.arguments,
    description: step.description,
  };
}
```

Note: `fill` substitutes input keys only (the keys present in `input`); credential placeholders are not in `input`, so they survive to `act(action, variables)` where Stagehand substitutes them without the LLM seeing values.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/replay.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/replay.ts test/replay.test.ts
git commit -m "feat(replay): trace steps with whole-token input parameterization"
```

---

### Task 3: Identity normalization and fuzzy matcher

**Files:**

- Modify: `src/replay.ts` (append)
- Test: `test/replay.test.ts` (append)

**Interfaces:**

- Produces: `normalizeIdentity(s: string): string`, `fuzzyMatch(shown: string, expected: string): boolean`. `runReplay` (Task 5) and its tests use these exact names.

- [ ] **Step 1: Write the failing tests (append to test/replay.test.ts)**

```typescript
import { fuzzyMatch, normalizeIdentity } from "../src/replay.js";

describe("normalizeIdentity", () => {
  it("lowercases, strips punctuation, expands abbreviations", () => {
    expect(normalizeIdentity("205 Morningside Ct. NE, Cedar Rapids")).toBe(
      "205 morningside court northeast cedar rapids",
    );
  });
});

describe("fuzzyMatch", () => {
  it("accepts exact matches ignoring case", () => {
    expect(fuzzyMatch("Jason Marshall", "jason marshall")).toBe(true);
  });
  it("accepts abbreviation and punctuation differences", () => {
    expect(
      fuzzyMatch(
        "205 Morningside Court Northeast, Cedar Rapids, IA 52402",
        "205 Morningside Ct NE Cedar Rapids IA 52402",
      ),
    ).toBe(true);
  });
  it("accepts extra tokens on the page (middle name) when all expected tokens appear", () => {
    expect(fuzzyMatch("Jason A Marshall", "Jason Marshall")).toBe(true);
  });
  it("rejects a different person", () => {
    expect(fuzzyMatch("Mason Marshall", "Jason Marshall")).toBe(false);
  });
  it("rejects a different street", () => {
    expect(
      fuzzyMatch(
        "206 Sunnyside Court Northeast, Cedar Rapids",
        "205 Morningside Ct NE Cedar Rapids",
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/replay.test.ts`
Expected: FAIL, `normalizeIdentity` is not exported

- [ ] **Step 3: Implement (append to src/replay.ts)**

```typescript
/** Common US address and name abbreviations, both directions normalized. */
const ABBREVIATIONS: Record<string, string> = {
  st: "street",
  ave: "avenue",
  blvd: "boulevard",
  dr: "drive",
  rd: "road",
  ln: "lane",
  ct: "court",
  cir: "circle",
  hwy: "highway",
  pkwy: "parkway",
  apt: "apartment",
  ste: "suite",
  fl: "floor",
  n: "north",
  s: "south",
  e: "east",
  w: "west",
  ne: "northeast",
  nw: "northwest",
  se: "southeast",
  sw: "southwest",
};

export function normalizeIdentity(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,#()]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ABBREVIATIONS[t] ?? t)
    .join(" ");
}

/**
 * Conservative identity match: after normalization, every expected token must
 * appear among the shown tokens. Extra tokens on the page (middle names,
 * suite numbers) are tolerated; missing or different tokens are not.
 */
export function fuzzyMatch(shown: string, expected: string): boolean {
  const shownTokens = new Set(normalizeIdentity(shown).split(" "));
  const expectedTokens = normalizeIdentity(expected).split(" ");
  if (expectedTokens.length === 0) return false;
  return expectedTokens.every((t) => shownTokens.has(t));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/replay.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/replay.ts test/replay.test.ts
git commit -m "feat(replay): conservative fuzzy identity matcher"
```

---

### Task 4: readText adapter primitive

**Files:**

- Modify: `src/types.ts` (BrowserAgent interface)
- Modify: `src/browser.ts` (implementation)
- Modify: `test/loop.test.ts` and any other file the compiler flags (fake agents)

**Interfaces:**

- Produces: `BrowserAgent.readText(selector: string): Promise<string | null>`. Returns trimmed visible text, or null when the element is missing, empty, or the read fails. Never throws.

- [ ] **Step 1: Add to the interface**

In `src/types.ts`, inside `interface BrowserAgent` after `extract`:

```typescript
  /**
   * Read the trimmed text content of the first element matching selector.
   * Null when missing, empty, or unreadable. No LLM involved. Used by the
   * deterministic replay path (sanctioned change 5).
   */
  readText(selector: string): Promise<string | null>;
```

- [ ] **Step 2: Run typecheck to enumerate every fake that must be updated**

Run: `npm run typecheck`
Expected: FAIL listing each object literal implementing `BrowserAgent` without `readText` (at minimum `src/browser.ts` and fakes in `test/loop.test.ts`).

- [ ] **Step 3: Implement in the adapter**

In `src/browser.ts`, add to the returned object after `extract`:

```typescript
    async readText(selector: string): Promise<string | null> {
      try {
        const text = await page
          .locator(selector)
          .first()
          .textContent({ timeout: 5000 });
        const trimmed = text?.trim() ?? "";
        return trimmed.length > 0 ? trimmed : null;
      } catch {
        return null;
      }
    },
```

Stagehand selectors are `xpath=`-prefixed strings; Playwright locators accept that prefix natively.

- [ ] **Step 4: Update fakes**

In every fake `BrowserAgent` the typecheck flagged (e.g. `makeFakeAgent` in `test/loop.test.ts` and the inline agent around line 175), add:

```typescript
    readText: async () => null,
```

- [ ] **Step 5: Verify typecheck and tests pass**

Run: `npm run typecheck && npx vitest run test/loop.test.ts test/index.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/browser.ts test/
git commit -m "feat(core): readText adapter primitive for deterministic reads (sanctioned change 5)"
```

---

### Task 5: Replay executor

**Files:**

- Modify: `src/replay.ts` (append)
- Test: `test/replay.test.ts` (append)

**Interfaces:**

- Consumes: `BrowserAgent` (with `readText`), `resolveStep`, `fuzzyMatch`, `ReplayTrace`; `ReplayPlan` (defined here, re-exported by the catalogue in Task 7).
- Produces (exact):

```typescript
export interface ReplayPlan {
  reads: Record<string, string>;
  verify: Record<string, string>;
  assertTrue: string[];
}
export interface ReplayRunOptions {
  agent: BrowserAgent;
  url: string;
  trace: ReplayTrace;
  plan: ReplayPlan;
  input: Record<string, string>;
  credentials: Record<string, string>;
  allowedMethods: readonly string[];
  deadline: number;
}
export type ReplayOutcome =
  | { ok: true; data: Record<string, unknown>; stepsUsed: number }
  | { ok: false; reason: string; stepsUsed: number };
export async function replayTrace(options: ReplayRunOptions): Promise<ReplayOutcome>;
```

Session creation/closing stays with the caller (Task 8) so this function is testable with a fake agent.

- [ ] **Step 1: Write the failing tests (append to test/replay.test.ts)**

```typescript
import { replayTrace, type ReplayPlan, type ReplayTrace } from "../src/replay.js";
import type { ActOutcome, BrowserAgent, ObservedAction } from "../src/types.js";
import { READ_ONLY_METHODS } from "../src/types.js";

function fakeReplayAgent(opts: {
  actResults?: ActOutcome[];
  texts?: Record<string, string | null>;
}): { agent: BrowserAgent; acted: ObservedAction[] } {
  const acted: ObservedAction[] = [];
  let i = 0;
  const agent: BrowserAgent = {
    goto: async () => {},
    observe: async () => [],
    act: async (action) => {
      acted.push(action);
      return opts.actResults?.[i++] ?? { success: true, message: "ok" };
    },
    extract: (async () => ({})) as unknown as BrowserAgent["extract"],
    readText: async (selector) => opts.texts?.[selector] ?? null,
    close: async () => {},
  };
  return { agent, acted };
}

const TRACE: ReplayTrace = {
  steps: [
    {
      selector: "xpath=/html/body/input[1]",
      method: "fill",
      arguments: ["%username%"],
      description: "fill username",
      paramTemplate: null,
    },
    {
      selector: 'xpath=//a[contains(., "Jason Marshall")]',
      method: "click",
      arguments: [],
      description: "open the record",
      paramTemplate: { selector: 'xpath=//a[contains(., "%name%")]', arguments: [] },
    },
  ],
  readSelectors: {
    matchedName: "xpath=//h1",
    matchedAddress: "xpath=//p[1]",
    ntpDate: "xpath=//span[1]",
  },
};

const PLAN: ReplayPlan = {
  reads: { matchedName: "", matchedAddress: "", ntpDate: "" },
  verify: { matchedName: "name", matchedAddress: "address" },
  assertTrue: ["matchVerified", "ntpDateFound"],
};

const INPUT = { name: "Maria Lopez", address: "10 Oak St" };
const OK_TEXTS = {
  "xpath=//h1": "Maria Lopez",
  "xpath=//p[1]": "10 Oak Street",
  "xpath=//span[1]": "Jul 11, 2026",
};

function run(overrides?: Partial<ReplayRunOptions>) {
  return replayTrace({
    agent: fakeReplayAgent({ texts: OK_TEXTS }).agent,
    url: "https://example.test",
    trace: TRACE,
    plan: PLAN,
    input: INPUT,
    credentials: { username: "u", password: "p" },
    allowedMethods: READ_ONLY_METHODS,
    deadline: Date.now() + 60_000,
    ...overrides,
  });
}

describe("replayTrace", () => {
  it("replays, reads, verifies, and asserts booleans", async () => {
    const { agent, acted } = fakeReplayAgent({ texts: OK_TEXTS });
    const out = await replayTrace({
      agent,
      url: "https://example.test",
      trace: TRACE,
      plan: PLAN,
      input: INPUT,
      credentials: { username: "u", password: "p" },
      allowedMethods: READ_ONLY_METHODS,
      deadline: Date.now() + 60_000,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data).toEqual({
        matchedName: "Maria Lopez",
        matchedAddress: "10 Oak Street",
        ntpDate: "Jul 11, 2026",
        matchVerified: true,
        ntpDateFound: true,
      });
    }
    expect(acted[1].selector).toBe('xpath=//a[contains(., "Maria Lopez")]');
  });

  it("fails closed on a method outside the allowlist", async () => {
    const trace: ReplayTrace = {
      ...TRACE,
      steps: [{ ...TRACE.steps[0], method: "uploadFile" }],
    };
    const out = await run({ trace });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/allowlist/);
  });

  it("escalates when an act fails", async () => {
    const { agent } = fakeReplayAgent({
      actResults: [{ success: false, message: "detached" }],
      texts: OK_TEXTS,
    });
    const out = await run({ agent });
    expect(out.ok).toBe(false);
  });

  it("escalates on identity mismatch", async () => {
    const { agent } = fakeReplayAgent({
      texts: { ...OK_TEXTS, "xpath=//h1": "Someone Else" },
    });
    const out = await run({ agent });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/mismatch/);
  });

  it("escalates when a verify read is missing", async () => {
    const { agent } = fakeReplayAgent({ texts: { ...OK_TEXTS, "xpath=//h1": null } });
    const out = await run({ agent });
    expect(out.ok).toBe(false);
  });

  it("returns null for an empty data read without escalating", async () => {
    const { agent } = fakeReplayAgent({ texts: { ...OK_TEXTS, "xpath=//span[1]": null } });
    const out = await run({ agent });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.ntpDate).toBeNull();
  });

  it("stops at the deadline", async () => {
    const out = await run({ deadline: Date.now() - 1 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/deadline/);
  });
});
```

Add `type ReplayRunOptions` to the import from `../src/replay.js`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/replay.test.ts`
Expected: FAIL, `replayTrace` is not exported

- [ ] **Step 3: Implement (append to src/replay.ts)**

```typescript
import type { BrowserAgent } from "./types.js";

/** Per-action replay configuration, declared on the catalogue entry. */
export interface ReplayPlan {
  /** Extract field to grounding hint (used at record time by the learn wrapper). */
  reads: Record<string, string>;
  /** Read field to input key; every pair must fuzzy-match or the run escalates. */
  verify: Record<string, string>;
  /** Boolean extract fields asserted true on a verified replay. */
  assertTrue: string[];
}

export interface ReplayRunOptions {
  agent: BrowserAgent;
  url: string;
  trace: ReplayTrace;
  plan: ReplayPlan;
  input: Record<string, string>;
  credentials: Record<string, string>;
  allowedMethods: readonly string[];
  /** Epoch ms; work stops when passed. */
  deadline: number;
}

export type ReplayOutcome =
  | { ok: true; data: Record<string, unknown>; stepsUsed: number }
  | { ok: false; reason: string; stepsUsed: number };

/**
 * Execute a stored trace with zero LLM calls. Returns ok only when every step
 * executed, every verify field fuzzy-matched the input, and the data reads
 * completed. Anything else returns ok: false; the caller escalates to the
 * learn path. This function never emits a business "failure".
 */
export async function replayTrace(options: ReplayRunOptions): Promise<ReplayOutcome> {
  const variables = { ...options.input, ...options.credentials };
  let stepsUsed = 0;
  const fail = (reason: string): ReplayOutcome => ({ ok: false, reason, stepsUsed });

  try {
    await options.agent.goto(options.url);
  } catch (e) {
    return fail(`navigation failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const step of options.trace.steps) {
    if (Date.now() > options.deadline) return fail("deadline exceeded");
    const method = step.method.toLowerCase();
    const allowed = method !== "" && options.allowedMethods.some((m) => m.toLowerCase() === method);
    if (!allowed) return fail(`method "${step.method || "(none)"}" is not in the allowlist`);
    const action = resolveStep(step, options.input);
    let outcome;
    try {
      outcome = await options.agent.act(action, variables);
    } catch (e) {
      outcome = { success: false, message: e instanceof Error ? e.message : String(e) };
    }
    stepsUsed++;
    if (!outcome.success) return fail(`step ${stepsUsed} failed: ${outcome.message}`);
  }

  if (Date.now() > options.deadline) return fail("deadline exceeded");

  const data: Record<string, unknown> = {};
  for (const field of Object.keys(options.plan.reads)) {
    const selector = options.trace.readSelectors[field];
    data[field] = selector ? await options.agent.readText(selector) : null;
  }

  for (const [field, inputKey] of Object.entries(options.plan.verify)) {
    const shown = data[field];
    const expected = options.input[inputKey];
    if (typeof shown !== "string" || !expected) {
      return fail(`verify read "${field}" is missing`);
    }
    if (!fuzzyMatch(shown, expected)) {
      return fail(`verification mismatch on "${field}"`);
    }
  }

  for (const field of options.plan.assertTrue) data[field] = true;
  return { ok: true, data, stepsUsed };
}
```

Move the `import type { BrowserAgent }` addition into the existing import from `./types.js` at the top of the file (one import statement total).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/replay.test.ts`
Expected: PASS (20 tests)

- [ ] **Step 5: Commit**

```bash
git add src/replay.ts test/replay.test.ts
git commit -m "feat(replay): deterministic trace executor with code-side verification"
```

---

### Task 6: Learn wrapper with grounding and session management

**Files:**

- Modify: `src/replay.ts` (append)
- Test: `test/replay.test.ts` (append)

**Interfaces:**

- Consumes: `createSession` from `src/browser.js`, `runLoop` from `src/loop.js`, `parameterizeSteps`, `replayTrace`, `DEFAULT_MODEL` from `src/index.js` (import the constant value `"anthropic/claude-sonnet-4-6"` directly as a local constant to avoid a cycle: `src/index.ts` must never import `src/replay.ts`).
- Produces (exact):

```typescript
export interface TraceDraft {
  steps: TraceStep[];
  readSelectors: Record<string, string>;
  /** True when every plan.reads field grounded to a selector. */
  complete: boolean;
}
export interface DeterministicRunOptions {
  url: string;
  goal: string;
  input: Record<string, string>;
  credentials: Record<string, string>;
  extractSchema?: z.ZodType;
  allowedMethods: readonly string[];
  timeoutMs: number;
  model?: string;
  replayPlan?: ReplayPlan;
  trace?: ReplayTrace;
}
export interface DeterministicRunResult {
  mode: "replay" | "learned";
  status: AgentStatus;
  success: boolean;
  data?: unknown;
  actionsLog: ActionRecord[];
  stepsUsed: number;
  sessionId?: string;
  sessionReplayUrl?: string;
  summary: string;
  error?: { message: string };
  traceDraft: TraceDraft | null;
  replayFailureReason?: string;
}
export async function runDeterministic(
  options: DeterministicRunOptions,
): Promise<DeterministicRunResult>;
```

`runDeterministic` is the single entry point the gateway runner calls: with a `trace` it tries replay first and falls back to learn in the same session budget; without one it learns. It owns session creation, the wall-clock deadline, grounding, and cleanup.

- [ ] **Step 1: Write the failing tests (append to test/replay.test.ts)**

Because `runDeterministic` creates a real session, tests mock `../src/browser.js`:

```typescript
import { afterEach, vi } from "vitest";

const sessionAgent = vi.hoisted(() => ({ current: null as BrowserAgent | null }));
vi.mock("../src/browser.js", () => ({
  createSession: vi.fn(async () => sessionAgent.current),
}));

import { runDeterministic } from "../src/replay.js";
import { z } from "zod";

function learnAgent(opts: {
  planScript: Array<{ isDone: boolean; instruction: string }>;
  observed: ObservedAction;
  extractResult: Record<string, unknown>;
  groundSelector?: string | null;
}): BrowserAgent {
  let extractCalls = 0;
  return {
    goto: async () => {},
    observe: async (instruction: string) => {
      if (instruction.startsWith("Find ")) {
        return opts.groundSelector === null
          ? []
          : [{ selector: opts.groundSelector ?? "xpath=//h1", description: "found" }];
      }
      return [opts.observed];
    },
    act: async () => ({ success: true, message: "ok" }),
    extract: (async (_instruction: string) => {
      extractCalls++;
      // First N calls are the planner; the loop's final extract returns data.
      const plan = opts.planScript[extractCalls - 1];
      if (plan) return { reasoning: "r", isDone: plan.isDone, instruction: plan.instruction };
      return opts.extractResult;
    }) as unknown as BrowserAgent["extract"],
    readText: async () => null,
    close: async () => {},
  };
}

const EXTRACT_SCHEMA = z.object({
  matchVerified: z.boolean(),
  matchedName: z.string().nullable(),
  matchedAddress: z.string().nullable(),
  ntpDateFound: z.boolean(),
  ntpDate: z.string().nullable(),
});

afterEach(() => {
  sessionAgent.current = null;
});

describe("runDeterministic (learn path)", () => {
  const options = {
    url: "https://example.test",
    goal: "read the record",
    input: { name: "Jason Marshall", address: "205 Morningside Ct" },
    credentials: { username: "u", password: "p" },
    extractSchema: EXTRACT_SCHEMA,
    allowedMethods: READ_ONLY_METHODS,
    timeoutMs: 30_000,
    replayPlan: PLAN,
  };

  it("learns, grounds read selectors, and returns a complete draft", async () => {
    sessionAgent.current = learnAgent({
      planScript: [
        { isDone: false, instruction: "click the Jason Marshall link" },
        { isDone: true, instruction: "" },
      ],
      observed: {
        selector: 'xpath=//a[contains(., "Jason Marshall")]',
        description: "the record link",
        method: "click",
        arguments: [],
      },
      extractResult: {
        matchVerified: true,
        matchedName: "Jason Marshall",
        matchedAddress: "205 Morningside Ct",
        ntpDateFound: true,
        ntpDate: "Jul 11, 2026",
      },
    });
    const result = await runDeterministic(options);
    expect(result.mode).toBe("learned");
    expect(result.success).toBe(true);
    expect(result.traceDraft?.complete).toBe(true);
    expect(result.traceDraft?.steps[0].paramTemplate?.selector).toBe(
      'xpath=//a[contains(., "%name%")]',
    );
    expect(Object.keys(result.traceDraft?.readSelectors ?? {})).toEqual(Object.keys(PLAN.reads));
  });

  it("marks the draft incomplete when grounding fails", async () => {
    sessionAgent.current = learnAgent({
      planScript: [{ isDone: true, instruction: "" }],
      observed: { selector: "xpath=//a", description: "x", method: "click", arguments: [] },
      extractResult: {
        matchVerified: true,
        matchedName: "Jason Marshall",
        matchedAddress: "205 Morningside Ct",
        ntpDateFound: true,
        ntpDate: null,
      },
      groundSelector: null,
    });
    const result = await runDeterministic(options);
    expect(result.traceDraft?.complete).toBe(false);
  });

  it("returns no draft when the run does not complete", async () => {
    // Planner immediately proposes an action whose method is blocked.
    sessionAgent.current = learnAgent({
      planScript: [{ isDone: false, instruction: "upload a file" }],
      observed: { selector: "xpath=//a", description: "x", method: "upload", arguments: [] },
      extractResult: {},
    });
    const result = await runDeterministic(options);
    expect(result.success).toBe(false);
    expect(result.traceDraft).toBeNull();
  });
});

describe("runDeterministic (replay path)", () => {
  it("replays when a trace is provided and reports mode replay", async () => {
    sessionAgent.current = fakeReplayAgent({ texts: OK_TEXTS }).agent;
    const result = await runDeterministic({
      url: "https://example.test",
      goal: "unused on replay",
      input: INPUT,
      credentials: { username: "u", password: "p" },
      extractSchema: EXTRACT_SCHEMA,
      allowedMethods: READ_ONLY_METHODS,
      timeoutMs: 30_000,
      replayPlan: PLAN,
      trace: TRACE,
    });
    expect(result.mode).toBe("replay");
    expect(result.success).toBe(true);
    expect(EXTRACT_SCHEMA.safeParse(result.data).success).toBe(true);
  });

  it("falls back to learn in the same call when replay fails", async () => {
    // Agent whose readText returns a mismatching name forces escalation,
    // then the learn script answers.
    const base = learnAgent({
      planScript: [{ isDone: true, instruction: "" }],
      observed: { selector: "xpath=//a", description: "x", method: "click", arguments: [] },
      extractResult: {
        matchVerified: true,
        matchedName: "Maria Lopez",
        matchedAddress: "10 Oak Street",
        ntpDateFound: true,
        ntpDate: null,
      },
    });
    sessionAgent.current = {
      ...base,
      readText: async (sel: string) => (sel === "xpath=//h1" ? "Someone Else" : "10 Oak Street"),
    };
    const result = await runDeterministic({
      url: "https://example.test",
      goal: "read the record",
      input: INPUT,
      credentials: { username: "u", password: "p" },
      extractSchema: EXTRACT_SCHEMA,
      allowedMethods: READ_ONLY_METHODS,
      timeoutMs: 30_000,
      replayPlan: PLAN,
      trace: TRACE,
    });
    expect(result.mode).toBe("learned");
    expect(result.replayFailureReason).toMatch(/mismatch/);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/replay.test.ts`
Expected: FAIL, `runDeterministic` is not exported

- [ ] **Step 3: Implement (append to src/replay.ts)**

```typescript
import type { z } from "zod";
import { createSession } from "./browser.js";
import { runLoop } from "./loop.js";
import type { ActionRecord, AgentStatus } from "./types.js";

const REPLAY_DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

export interface TraceDraft {
  steps: TraceStep[];
  readSelectors: Record<string, string>;
  /** True when every plan.reads field grounded to a selector. */
  complete: boolean;
}

export interface DeterministicRunOptions {
  url: string;
  goal: string;
  input: Record<string, string>;
  credentials: Record<string, string>;
  extractSchema?: z.ZodType;
  allowedMethods: readonly string[];
  timeoutMs: number;
  model?: string;
  replayPlan?: ReplayPlan;
  /** When present (and a replayPlan exists), replay is attempted first. */
  trace?: ReplayTrace;
}

export interface DeterministicRunResult {
  mode: "replay" | "learned";
  status: AgentStatus;
  success: boolean;
  data?: unknown;
  actionsLog: ActionRecord[];
  stepsUsed: number;
  sessionId?: string;
  sessionReplayUrl?: string;
  summary: string;
  error?: { message: string };
  /** Recorded on successful learn runs with a replayPlan; null otherwise. */
  traceDraft: TraceDraft | null;
  /** Why replay escalated, when it did. */
  replayFailureReason?: string;
}

/**
 * The gateway's single browser entry point. Replay first when a trace is
 * given; learn (LLM loop) otherwise or on replay failure, recording a trace
 * draft on success. Owns the session and the wall-clock budget.
 */
export async function runDeterministic(
  options: DeterministicRunOptions,
): Promise<DeterministicRunResult> {
  const deadline = Date.now() + options.timeoutMs;
  const env = (process.env.WAA_ENV as "BROWSERBASE" | "LOCAL" | undefined) ?? "BROWSERBASE";
  let agent;
  try {
    agent = await createSession({
      env,
      model: options.model ?? REPLAY_DEFAULT_MODEL,
      sessionTimeoutSeconds: Math.ceil(options.timeoutMs / 1000) + 120,
    });
  } catch (e) {
    return {
      mode: options.trace ? "replay" : "learned",
      status: "error",
      success: false,
      actionsLog: [],
      stepsUsed: 0,
      summary: "Failed to start the browser session.",
      error: { message: e instanceof Error ? e.message : String(e) },
      traceDraft: null,
    };
  }

  const variables = { ...options.input, ...options.credentials };
  let replayFailureReason: string | undefined;

  try {
    // 1. Replay when possible.
    if (options.trace && options.replayPlan) {
      const outcome = await replayTrace({
        agent,
        url: options.url,
        trace: options.trace,
        plan: options.replayPlan,
        input: options.input,
        credentials: options.credentials,
        allowedMethods: options.allowedMethods,
        deadline,
      });
      if (outcome.ok) {
        const parsed = options.extractSchema?.safeParse(outcome.data);
        if (!options.extractSchema || parsed?.success) {
          return {
            mode: "replay",
            status: "completed",
            success: true,
            data: parsed?.success ? parsed.data : outcome.data,
            actionsLog: [],
            stepsUsed: outcome.stepsUsed,
            sessionId: agent.sessionId,
            sessionReplayUrl: agent.sessionReplayUrl,
            summary: `Replayed ${outcome.stepsUsed} step(s) deterministically.`,
            traceDraft: null,
          };
        }
        replayFailureReason = "replay data failed schema validation";
      } else {
        replayFailureReason = outcome.reason;
      }
    }

    // 2. Learn (LLM loop). Reuses the same session; the loop navigates itself.
    const remaining = deadline - Date.now();
    if (remaining < 5_000) {
      return {
        mode: "learned",
        status: "timeout",
        success: false,
        actionsLog: [],
        stepsUsed: 0,
        sessionId: agent.sessionId,
        sessionReplayUrl: agent.sessionReplayUrl,
        summary: "No wall-clock budget left after replay failed.",
        error: { message: replayFailureReason ?? "budget exhausted" },
        traceDraft: null,
        replayFailureReason,
      };
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, remaining);

    let loop;
    try {
      loop = await runLoop({
        agent,
        url: options.url,
        goal: options.goal,
        variables,
        secretValues: Object.values(options.credentials).filter((v) => v.length > 0),
        extractSchema: options.extractSchema,
        allowedMethods: options.allowedMethods,
        maxSteps: 25,
        maxObserveRetries: 2,
        maxConsecutiveFailures: 3,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const status: AgentStatus = timedOut && loop.status === "aborted" ? "timeout" : loop.status;
    const success = status === "completed";

    // 3. Ground read selectors while the record page is still open.
    let traceDraft: TraceDraft | null = null;
    if (success && options.replayPlan) {
      const readSelectors: Record<string, string> = {};
      let complete = true;
      for (const [field, hint] of Object.entries(options.replayPlan.reads)) {
        try {
          const [obs] = await agent.observe(
            `Find ${hint}. Do not interact with it, only locate it.`,
            variables,
          );
          if (obs?.selector) readSelectors[field] = obs.selector;
          else complete = false;
        } catch {
          complete = false;
        }
      }
      traceDraft = {
        steps: parameterizeSteps(loop.actionsLog, options.input),
        readSelectors,
        complete,
      };
    }

    return {
      mode: "learned",
      status,
      success,
      data: loop.extractedData,
      actionsLog: loop.actionsLog,
      stepsUsed: loop.stepsUsed,
      sessionId: agent.sessionId,
      sessionReplayUrl: agent.sessionReplayUrl,
      summary: success
        ? `Goal completed in ${loop.stepsUsed} step(s).`
        : `Stopped with status ${status}.`,
      error: loop.error ? { message: loop.error.message } : undefined,
      traceDraft,
      replayFailureReason,
    };
  } finally {
    await agent.close().catch(() => {});
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/replay.test.ts`
Expected: PASS (25 tests)

- [ ] **Step 5: Run the full core suite**

Run: `npx vitest run test/ --exclude 'test/gateway/**' && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/replay.ts test/replay.test.ts
git commit -m "feat(replay): runDeterministic entry point with replay-first, learn fallback, grounding"
```

---

### Task 7: Catalogue replay plan

**Files:**

- Modify: `src/gateway/catalogue.ts`
- Test: `test/gateway/catalogue.test.ts` (append)

**Interfaces:**

- Consumes: `ReplayPlan` from `src/replay.js`.
- Produces: `CatalogueEntry.replay?: ReplayPlan`, `ResolvedAction.replay?: ReplayPlan` carried through `resolveAction`. The LightReach entry declares its plan.

- [ ] **Step 1: Write the failing test (append to test/gateway/catalogue.test.ts)**

```typescript
import { resolveAction } from "../../src/gateway/catalogue.js";

describe("replay plan", () => {
  it("carries the replay plan through resolveAction for every client", () => {
    const action = resolveAction("lightreach.ntpDate", "spartan");
    expect(action.replay).toBeDefined();
    expect(action.replay!.verify).toEqual({
      matchedName: "name",
      matchedAddress: "address",
    });
    expect(action.replay!.assertTrue).toEqual(["matchVerified", "ntpDateFound"]);
    expect(Object.keys(action.replay!.reads)).toEqual(["matchedName", "matchedAddress", "ntpDate"]);
  });
});
```

Match import style with the file's existing imports (it already imports from the catalogue module; extend that import instead of duplicating it).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/gateway/catalogue.test.ts`
Expected: FAIL, `action.replay` is undefined

- [ ] **Step 3: Implement**

In `src/gateway/catalogue.ts`:

1. Import the type: `import type { ReplayPlan } from "../replay.js";`
2. Add to `CatalogueEntry`:

```typescript
  /**
   * Deterministic replay configuration. Entries without one never replay
   * (every run takes the LLM learn path).
   */
  replay?: ReplayPlan;
```

3. Add to `ResolvedAction`:

```typescript
  replay?: ReplayPlan;
```

4. In `resolveAction`'s returned object add `replay: entry.replay,`.
5. Add to the `lightreach.ntpDate` entry (after `requiresLogin: true,`):

```typescript
    replay: {
      reads: {
        matchedName: "the customer name shown on the open record",
        matchedAddress: "the service address shown on the open record",
        ntpDate:
          'the date next to the "Notice to Proceed" milestone in the Progress Tracker',
      },
      verify: { matchedName: "name", matchedAddress: "address" },
      assertTrue: ["matchVerified", "ntpDateFound"],
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/gateway/catalogue.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/gateway/catalogue.ts test/gateway/catalogue.test.ts
git commit -m "feat(catalogue): per-action replay plan; lightreach entry configured"
```

---

### Task 8: Runner integration, envelope meta, server wiring

**Files:**

- Modify: `src/gateway/runner.ts`
- Modify: `src/gateway/types.ts` (JobMeta)
- Modify: `src/gateway/server.ts`
- Modify: `src/gateway/traces.ts` (switch `StoredStep` to the real `TraceStep` type)
- Test: `test/gateway/runner.test.ts`

**Interfaces:**

- Consumes: `runDeterministic`, `DeterministicRunResult` from `src/replay.js`; `TraceStore` from `./traces.js`.
- Produces: `runJob(jobId, action, rawInput, deps?: RunnerDeps)` where

```typescript
export interface RunnerDeps {
  traces?: TraceStore;
  audit?: (action: string, entity: string, detail?: unknown) => Promise<void>;
}
```

and `JobMeta` gains `mode?: "replay" | "learned" | "healed"` and `traceVersion?: number` (additive).

- [ ] **Step 1: Update JobMeta (src/gateway/types.ts)**

Add after `stepsUsed`:

```typescript
  /** How the run was driven: deterministic replay, LLM learn, or heal. Additive. */
  mode?: "replay" | "learned" | "healed";
  /** Trace version used (replay) or recorded (learned/healed). Additive. */
  traceVersion?: number;
```

- [ ] **Step 2: Align traces.ts with the core type**

In `src/gateway/traces.ts` replace the local `StoredStep` interface with:

```typescript
import type { TraceStep } from "../replay.js";
export type StoredStep = TraceStep;
```

Run: `npm run typecheck` — Expected: PASS.

- [ ] **Step 3: Rewrite the runner tests' mock and add path tests**

`test/gateway/runner.test.ts` currently mocks `../../src/index.js` (`runAgent`). Replace that mock with one for the replay module. Keep every existing test's intent; they exercise the learn path. The mock:

```typescript
const runDeterministicMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/replay.js", () => ({
  runDeterministic: runDeterministicMock,
}));
```

Adapt existing fixtures: where a test previously resolved `runAgent` with `{ success, status, summary, actionsLog, extractedData, sessionReplayUrl, sessionId, stepsUsed, error }`, resolve `runDeterministic` with the same fields plus `mode: "learned"`, `data` instead of `extractedData`, and `traceDraft: null`.

Append new tests:

```typescript
import type { TraceRow, TraceStore } from "../../src/gateway/traces.js";

function fakeTraces(active: TraceRow | null): {
  store: TraceStore;
  calls: { saved: unknown[]; successes: string[] };
} {
  const calls = { saved: [] as unknown[], successes: [] as string[] };
  const store = {
    saveTrace: vi.fn(async (opts: unknown) => {
      calls.saved.push(opts);
      return {
        ...(active ?? ({} as TraceRow)),
        id: "new",
        version: (active?.version ?? 0) + 1,
        state: "active",
      } as TraceRow;
    }),
    getActive: vi.fn(async () => active),
    recordSuccess: vi.fn(async (id: string) => {
      calls.successes.push(id);
    }),
    invalidate: vi.fn(async () => true),
    list: vi.fn(async () => []),
  } as unknown as TraceStore;
  return { store, calls };
}

const ACTIVE_TRACE: TraceRow = {
  id: "trace-1",
  useCase: "lightreach.ntpDate",
  client: "spartan",
  version: 3,
  state: "active",
  steps: [],
  readSelectors: {},
  recordedFromJobId: null,
  healCount: 0,
  lastSuccessAt: null,
  createdAt: new Date().toISOString(),
};

describe("runJob with traces", () => {
  it("uses replay mode metadata on a replay success", async () => {
    runDeterministicMock.mockResolvedValueOnce({
      mode: "replay",
      status: "completed",
      success: true,
      data: {
        matchVerified: true,
        matchedName: "n",
        matchedAddress: "a",
        ntpDateFound: true,
        ntpDate: null,
      },
      actionsLog: [],
      stepsUsed: 5,
      summary: "replayed",
      traceDraft: null,
    });
    const { store, calls } = fakeTraces(ACTIVE_TRACE);
    const envelope = await runJob(
      "job-1",
      resolveAction("lightreach.ntpDate", "spartan"),
      validInput,
      { traces: store },
    );
    expect(envelope.status).toBe("success");
    expect(envelope.meta.mode).toBe("replay");
    expect(envelope.meta.traceVersion).toBe(3);
    expect(calls.successes).toEqual(["trace-1"]);
  });

  it("records a trace after a learn run and reports mode learned", async () => {
    runDeterministicMock.mockResolvedValueOnce({
      mode: "learned",
      status: "completed",
      success: true,
      data: {
        matchVerified: true,
        matchedName: "n",
        matchedAddress: "a",
        ntpDateFound: true,
        ntpDate: "Jul 11, 2026",
      },
      actionsLog: [],
      stepsUsed: 6,
      summary: "learned",
      traceDraft: { steps: [], readSelectors: { matchedName: "xpath=//h1" }, complete: true },
    });
    const { store, calls } = fakeTraces(null);
    const envelope = await runJob(
      "job-2",
      resolveAction("lightreach.ntpDate", "spartan"),
      validInput,
      { traces: store },
    );
    expect(envelope.meta.mode).toBe("learned");
    expect(calls.saved).toHaveLength(1);
    expect((calls.saved[0] as { activate: boolean }).activate).toBe(true);
  });

  it("reports mode healed when replay escalated inside the run", async () => {
    runDeterministicMock.mockResolvedValueOnce({
      mode: "learned",
      status: "completed",
      success: true,
      data: {
        matchVerified: true,
        matchedName: "n",
        matchedAddress: "a",
        ntpDateFound: true,
        ntpDate: null,
      },
      actionsLog: [],
      stepsUsed: 6,
      summary: "healed",
      traceDraft: { steps: [], readSelectors: {}, complete: true },
      replayFailureReason: "verification mismatch on matchedName",
    });
    const { store, calls } = fakeTraces(ACTIVE_TRACE);
    const audit = vi.fn(async () => {});
    const envelope = await runJob(
      "job-3",
      resolveAction("lightreach.ntpDate", "spartan"),
      validInput,
      { traces: store, audit },
    );
    expect(envelope.meta.mode).toBe("healed");
    expect((calls.saved[0] as { healed?: boolean }).healed).toBe(true);
    expect(audit).toHaveBeenCalledWith(
      "trace.healed",
      "lightreach.ntpDate/spartan",
      expect.anything(),
    );
  });

  it("does not save a trace when the draft is incomplete", async () => {
    runDeterministicMock.mockResolvedValueOnce({
      mode: "learned",
      status: "completed",
      success: true,
      data: {
        matchVerified: true,
        matchedName: "n",
        matchedAddress: "a",
        ntpDateFound: true,
        ntpDate: null,
      },
      actionsLog: [],
      stepsUsed: 6,
      summary: "learned",
      traceDraft: { steps: [], readSelectors: {}, complete: false },
    });
    const { store, calls } = fakeTraces(null);
    await runJob("job-4", resolveAction("lightreach.ntpDate", "spartan"), validInput, {
      traces: store,
    });
    expect(calls.saved).toHaveLength(1);
    expect((calls.saved[0] as { activate: boolean }).activate).toBe(false);
  });
});
```

Use the file's existing `validInput` fixture name if one exists; otherwise define `const validInput = { name: "Jane Homeowner", address: "123 Solar Way" };`.

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run test/gateway/runner.test.ts`
Expected: FAIL (runner still imports runAgent; new tests fail)

- [ ] **Step 5: Rewrite the runner**

In `src/gateway/runner.ts`:

1. Replace the `runAgent` import with `import { runDeterministic } from "../replay.js";` and add `import type { TraceStore } from "./traces.js";`.
2. Add the deps interface and extend the signature:

```typescript
export interface RunnerDeps {
  traces?: TraceStore;
  audit?: (action: string, entity: string, detail?: unknown) => Promise<void>;
}

export async function runJob(
  jobId: string,
  action: ResolvedAction,
  rawInput: unknown,
  deps: RunnerDeps = {},
): Promise<JobEnvelope> {
```

3. Extend `base` to accept and pass through `mode` and `traceVersion` into `meta`.
4. Replace section 3 (the `runAgent` call) with:

```typescript
// 3. Deterministic replay when an active trace exists; LLM learn otherwise.
//    Read-only stays code-enforced on both paths (S3).
const timeoutMs = action.timeoutMs ?? RUN_TIMEOUT_MS;
const activeTrace =
  deps.traces && action.replay ? await deps.traces.getActive(action.useCase, action.client) : null;

const result = await runDeterministic({
  url: action.url,
  goal: action.buildGoal(input, { hasOtp: Boolean(credentials.otp) }),
  input,
  credentials,
  extractSchema: action.extractSchema,
  allowedMethods: READ_ONLY_METHODS,
  timeoutMs,
  replayPlan: action.replay,
  trace: activeTrace
    ? { steps: activeTrace.steps, readSelectors: activeTrace.readSelectors }
    : undefined,
});

const mode: NonNullable<JobMeta["mode"]> =
  result.mode === "replay" ? "replay" : result.replayFailureReason ? "healed" : "learned";
let traceVersion = result.mode === "replay" ? activeTrace?.version : undefined;

// 4. Trace bookkeeping (best effort; never fails the job).
if (deps.traces) {
  try {
    if (result.mode === "replay" && result.success && activeTrace) {
      await deps.traces.recordSuccess(activeTrace.id);
    } else if (result.success && result.traceDraft) {
      const saved = await deps.traces.saveTrace({
        useCase: action.useCase,
        client: action.client,
        steps: result.traceDraft.steps,
        readSelectors: result.traceDraft.readSelectors,
        recordedFromJobId: jobId,
        activate: result.traceDraft.complete,
        healed: mode === "healed",
        secretValues: Object.values(credentials).filter((v) => v.length > 0),
      });
      traceVersion = saved.version;
      await deps.audit?.(
        mode === "healed" ? "trace.healed" : "trace.recorded",
        `${action.useCase}/${action.client}`,
        {
          version: saved.version,
          activated: result.traceDraft.complete,
          reason: result.replayFailureReason,
        },
      );
    }
  } catch {
    // Trace persistence is an optimization; the envelope is already decided.
  }
}
```

5. Update the rest of the function: `result.extractedData` becomes `result.data`, `result.sessionReplayUrl` and `result.sessionId` unchanged, and every `base({...})` call gains `mode, traceVersion`. Import `JobMeta` from `./types.js`.

- [ ] **Step 6: Wire the server**

In `src/gateway/server.ts`:

```typescript
import { createTraceStore } from "./traces.js";
```

After the registry is created: `const traces = createTraceStore(pool);`
Change the queue wiring to:

```typescript
    execute: (job) =>
      runJob(job.id, resolveAction(job.useCase, job.client), job.input, {
        traces,
        audit: (a, e, d) => registry.audit("system", a, e, d),
      }),
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run test/gateway/runner.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS (Postgres must be up: `docker compose up -d`)

- [ ] **Step 9: Commit**

```bash
git add src/gateway/runner.ts src/gateway/types.ts src/gateway/server.ts src/gateway/traces.ts test/gateway/runner.test.ts
git commit -m "feat(runner): replay-first job execution with heal and trace bookkeeping"
```

---

### Task 9: Admin API and OpenAPI

**Files:**

- Modify: `src/gateway/api/admin.ts`
- Modify: `src/gateway/api/app.ts` (AdminDeps plumbing, if deps flow through it)
- Modify: `src/gateway/api/openapi.ts`
- Modify: `src/gateway/server.ts` (pass `traces` into `buildApp`)
- Test: `test/gateway/api.test.ts` (append)

**Interfaces:**

- Consumes: `TraceStore` from `../traces.js`.
- Produces: `GET /admin/traces?useCase=` returning `{ traces: TraceSummary[] }` where `TraceSummary = { useCase, client, version, state, healCount, stepCount, lastSuccessAt, createdAt }`; `POST /admin/traces/:useCase/:client/invalidate` returning `{ ok: true }` or 404 `{ error: "no active trace" }`. `AdminDeps` gains `traces: TraceStore`.

- [ ] **Step 1: Write the failing tests (append to test/gateway/api.test.ts)**

Follow the file's existing pattern for building the app and an admin token. Append:

```typescript
describe("admin traces", () => {
  it("lists trace summaries without exposing steps", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/traces?useCase=lightreach.ntpDate",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { traces: Array<Record<string, unknown>> };
    for (const t of body.traces) {
      expect(t).not.toHaveProperty("steps");
      expect(t).toHaveProperty("stepCount");
      expect(t).toHaveProperty("healCount");
    }
  });

  it("invalidates the active trace and 404s when none exists", async () => {
    // Seed one active trace directly through the store used by the app.
    await traces.saveTrace({
      useCase: "lightreach.ntpDate",
      client: "spartan",
      steps: [],
      readSelectors: {},
      activate: true,
      secretValues: [],
    });
    const ok = await app.inject({
      method: "POST",
      url: "/admin/traces/lightreach.ntpDate/spartan/invalidate",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(ok.statusCode).toBe(200);
    const again = await app.inject({
      method: "POST",
      url: "/admin/traces/lightreach.ntpDate/spartan/invalidate",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(again.statusCode).toBe(404);
  });

  it("requires admin", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/traces" });
    expect([401, 403]).toContain(res.statusCode);
  });
});
```

Where the test file builds the app (`buildApp({...})`), create `const traces = createTraceStore(db.pool);` and pass it in; export it from the setup scope so the seeding call above compiles.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/gateway/api.test.ts`
Expected: FAIL (buildApp does not accept traces; routes missing)

- [ ] **Step 3: Implement routes**

In `src/gateway/api/admin.ts`, add `traces: TraceStore` to `AdminDeps` (import `type { TraceStore, TraceRow } from "../traces.js"`). Inside `registerAdminRoutes`'s admin scope add:

```typescript
const summary = (t: TraceRow) => ({
  useCase: t.useCase,
  client: t.client,
  version: t.version,
  state: t.state,
  healCount: t.healCount,
  stepCount: t.steps.length,
  lastSuccessAt: t.lastSuccessAt,
  createdAt: t.createdAt,
});

admin.get("/traces", async (req) => {
  const { useCase } = req.query as { useCase?: string };
  const rows = await deps.traces.list(useCase);
  return { traces: rows.map(summary) };
});

admin.post("/traces/:useCase/:client/invalidate", async (req, reply) => {
  const { useCase, client } = req.params as { useCase: string; client: string };
  const ok = await deps.traces.invalidate(useCase, client);
  if (!ok) return reply.code(404).send({ error: "no active trace" });
  await deps.registry.audit("admin", "trace.invalidated", `${useCase}/${client}`);
  return { ok: true };
});
```

Thread `traces` through `buildApp` in `src/gateway/api/app.ts` (mirror how `registry` flows) and pass it from `src/gateway/server.ts` (`buildApp({ store, auth, logger, registry, canary, traces })`).

- [ ] **Step 4: Update OpenAPI**

In `src/gateway/api/openapi.ts`, next to the existing `"/admin"` path entries (around line 150), add, following the file's exact object style:

```typescript
      "/admin/traces": {
        get: {
          summary: "List replay trace summaries (admin)",
          parameters: [
            { name: "useCase", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: { "200": { description: "Trace summaries" } },
        },
      },
      "/admin/traces/{useCase}/{client}/invalidate": {
        post: {
          summary: "Retire the active replay trace; the next job relearns (admin)",
          parameters: [
            { name: "useCase", in: "path", required: true, schema: { type: "string" } },
            { name: "client", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "Invalidated" },
            "404": { description: "No active trace" },
          },
        },
      },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/gateway/api.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/gateway/api/ src/gateway/server.ts test/gateway/api.test.ts
git commit -m "feat(admin): trace summaries and invalidate endpoint; openapi in sync"
```

---

### Task 10: Console traces panel

**Files:**

- Modify: `admin-web/src/api/client.ts`
- Modify: `admin-web/src/api/types.ts`
- Modify: `admin-web/src/views/Catalogue.tsx`

**Interfaces:**

- Consumes: the two admin endpoints from Task 9.
- Produces: `api.traces(useCase?)` and `api.invalidateTrace(useCase, client)` on the client; a traces section rendered inside the Catalogue view's per-action detail.

- [ ] **Step 1: Add types**

In `admin-web/src/api/types.ts`:

```typescript
export interface TraceSummary {
  useCase: string;
  client: string;
  version: number;
  state: "active" | "retired";
  healCount: number;
  stepCount: number;
  lastSuccessAt: string | null;
  createdAt: string;
}
```

- [ ] **Step 2: Add client functions**

In `admin-web/src/api/client.ts`, inside the object returned by `makeApi`, following its existing method style:

```typescript
    traces: (useCase?: string) =>
      apiFetch<{ traces: TraceSummary[] }>(config, `/admin/traces${q({ useCase })}`),
    invalidateTrace: (useCase: string, client: string) =>
      apiFetch<{ ok: boolean }>(
        config,
        `/admin/traces/${encodeURIComponent(useCase)}/${encodeURIComponent(client)}/invalidate`,
        { method: "POST" },
      ),
```

Import `TraceSummary` from `./types.js` at the top.

- [ ] **Step 3: Render the panel**

Read `admin-web/src/views/Catalogue.tsx` first and match its data-loading and styling conventions exactly (it loads via the `makeApi` client from context and renders cards per action). Add a `TracesSection` component in the same file and render it inside the expanded/detail area of each action:

```tsx
function TracesSection({ useCase }: { useCase: string }) {
  const { api } = useGateway(); // match the file's actual context hook name
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .traces(useCase)
      .then((r) => setTraces(r.traces))
      .catch(() => setTraces([]));
  }, [api, useCase]);
  useEffect(load, [load]);

  const invalidate = async (client: string) => {
    setBusy(true);
    try {
      await api.invalidateTrace(useCase, client);
      load();
    } finally {
      setBusy(false);
    }
  };

  const active = traces.filter((t) => t.state === "active");
  return (
    <div className="traces">
      <h4>Replay traces</h4>
      {active.length === 0 && <p className="muted">No active trace. Next run learns via LLM.</p>}
      {active.map((t) => (
        <div key={`${t.client}-${t.version}`} className="trace-row">
          <span>
            {t.client}: v{t.version}, {t.stepCount} steps, {t.healCount} heal(s), last success{" "}
            {t.lastSuccessAt ?? "never"}
          </span>
          <button disabled={busy} onClick={() => invalidate(t.client)}>
            Invalidate
          </button>
        </div>
      ))}
    </div>
  );
}
```

Adjust hook and class names to the file's actual conventions when reading it; the component logic above is complete.

- [ ] **Step 4: Verify the console builds**

Run: `cd admin-web && npm run build && cd ..`
Expected: build succeeds

- [ ] **Step 5: Commit**

```bash
git add admin-web/src
git commit -m "feat(con): replay traces panel with invalidate on the catalogue view"
```

---

### Task 11: Docs sync, coverage, and final verification

**Files:**

- Modify: `AGENTS.md`
- Modify: `CLAUDE.md` (repo root of BrowserGateway-v2)
- Modify: `docs/superpowers/specs/2026-07-14-deterministic-replay-design.md` (status line)

- [ ] **Step 1: Update AGENTS.md**

Add to the locked decisions/sanctioned changes list: sanctioned change 5 (adapter `readText`, new `src/replay.ts`), with one sentence of rationale (unit economics at thousands of runs per day). Add `src/replay.ts`, `src/gateway/traces.ts`, the `action_traces` table, the two admin endpoints, and the `meta.mode`/`meta.traceVersion` additive envelope fields to the module map and API description. Describe the three run paths (replay, learn, heal) in two or three sentences.

- [ ] **Step 2: Update CLAUDE.md**

In "Where the code stands right now", add one sentence: deterministic replay is built (traces recorded per useCase and client, replayed with zero LLM calls, healed on portal drift). Update the sanctioned-changes sentence from four to five.

- [ ] **Step 3: Mark the spec implemented**

Change the spec's `Status:` line to `implemented 2026-07-14`.

- [ ] **Step 4: Full verification**

Run: `npm run typecheck && npm test`
Expected: all green; coverage on `src/gateway` >= 80 percent (the vitest coverage gate enforces this).

Run: `docker compose up -d && npm run gateway` in one shell, then in another:
`curl -s http://127.0.0.1:8080/openapi.json | python3 -c "import json,sys; d=json.load(sys.stdin); print('/admin/traces' in d['paths'])"`
Expected: `True`

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md CLAUDE.md docs/superpowers/specs/2026-07-14-deterministic-replay-design.md
git commit -m "docs: record sanctioned change 5 and the replay surface in AGENTS.md and CLAUDE.md"
```

---

## Deferred (needs live credentials; not automatable here)

Live acceptance per the spec: one learn run on `lightreach.ntpDate` for `spartan` records a trace; the next run replays with zero LLM calls (verify `meta.mode === "replay"` and no Anthropic usage during the run); `POST /admin/traces/lightreach.ntpDate/spartan/invalidate` forces the next run to learn. Execute this the next time live runs are exercised, before enabling replay-backed traffic for callers.
