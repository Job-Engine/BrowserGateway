# Autonomous Web Action Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TypeScript library `runAgent({ url, goal, data })` that drives a Browserbase cloud browser via Stagehand v3 to accomplish natural-language goals on arbitrary sites, pausing for human confirmation before risky actions.

**Architecture:** An owned ReAct-style control loop built on Stagehand's `observe`/`act`/`extract` primitives (Stagehand's `agent()` cannot gate individual actions). The loop depends on a small `BrowserAgent` port so its logic is unit-tested against a fake adapter, while a real Stagehand-backed adapter is exercised by a local-browser integration test. Secrets flow through Stagehand `variables` and never reach the LLM.

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥20, `@browserbasehq/stagehand` v3, `zod` v4, `vitest`, `tsx`.

## Global Constraints

- **Module system:** ESM + NodeNext. `package.json` has `"type": "module"`. Every local import MUST use a `.js` extension (e.g. `import { classifyRisk } from "./risk.js"`). Applies verbatim to every task.
- **Stagehand AI methods are on the INSTANCE:** `stagehand.act(...)`, `stagehand.observe(...)`, `stagehand.extract(...)`. The `page` object (`stagehand.context.pages()[0]`) is a plain page used ONLY for `page.goto(url)`.
- **Exact Stagehand types (verified against `@browserbasehq/stagehand@3.6.0` `.d.ts`):**
  - `import { Stagehand } from "@browserbasehq/stagehand"` (the `V3` class, exported as `Stagehand`).
  - `new Stagehand(opts: V3Options)` where `V3Options` has top-level `env`, `apiKey?`, `projectId?`, `model?`, `browserbaseSessionCreateParams?`, `browserbaseSessionID?`, `localBrowserLaunchOptions?`, `selfHeal?`, `verbose?`, `logger?`.
  - `await stagehand.init()`.
  - `stagehand.observe(instruction: string, options?: { variables?, timeout?, ... }): Promise<Action[]>` where `Action = { selector: string; description: string; method?: string; arguments?: string[] }`.
  - `stagehand.act(action: Action, options?: { variables? }): Promise<ActResult>` where `ActResult = { success: boolean; message: string; actionDescription: string; actions: Action[] }`.
  - `stagehand.extract<T extends ZodSchema>(instruction: string, schema: T, options?): Promise<z.infer<T>>`.
  - Getters: `stagehand.browserbaseSessionURL: string | undefined`, `stagehand.browserbaseSessionID: string | undefined`.
  - `browserbaseSessionCreateParams.browserSettings.context = { id: string; persist?: boolean }`.
  - `await stagehand.close()`.
- **Default model constant:** `DEFAULT_MODEL = "anthropic/claude-sonnet-4-6"` (a valid CUA/agent model per `AVAILABLE_CUA_MODELS`). Never hard-code elsewhere.
- **Secrets:** credential values are passed to `observe`/`act` via the `variables` map and are redacted from all `ActionRecord`s and `AgentEvent`s. The planner is told only variable NAMES, never values.
- **Fail-closed safety:** when `onBeforeAction` is not supplied, a risky action is blocked and the run ends with `status: "blocked"`. A rejected risky action aborts the run with `status: "blocked"`.
- **`runAgent` never throws for operational failures** (returns `status: "error"`); it throws synchronously only for invalid options.
- **Package.json and runtime deps already exist** (committed): `@browserbasehq/stagehand@^3.6.0`, `zod@^4`. `"type": "module"` and the `scripts` block are present.

---

### Task 1: Project scaffolding

**Files:**
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `src/.gitkeep`, `test/.gitkeep`
- Create: `README.md`

**Interfaces:**
- Consumes: existing `package.json` (deps `@browserbasehq/stagehand`, `zod`; scripts `build`/`typecheck`/`test`/`agent`).
- Produces: a compiling, testable workspace. `npm run typecheck` and `npm test` succeed.

- [ ] **Step 1: Install dev dependencies**

Run:
```bash
npm install -D typescript vitest tsx @types/node
```
Expected: packages added, no errors.

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "declaration": true,
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src", "test"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
```

- [ ] **Step 4: Create `.env.example`**

```bash
# Browserbase (required for env=BROWSERBASE, the default)
BROWSERBASE_API_KEY=
BROWSERBASE_PROJECT_ID=

# LLM provider key. Either set ANTHROPIC_API_KEY and use "anthropic/..." models,
# OR omit it and use a "gateway/anthropic/..." model to bill the LLM through Browserbase.
ANTHROPIC_API_KEY=

# Optional: override the browser environment. "BROWSERBASE" (default) or "LOCAL".
# LOCAL runs Chromium on your machine and requires: npx playwright install chromium
WAA_ENV=BROWSERBASE
```

- [ ] **Step 5: Create placeholder dirs and README**

`src/.gitkeep` and `test/.gitkeep`: empty files.

`README.md`:
```markdown
# web-action-agent

Autonomous web action agent. Given a URL and a natural-language goal, it drives a
Browserbase cloud browser (via Stagehand v3) to fill forms and take actions on
arbitrary sites, pausing for human confirmation before risky/irreversible actions.

## Usage

```ts
import { runAgent, autoApprove } from "web-action-agent";

const result = await runAgent({
  url: "https://example.com/apply",
  goal: "Complete and submit the job application",
  data: { firstName: "Ada", email: "ada@example.com" },
  onBeforeAction: async (action) => {
    console.log("About to:", action.description);
    return true; // approve
  },
});
console.log(result.status, result.summary);
```

See `docs/superpowers/specs/` for the design and `.env.example` for configuration.
```

- [ ] **Step 6: Verify typecheck and tests run**

Run: `npm run typecheck && npm test`
Expected: typecheck passes with no errors; vitest reports "no tests" and exits 0 (passWithNoTests).

- [ ] **Step 7: Commit**

```bash
git add tsconfig.json vitest.config.ts .env.example src/.gitkeep test/.gitkeep README.md package.json package-lock.json
git commit -m "chore: scaffold typescript/vitest workspace"
```

---

### Task 2: Shared types and the BrowserAgent port

**Files:**
- Create: `src/types.ts`

**Interfaces:**
- Produces: `RunAgentOptions`, `AgentRunResult`, `ProposedAction`, `ObservedAction`, `ActOutcome`, `RiskAssessment`, `RiskLevel`, `ActionRecord`, `AgentStatus`, `AgentEvent`, `ConfirmFn`, `BrowserAgent`. All later tasks consume these.

- [ ] **Step 1: Write `src/types.ts`**

```ts
import type { z } from "zod";

/** A candidate action grounded on the page (mirrors Stagehand's Action). */
export interface ObservedAction {
  selector: string;
  description: string;
  method?: string;
  arguments?: string[];
}

/** An ObservedAction plus the planner instruction that produced it. Secrets are redacted. */
export interface ProposedAction extends ObservedAction {
  instruction: string;
}

export type RiskLevel = "safe" | "risky";
export interface RiskAssessment {
  level: RiskLevel;
  reason: string;
}

export interface ActOutcome {
  success: boolean;
  message: string;
}

export interface ActionRecord {
  step: number;
  action: ProposedAction;
  risk: RiskAssessment;
  decision: "auto" | "approved" | "rejected";
  outcome: "executed" | "blocked" | "failed";
  message?: string;
}

export type AgentStatus =
  | "completed"
  | "blocked"
  | "aborted"
  | "max_steps"
  | "error";

export type AgentEvent =
  | { type: "step_start"; step: number }
  | { type: "planned"; step: number; instruction: string; isDone: boolean }
  | { type: "observed"; step: number; action: ProposedAction | null }
  | { type: "risk"; step: number; assessment: RiskAssessment }
  | { type: "decision"; step: number; decision: ActionRecord["decision"] }
  | { type: "acted"; step: number; outcome: ActionRecord["outcome"]; message?: string }
  | { type: "done"; status: AgentStatus };

export type ConfirmFn = (
  action: ProposedAction,
) => boolean | Promise<boolean>;

export interface RunAgentOptions {
  url: string;
  goal: string;
  data?: Record<string, string>;
  credentials?: Record<string, string>;
  onBeforeAction?: ConfirmFn;
  classifyRisk?: (action: ProposedAction) => RiskAssessment;
  extractSchema?: z.ZodType;
  model?: string;
  maxSteps?: number;
  context?: { id: string; persist?: boolean };
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentRunResult {
  success: boolean;
  status: AgentStatus;
  summary: string;
  actionsLog: ActionRecord[];
  extractedData?: unknown;
  sessionReplayUrl?: string;
  stepsUsed: number;
  error?: { message: string; step?: number };
}

/**
 * The browser capabilities the control loop needs. Implemented for real by
 * `createSession()` (Stagehand-backed) and by fakes in tests.
 */
export interface BrowserAgent {
  readonly sessionReplayUrl?: string;
  goto(url: string): Promise<void>;
  observe(
    instruction: string,
    variables?: Record<string, string>,
  ): Promise<ObservedAction[]>;
  act(
    action: ObservedAction,
    variables?: Record<string, string>,
  ): Promise<ActOutcome>;
  extract<T>(instruction: string, schema: z.ZodType<T>): Promise<T>;
  close(): Promise<void>;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: shared types and BrowserAgent port"
```

---

### Task 3: Risk classification (pure, TDD)

**Files:**
- Create: `test/risk.test.ts`
- Create: `src/risk.ts`

**Interfaces:**
- Consumes: `ProposedAction`, `RiskAssessment` from `./types.js`.
- Produces: `classifyRisk(action: { description?: string; method?: string; instruction?: string }, config?: RiskConfig): RiskAssessment` and `DEFAULT_RISKY_KEYWORDS: readonly string[]`.

- [ ] **Step 1: Write the failing test — `test/risk.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { classifyRisk, DEFAULT_RISKY_KEYWORDS } from "../src/risk.js";

describe("classifyRisk", () => {
  it("flags a submit action as risky", () => {
    const r = classifyRisk({ description: "Click the Submit button", method: "click" });
    expect(r.level).toBe("risky");
    expect(r.reason).toContain("submit");
  });

  it("flags payment/delete/post via keywords", () => {
    for (const desc of ["Pay now", "Delete account", "Publish post"]) {
      expect(classifyRisk({ description: desc }).level).toBe("risky");
    }
  });

  it("flags a risky signal even when it is the only token", () => {
    expect(classifyRisk({ description: "Submit" }).level).toBe("risky");
    expect(classifyRisk({ method: "submit" }).level).toBe("risky");
  });

  it("treats benign fills and clicks as safe", () => {
    expect(classifyRisk({ description: "Type into the First name field", method: "fill" }).level).toBe("safe");
    expect(classifyRisk({ description: "Click the Next tab", method: "click" }).level).toBe("safe");
  });

  it("matches keywords found only in the instruction", () => {
    expect(classifyRisk({ description: "Click element", instruction: "submit the application" }).level).toBe("risky");
  });

  it("honors a custom keyword list that replaces the defaults", () => {
    // "submit" is a default keyword but is NOT in the custom list -> safe
    expect(classifyRisk({ description: "submit the form" }, { keywords: ["frobnicate"] }).level).toBe("safe");
    // the custom keyword matches -> risky
    expect(classifyRisk({ description: "frobnicate the widget" }, { keywords: ["frobnicate"] }).level).toBe("risky");
    expect(DEFAULT_RISKY_KEYWORDS.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/risk.test.ts`
Expected: FAIL — cannot find module `../src/risk.js`.

- [ ] **Step 3: Write `src/risk.ts`**

```ts
import type { RiskAssessment } from "./types.js";

export const DEFAULT_RISKY_KEYWORDS = [
  "submit", "send", "pay", "purchase", "checkout", "buy", "order",
  "delete", "remove", "post", "publish", "confirm", "apply", "sign",
  "agree", "accept", "transfer", "book", "reserve",
] as const;

export interface RiskConfig {
  keywords?: readonly string[];
}

type ActionLike = {
  description?: string;
  method?: string;
  instruction?: string;
};

export function classifyRisk(
  action: ActionLike,
  config: RiskConfig = {},
): RiskAssessment {
  const keywords = config.keywords ?? DEFAULT_RISKY_KEYWORDS;
  const haystack = [action.description, action.method, action.instruction]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const hit = keywords.find((k) => haystack.includes(k.toLowerCase()));
  return hit
    ? { level: "risky", reason: `matched risky keyword "${hit}"` }
    : { level: "safe", reason: "no risky signal detected" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/risk.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/risk.ts test/risk.test.ts
git commit -m "feat: risk classification heuristic"
```

---

### Task 4: Planner (TDD with mocked extract)

**Files:**
- Create: `test/planner.test.ts`
- Create: `src/planner.ts`

**Interfaces:**
- Consumes: `ActionRecord` from `./types.js`; `zod`.
- Produces:
  - `planStepSchema` (Zod) and `type PlanStep = { reasoning: string; isDone: boolean; instruction: string }`.
  - `type ExtractFn = <T>(instruction: string, schema: z.ZodType<T>) => Promise<T>`.
  - `interface PlanContext = { goal: string; variableNames: string[]; history: ActionRecord[] }`.
  - `buildPlanPrompt(ctx: PlanContext): string` (pure).
  - `planNextStep(extract: ExtractFn, ctx: PlanContext): Promise<PlanStep>`.

- [ ] **Step 1: Write the failing test — `test/planner.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { buildPlanPrompt, planNextStep, planStepSchema } from "../src/planner.js";
import type { ActionRecord } from "../src/types.js";

const record: ActionRecord = {
  step: 1,
  action: { selector: "x", description: "Typed the email", instruction: "type %email%" },
  risk: { level: "safe", reason: "" },
  decision: "auto",
  outcome: "executed",
};

describe("buildPlanPrompt", () => {
  it("includes the goal, placeholder names, and history", () => {
    const p = buildPlanPrompt({ goal: "Apply for the job", variableNames: ["email", "password"], history: [record] });
    expect(p).toContain("Apply for the job");
    expect(p).toContain("%email%");
    expect(p).toContain("%password%");
    expect(p).toContain("Typed the email");
  });

  it("notes when there is no history", () => {
    const p = buildPlanPrompt({ goal: "g", variableNames: [], history: [] });
    expect(p.toLowerCase()).toContain("no actions taken yet");
  });
});

describe("planNextStep", () => {
  it("calls extract with the plan schema and returns the parsed step", async () => {
    const extract = vi.fn().mockResolvedValue({ reasoning: "r", isDone: false, instruction: "click Next" });
    const step = await planNextStep(extract, { goal: "g", variableNames: [], history: [] });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0][1]).toBe(planStepSchema);
    expect(step.instruction).toBe("click Next");
    expect(step.isDone).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/planner.test.ts`
Expected: FAIL — cannot find module `../src/planner.js`.

- [ ] **Step 3: Write `src/planner.ts`**

```ts
import { z } from "zod";
import type { ActionRecord } from "./types.js";

export const planStepSchema = z.object({
  reasoning: z.string(),
  isDone: z.boolean(),
  instruction: z.string(),
});

export type PlanStep = z.infer<typeof planStepSchema>;

export type ExtractFn = <T>(
  instruction: string,
  schema: z.ZodType<T>,
) => Promise<T>;

export interface PlanContext {
  goal: string;
  variableNames: string[];
  history: ActionRecord[];
}

export function buildPlanPrompt(ctx: PlanContext): string {
  const historyLines = ctx.history.length
    ? ctx.history
        .map(
          (h, i) =>
            `${i + 1}. [${h.outcome}] ${h.action.description}${
              h.message ? ` — ${h.message}` : ""
            }`,
        )
        .join("\n")
    : "(no actions taken yet)";
  const vars = ctx.variableNames.length
    ? ctx.variableNames.map((n) => `%${n}%`).join(", ")
    : "(none)";
  return [
    "You are a web automation planner. Looking at the CURRENT page, decide the SINGLE next UI action that makes progress toward the goal, or report that the goal is already complete.",
    "",
    `GOAL: ${ctx.goal}`,
    "",
    `Values you may use, referenced ONLY by placeholder token (never write their literal values): ${vars}`,
    "",
    "Actions already taken:",
    historyLines,
    "",
    "Respond with:",
    "- reasoning: a brief justification grounded in what is visible on the page.",
    "- isDone: true ONLY if the goal is fully accomplished; otherwise false.",
    '- instruction: one concrete imperative UI action for the next step (e.g. \'click the "Next" button\', \'type %email% into the Email field\'). Use an empty string if isDone is true.',
  ].join("\n");
}

export async function planNextStep(
  extract: ExtractFn,
  ctx: PlanContext,
): Promise<PlanStep> {
  return extract(buildPlanPrompt(ctx), planStepSchema);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/planner.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/planner.ts test/planner.test.ts
git commit -m "feat: LLM planner (plan prompt + next-step)"
```

---

### Task 5: Control loop (TDD against a fake BrowserAgent)

**Files:**
- Create: `test/loop.test.ts`
- Create: `src/loop.ts`

**Interfaces:**
- Consumes: `BrowserAgent`, `ActionRecord`, `AgentEvent`, `AgentStatus`, `ProposedAction`, `ObservedAction`, `ConfirmFn`, `RiskAssessment` from `./types.js`; `classifyRisk` from `./risk.js`; `planNextStep`, `ExtractFn` from `./planner.js`; `zod`.
- Produces:
  - `interface LoopParams` (see code).
  - `interface LoopResult = { status: AgentStatus; actionsLog: ActionRecord[]; extractedData?: unknown; stepsUsed: number; error?: { message: string; step?: number } }`.
  - `runLoop(params: LoopParams): Promise<LoopResult>`.

- [ ] **Step 1: Write the failing test — `test/loop.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { runLoop } from "../src/loop.js";
import type { BrowserAgent, ObservedAction, ConfirmFn } from "../src/types.js";
import type { PlanStep } from "../src/planner.js";

/**
 * Fake BrowserAgent driven by scripted extract() responses. The planner uses
 * extract(prompt, planStepSchema); we detect that call by the presence of an
 * "isDone" key in the schema shape and return the next scripted plan step.
 */
function makeFakeAgent(opts: {
  plans: PlanStep[];
  observe?: (instruction: string) => ObservedAction[];
  actSuccess?: boolean;
  finalExtract?: unknown;
}): { agent: BrowserAgent; acted: ObservedAction[] } {
  const plans = [...opts.plans];
  const acted: ObservedAction[] = [];
  const agent: BrowserAgent = {
    sessionReplayUrl: "https://browserbase.test/session/abc",
    goto: vi.fn(async () => {}),
    observe: vi.fn(async (instruction: string) =>
      opts.observe
        ? opts.observe(instruction)
        : [{ selector: "xpath=/x", description: instruction, method: "click", arguments: [] }],
    ),
    act: vi.fn(async (action: ObservedAction) => {
      acted.push(action);
      return { success: opts.actSuccess ?? true, message: "ok" };
    }),
    extract: vi.fn(async (_instruction: string, schema: z.ZodType) => {
      const shape = (schema as any)?.shape ?? {};
      if ("isDone" in shape) {
        return plans.shift() ?? { reasoning: "done", isDone: true, instruction: "" };
      }
      return opts.finalExtract;
    }),
    close: vi.fn(async () => {}),
  };
  return { agent, acted };
}

// `PlanStep` is the return type of the planner; the fake's extract() returns
// scripted PlanSteps for planner calls and `finalExtract` for the final extraction.

const base = {
  url: "https://example.com",
  goal: "do the thing",
  variables: {} as Record<string, string>,
  secretValues: [] as string[],
  maxSteps: 25,
  maxObserveRetries: 2,
  maxConsecutiveFailures: 3,
};

describe("runLoop", () => {
  it("completes when the planner reports isDone, taking safe actions along the way", async () => {
    const { agent, acted } = makeFakeAgent({
      plans: [
        { reasoning: "", isDone: false, instruction: "type into the name field" },
        { reasoning: "", isDone: true, instruction: "" },
      ],
    });
    const res = await runLoop({ ...base, agent });
    expect(res.status).toBe("completed");
    expect(acted).toHaveLength(1);
    expect(res.actionsLog[0].decision).toBe("auto");
    expect(res.actionsLog[0].outcome).toBe("executed");
  });

  it("blocks a risky action when no onBeforeAction hook is supplied (fail-closed)", async () => {
    const { agent, acted } = makeFakeAgent({
      plans: [{ reasoning: "", isDone: false, instruction: "submit the form" }],
      observe: () => [{ selector: "x", description: "Click the Submit button", method: "click" }],
    });
    const res = await runLoop({ ...base, agent });
    expect(res.status).toBe("blocked");
    expect(acted).toHaveLength(0);
    expect(res.actionsLog.at(-1)?.outcome).toBe("blocked");
  });

  it("executes a risky action when the hook approves, then completes", async () => {
    const approve: ConfirmFn = vi.fn(async () => true);
    const { agent, acted } = makeFakeAgent({
      plans: [
        { reasoning: "", isDone: false, instruction: "submit the form" },
        { reasoning: "", isDone: true, instruction: "" },
      ],
      observe: () => [{ selector: "x", description: "Click the Submit button", method: "click" }],
    });
    const res = await runLoop({ ...base, agent, onBeforeAction: approve });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(res.status).toBe("completed");
    expect(acted).toHaveLength(1);
    expect(res.actionsLog[0].decision).toBe("approved");
  });

  it("aborts with status blocked when the hook rejects a risky action", async () => {
    const { agent, acted } = makeFakeAgent({
      plans: [{ reasoning: "", isDone: false, instruction: "submit the form" }],
      observe: () => [{ selector: "x", description: "Click the Submit button", method: "click" }],
    });
    const res = await runLoop({ ...base, agent, onBeforeAction: async () => false });
    expect(res.status).toBe("blocked");
    expect(acted).toHaveLength(0);
    expect(res.actionsLog.at(-1)?.decision).toBe("rejected");
  });

  it("stops with max_steps when the goal never completes", async () => {
    const plans: PlanStep[] = Array.from({ length: 10 }, () => ({ reasoning: "", isDone: false, instruction: "click next" }));
    const { agent } = makeFakeAgent({ plans });
    const res = await runLoop({ ...base, agent, maxSteps: 3 });
    expect(res.status).toBe("max_steps");
    expect(res.stepsUsed).toBe(3);
  });

  it("returns aborted when the signal is already aborted", async () => {
    const { agent } = makeFakeAgent({ plans: [{ reasoning: "", isDone: false, instruction: "x" }] });
    const res = await runLoop({ ...base, agent, signal: AbortSignal.abort() });
    expect(res.status).toBe("aborted");
  });

  it("redacts secret values from the actions log", async () => {
    const { agent } = makeFakeAgent({
      plans: [
        { reasoning: "", isDone: false, instruction: "type the password" },
        { reasoning: "", isDone: true, instruction: "" },
      ],
      observe: () => [{ selector: "x", description: "Fill password with hunter2", method: "fill", arguments: ["hunter2"] }],
    });
    const res = await runLoop({ ...base, agent, variables: { password: "hunter2" }, secretValues: ["hunter2"] });
    const dump = JSON.stringify(res.actionsLog);
    expect(dump).not.toContain("hunter2");
    expect(dump).toContain("***");
  });

  it("runs the final extraction when an extractSchema is provided", async () => {
    const { agent } = makeFakeAgent({
      plans: [{ reasoning: "", isDone: true, instruction: "" }],
      finalExtract: { confirmation: "ABC123" },
    });
    const res = await runLoop({ ...base, agent, extractSchema: z.object({ confirmation: z.string() }) });
    expect(res.extractedData).toEqual({ confirmation: "ABC123" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/loop.test.ts`
Expected: FAIL — cannot find module `../src/loop.js`.

- [ ] **Step 3: Write `src/loop.ts`**

```ts
import type { z } from "zod";
import type {
  ActionRecord,
  AgentEvent,
  AgentStatus,
  BrowserAgent,
  ConfirmFn,
  ObservedAction,
  ProposedAction,
  RiskAssessment,
} from "./types.js";
import { classifyRisk } from "./risk.js";
import { planNextStep, type ExtractFn } from "./planner.js";

export interface LoopParams {
  agent: BrowserAgent;
  url: string;
  goal: string;
  variables: Record<string, string>;
  secretValues: string[];
  onBeforeAction?: ConfirmFn;
  classifyRiskFn?: (action: ProposedAction) => RiskAssessment;
  extractSchema?: z.ZodType;
  maxSteps: number;
  maxObserveRetries: number;
  maxConsecutiveFailures: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface LoopResult {
  status: AgentStatus;
  actionsLog: ActionRecord[];
  extractedData?: unknown;
  stepsUsed: number;
  error?: { message: string; step?: number };
}

function redact(text: string | undefined, secrets: string[]): string | undefined {
  if (!text) return text;
  let out = text;
  for (const s of secrets) {
    if (s) out = out.split(s).join("***");
  }
  return out;
}

function toProposed(
  observed: ObservedAction,
  instruction: string,
  secrets: string[],
): ProposedAction {
  return {
    selector: observed.selector,
    description: redact(observed.description, secrets) ?? observed.description,
    method: observed.method,
    arguments: observed.arguments?.map((a) => redact(a, secrets) ?? a),
    instruction: redact(instruction, secrets) ?? instruction,
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runLoop(params: LoopParams): Promise<LoopResult> {
  const {
    agent,
    goal,
    variables,
    secretValues,
    maxSteps,
    maxObserveRetries,
    maxConsecutiveFailures,
    signal,
  } = params;

  const emit = (e: AgentEvent) => params.onEvent?.(e);
  const classify = params.classifyRiskFn ?? ((a: ProposedAction) => classifyRisk(a));
  const extract: ExtractFn = (instruction, schema) => agent.extract(instruction, schema);
  const variableNames = Object.keys(variables);
  const actionsLog: ActionRecord[] = [];
  let consecutiveFailures = 0;

  const finalize = async (status: AgentStatus, error?: LoopResult["error"]): Promise<LoopResult> => {
    let extractedData: unknown;
    if (
      params.extractSchema &&
      (status === "completed" || status === "blocked" || status === "max_steps")
    ) {
      try {
        extractedData = await agent.extract(
          `From the current page, extract the data relevant to this goal: ${goal}`,
          params.extractSchema,
        );
      } catch {
        extractedData = undefined;
      }
    }
    emit({ type: "done", status });
    return { status, actionsLog, extractedData, stepsUsed: actionsLog.length, error };
  };

  try {
    await agent.goto(params.url);
  } catch (e) {
    return finalize("error", { message: `navigation failed: ${errMsg(e)}` });
  }

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) return finalize("aborted");
    emit({ type: "step_start", step });

    // 1. Plan
    let plan;
    try {
      plan = await planNextStep(extract, { goal, variableNames, history: actionsLog });
    } catch (e) {
      return finalize("error", { message: `planning failed: ${errMsg(e)}`, step });
    }
    emit({ type: "planned", step, instruction: plan.instruction, isDone: plan.isDone });
    if (plan.isDone) return finalize("completed");

    // 2. Ground the instruction into a concrete action (retry for transient DOM settling)
    if (signal?.aborted) return finalize("aborted");
    let observed: ObservedAction | null = null;
    for (let attempt = 0; attempt <= maxObserveRetries; attempt++) {
      let candidates: ObservedAction[] = [];
      try {
        candidates = await agent.observe(plan.instruction, variables);
      } catch (e) {
        candidates = [];
        if (attempt === maxObserveRetries) {
          emit({ type: "observed", step, action: null });
        }
        void e;
      }
      if (candidates.length > 0) {
        observed = candidates[0];
        break;
      }
    }

    if (!observed) {
      const proposed: ProposedAction = {
        selector: "",
        description: `Could not locate an element for: ${plan.instruction}`,
        instruction: redact(plan.instruction, secretValues) ?? plan.instruction,
      };
      emit({ type: "observed", step, action: null });
      actionsLog.push({
        step,
        action: proposed,
        risk: { level: "safe", reason: "no target element" },
        decision: "auto",
        outcome: "failed",
        message: "no matching element found",
      });
      consecutiveFailures++;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        return finalize("error", { message: "repeated failure to locate elements", step });
      }
      continue;
    }

    const proposed = toProposed(observed, plan.instruction, secretValues);
    emit({ type: "observed", step, action: proposed });

    // 3. Classify risk
    const risk = classify(proposed);
    emit({ type: "risk", step, assessment: risk });

    // 4. Confirmation gate (fail-closed)
    let decision: ActionRecord["decision"] = "auto";
    if (risk.level === "risky") {
      const approved = params.onBeforeAction ? await params.onBeforeAction(proposed) : false;
      decision = approved ? "approved" : "rejected";
      emit({ type: "decision", step, decision });
      if (!approved) {
        actionsLog.push({ step, action: proposed, risk, decision, outcome: "blocked" });
        return finalize("blocked");
      }
    } else {
      emit({ type: "decision", step, decision: "auto" });
    }

    // 5. Execute the approved/safe action
    if (signal?.aborted) return finalize("aborted");
    let outcome;
    try {
      outcome = await agent.act(observed, variables);
    } catch (e) {
      outcome = { success: false, message: errMsg(e) };
    }
    const record: ActionRecord = {
      step,
      action: proposed,
      risk,
      decision,
      outcome: outcome.success ? "executed" : "failed",
      message: redact(outcome.message, secretValues),
    };
    actionsLog.push(record);
    emit({ type: "acted", step, outcome: record.outcome, message: record.message });

    if (outcome.success) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        return finalize("error", { message: "repeated action failures", step });
      }
    }
  }

  return finalize("max_steps");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/loop.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/loop.ts test/loop.test.ts
git commit -m "feat: owned control loop (plan -> observe -> classify -> confirm -> act)"
```

---

### Task 6: Stagehand-backed session adapter + local integration test

**Files:**
- Create: `src/browser.ts`
- Create: `test/fixtures/form.html`
- Create: `test/browser.integration.test.ts`

**Interfaces:**
- Consumes: `BrowserAgent`, `ObservedAction`, `ActOutcome` from `./types.js`; `Stagehand` from `@browserbasehq/stagehand`; `zod`.
- Produces:
  - `interface CreateSessionConfig = { env?: "BROWSERBASE" | "LOCAL"; model: string; apiKey?: string; projectId?: string; context?: { id: string; persist?: boolean }; headless?: boolean; verbose?: 0 | 1 | 2 }`.
  - `createSession(config: CreateSessionConfig): Promise<BrowserAgent>`.

- [ ] **Step 1: Install the local browser (for LOCAL integration test)**

Run: `npx playwright install chromium`
Expected: Chromium downloaded. (Needed only for LOCAL env; BROWSERBASE runs in the cloud.)

- [ ] **Step 2: Write `src/browser.ts`**

```ts
import { Stagehand } from "@browserbasehq/stagehand";
import type { z } from "zod";
import type { ActOutcome, BrowserAgent, ObservedAction } from "./types.js";

export interface CreateSessionConfig {
  env?: "BROWSERBASE" | "LOCAL";
  model: string;
  apiKey?: string;
  projectId?: string;
  context?: { id: string; persist?: boolean };
  headless?: boolean;
  verbose?: 0 | 1 | 2;
}

export async function createSession(config: CreateSessionConfig): Promise<BrowserAgent> {
  const env = config.env ?? "BROWSERBASE";
  const projectId = config.projectId ?? process.env.BROWSERBASE_PROJECT_ID;

  const stagehand =
    env === "BROWSERBASE"
      ? new Stagehand({
          env: "BROWSERBASE",
          model: config.model,
          verbose: config.verbose ?? 0,
          selfHeal: true,
          apiKey: config.apiKey ?? process.env.BROWSERBASE_API_KEY,
          projectId,
          browserbaseSessionCreateParams: {
            projectId: projectId ?? "",
            ...(config.context
              ? {
                  browserSettings: {
                    context: { id: config.context.id, persist: config.context.persist ?? false },
                  },
                }
              : {}),
          },
        })
      : new Stagehand({
          env: "LOCAL",
          model: config.model,
          verbose: config.verbose ?? 0,
          selfHeal: true,
          localBrowserLaunchOptions: { headless: config.headless ?? true },
        });

  await stagehand.init();
  const page = stagehand.context.pages()[0] ?? (await stagehand.context.newPage());

  return {
    get sessionReplayUrl() {
      return stagehand.browserbaseSessionURL;
    },
    async goto(url: string) {
      await page.goto(url);
    },
    async observe(instruction: string, variables?: Record<string, string>): Promise<ObservedAction[]> {
      const result = await stagehand.observe(instruction, variables ? { variables } : undefined);
      return result.map((a) => ({
        selector: a.selector,
        description: a.description,
        method: a.method,
        arguments: a.arguments,
      }));
    },
    async act(action: ObservedAction, variables?: Record<string, string>): Promise<ActOutcome> {
      const res = await stagehand.act(action, variables ? { variables } : undefined);
      return { success: res.success, message: res.message };
    },
    async extract<T>(instruction: string, schema: z.ZodType<T>): Promise<T> {
      // Cast at the adapter boundary: Stagehand accepts Zod 3/4 schemas via its own type.
      return stagehand.extract(instruction, schema as never) as Promise<T>;
    },
    async close() {
      await stagehand.close();
    },
  };
}
```

- [ ] **Step 3: Write the fixture `test/fixtures/form.html`**

```html
<!doctype html>
<html>
  <head><title>Test Application Form</title></head>
  <body>
    <h1>Job Application</h1>
    <form id="app" onsubmit="event.preventDefault(); document.getElementById('result').textContent = 'Application submitted for ' + document.getElementById('name').value;">
      <label>Full name <input id="name" name="name" type="text" /></label><br />
      <label>Email <input id="email" name="email" type="email" /></label><br />
      <button id="submit" type="submit">Submit Application</button>
    </form>
    <p id="result"></p>
  </body>
</html>
```

- [ ] **Step 4: Write the integration test — `test/browser.integration.test.ts`**

This drives the REAL Stagehand adapter + control loop against the local fixture. It is skipped unless `WAA_ENV=LOCAL` is set, because it needs a local Chromium and makes real LLM calls (requires `ANTHROPIC_API_KEY`).

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createSession } from "../src/browser.js";
import { runLoop } from "../src/loop.js";
import type { BrowserAgent, ProposedAction } from "../src/types.js";

const RUN_LOCAL = process.env.WAA_ENV === "LOCAL";
const d = RUN_LOCAL ? describe : describe.skip;

let server: Server;
let baseUrl: string;
const html = readFileSync(fileURLToPath(new URL("./fixtures/form.html", import.meta.url)), "utf8");

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://localhost:${port}/`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const loopBase = {
  maxSteps: 12,
  maxObserveRetries: 2,
  maxConsecutiveFailures: 3,
  secretValues: [] as string[],
};

d("browser adapter + loop against a local form (real Stagehand)", () => {
  let agent: BrowserAgent;
  afterAll(async () => {
    await agent?.close();
  });

  it("fills the form and blocks the submit when the hook rejects it", async () => {
    agent = await createSession({ env: "LOCAL", model: "anthropic/claude-sonnet-4-6", headless: true });
    const risky: ProposedAction[] = [];
    const res = await runLoop({
      ...loopBase,
      agent,
      url: baseUrl,
      goal: "Fill in the full name and email, then submit the application.",
      variables: { name: "Ada Lovelace", email: "ada@example.com" },
      onBeforeAction: async (a) => {
        risky.push(a);
        return false; // reject the submit
      },
      extractSchema: z.object({ result: z.string() }),
    });

    expect(res.status).toBe("blocked");
    expect(risky.some((a) => /submit/i.test(a.description) || /submit/i.test(a.instruction))).toBe(true);
    expect(res.actionsLog.some((r) => r.outcome === "executed")).toBe(true); // at least one field was filled
  });
});
```

- [ ] **Step 5: Run the integration test locally**

Run: `WAA_ENV=LOCAL ANTHROPIC_API_KEY=<your-key> npx vitest run test/browser.integration.test.ts`
Expected: PASS — the run fills fields, proposes the submit, the hook rejects it, status is `blocked`.

If Stagehand LOCAL cannot find/launch Chromium, re-run `npx playwright install chromium`; if it still fails in this environment, record that the integration test is environment-gated and rely on the Task 5 fake-adapter tests for loop-logic coverage (they are the authoritative logic tests). Do NOT weaken the adapter to make it pass.

- [ ] **Step 6: Verify the default suite still passes (integration test skipped without the flag)**

Run: `npm test`
Expected: PASS — `browser.integration.test.ts` is skipped (no `WAA_ENV=LOCAL`), all unit tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/browser.ts test/fixtures/form.html test/browser.integration.test.ts
git commit -m "feat: Stagehand-backed session adapter + local integration test"
```

---

### Task 7: Public entry point `runAgent`

**Files:**
- Create: `test/index.test.ts`
- Create: `src/index.ts`

**Interfaces:**
- Consumes: everything above; mocks `./browser.js` in tests.
- Produces:
  - `runAgent(options: RunAgentOptions): Promise<AgentRunResult>`.
  - `DEFAULT_MODEL: string`, `autoApprove: (action: ProposedAction) => true`.
  - Re-exports from `./types.js` and `classifyRisk`, `DEFAULT_RISKY_KEYWORDS` from `./risk.js`.

- [ ] **Step 1: Write the failing test — `test/index.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BrowserAgent, ObservedAction } from "../src/types.js";

const fake: { agent: BrowserAgent } = {
  agent: {
    sessionReplayUrl: "https://browserbase.test/session/xyz",
    goto: vi.fn(async () => {}),
    observe: vi.fn(async (i: string): Promise<ObservedAction[]> => [
      { selector: "x", description: i, method: "click" },
    ]),
    act: vi.fn(async () => ({ success: true, message: "ok" })),
    extract: vi.fn(async (_i: string, schema: any) => {
      const shape = schema?.shape ?? {};
      if ("isDone" in shape) return { reasoning: "", isDone: true, instruction: "" };
      return {};
    }),
    close: vi.fn(async () => {}),
  },
};

vi.mock("../src/browser.js", () => ({
  createSession: vi.fn(async () => fake.agent),
}));

import { runAgent, autoApprove, DEFAULT_MODEL } from "../src/index.js";

beforeEach(() => vi.clearAllMocks());

describe("runAgent", () => {
  it("throws synchronously on invalid options", async () => {
    // @ts-expect-error missing goal
    await expect(runAgent({ url: "https://x.com" })).rejects.toBeInstanceOf(TypeError);
    // @ts-expect-error missing url
    await expect(runAgent({ goal: "do it" })).rejects.toBeInstanceOf(TypeError);
  });

  it("returns a completed result and closes the session", async () => {
    const res = await runAgent({ url: "https://x.com", goal: "immediately done" });
    expect(res.status).toBe("completed");
    expect(res.success).toBe(true);
    expect(res.sessionReplayUrl).toBe("https://browserbase.test/session/xyz");
    expect(res.summary).toContain("completed");
    expect(fake.agent.close).toHaveBeenCalledTimes(1);
  });

  it("returns status error (does not throw) when session creation fails", async () => {
    const browser = await import("../src/browser.js");
    (browser.createSession as any).mockRejectedValueOnce(new Error("no api key"));
    const res = await runAgent({ url: "https://x.com", goal: "g" });
    expect(res.status).toBe("error");
    expect(res.success).toBe(false);
    expect(res.error?.message).toContain("no api key");
  });

  it("exports autoApprove and DEFAULT_MODEL", () => {
    expect(autoApprove({ selector: "", description: "", instruction: "" })).toBe(true);
    expect(DEFAULT_MODEL).toBe("anthropic/claude-sonnet-4-6");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/index.test.ts`
Expected: FAIL. Note: `src/index.ts` already exists as a placeholder stub from Task 1 (it holds no real exports), so the failure manifests as missing exports — e.g. `runAgent`/`autoApprove` are `undefined` ("runAgent is not a function", `DEFAULT_MODEL` assertion fails) — rather than "cannot find module". This is the RED phase.

- [ ] **Step 3: Write `src/index.ts` (overwrite the Task 1 placeholder stub)**

```ts
import type { AgentRunResult, ProposedAction, RunAgentOptions } from "./types.js";
import { createSession } from "./browser.js";
import { runLoop, type LoopResult } from "./loop.js";

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

export const autoApprove = (_action: ProposedAction): true => true;

export * from "./types.js";
export { classifyRisk, DEFAULT_RISKY_KEYWORDS } from "./risk.js";
export type { CreateSessionConfig } from "./browser.js";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function validateOptions(options: RunAgentOptions): void {
  if (!options || typeof options !== "object") {
    throw new TypeError("runAgent: options object is required");
  }
  if (typeof options.url !== "string" || options.url.length === 0) {
    throw new TypeError("runAgent: 'url' must be a non-empty string");
  }
  if (typeof options.goal !== "string" || options.goal.length === 0) {
    throw new TypeError("runAgent: 'goal' must be a non-empty string");
  }
  if (options.maxSteps !== undefined && (!Number.isInteger(options.maxSteps) || options.maxSteps < 1)) {
    throw new TypeError("runAgent: 'maxSteps' must be a positive integer");
  }
}

function buildSummary(result: LoopResult): string {
  const executed = result.actionsLog.filter((r) => r.outcome === "executed").length;
  const last = result.actionsLog.at(-1);
  const phrases: Record<LoopResult["status"], string> = {
    completed: "Goal completed",
    blocked: "Stopped: a risky action was not approved",
    aborted: "Aborted before completion",
    max_steps: "Stopped after reaching the step limit",
    error: "Stopped due to an error",
  };
  const parts = [
    `${phrases[result.status]}.`,
    `${executed} action(s) executed over ${result.stepsUsed} step(s).`,
  ];
  if (last) parts.push(`Last action: ${last.action.description} (${last.outcome}).`);
  if (result.error) parts.push(`Error: ${result.error.message}.`);
  return parts.join(" ");
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  validateOptions(options);

  const data = options.data ?? {};
  const credentials = options.credentials ?? {};
  const variables = { ...data, ...credentials };
  const secretValues = Object.values(credentials).filter((v) => v.length > 0);
  const maxSteps = options.maxSteps ?? 25;
  const env = (process.env.WAA_ENV as "BROWSERBASE" | "LOCAL" | undefined) ?? "BROWSERBASE";

  let agent;
  try {
    agent = await createSession({
      env,
      model: options.model ?? DEFAULT_MODEL,
      context: options.context,
    });
  } catch (e) {
    return {
      success: false,
      status: "error",
      summary: "Failed to start the browser session.",
      actionsLog: [],
      stepsUsed: 0,
      error: { message: errMsg(e) },
    };
  }

  try {
    const result = await runLoop({
      agent,
      url: options.url,
      goal: options.goal,
      variables,
      secretValues,
      onBeforeAction: options.onBeforeAction,
      classifyRiskFn: options.classifyRisk,
      extractSchema: options.extractSchema,
      maxSteps,
      maxObserveRetries: 2,
      maxConsecutiveFailures: 3,
      signal: options.signal,
      onEvent: options.onEvent,
    });
    return {
      success: result.status === "completed",
      status: result.status,
      summary: buildSummary(result),
      actionsLog: result.actionsLog,
      extractedData: result.extractedData,
      sessionReplayUrl: agent.sessionReplayUrl,
      stepsUsed: result.stepsUsed,
      error: result.error,
    };
  } finally {
    await agent.close().catch(() => {});
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/index.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: runAgent public entry point"
```

---

### Task 8: CLI wrapper

**Files:**
- Create: `test/cli.test.ts`
- Create: `src/cli.ts`

**Interfaces:**
- Consumes: `runAgent`, `autoApprove` from `./index.js`; `ProposedAction`, `AgentEvent` from `./types.js`; `node:readline/promises`.
- Produces: `parseArgs(argv: string[]): CliArgs` (pure, exported for tests) and a runnable `main()` guarded by an `import.meta` entry check.
  - `interface CliArgs = { url: string; goal: string; data: Record<string,string>; credentials: Record<string,string>; model?: string; auto: boolean; local: boolean }`.

- [ ] **Step 1: Write the failing test — `test/cli.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/cli.js";

describe("parseArgs", () => {
  it("parses url, goal, json data/creds, and flags", () => {
    const args = parseArgs([
      "--url", "https://x.com/apply",
      "--goal", "apply for the job",
      "--data", '{"name":"Ada"}',
      "--creds", '{"password":"pw"}',
      "--model", "anthropic/claude-opus-4-8",
      "--auto",
      "--local",
    ]);
    expect(args.url).toBe("https://x.com/apply");
    expect(args.goal).toBe("apply for the job");
    expect(args.data).toEqual({ name: "Ada" });
    expect(args.credentials).toEqual({ password: "pw" });
    expect(args.model).toBe("anthropic/claude-opus-4-8");
    expect(args.auto).toBe(true);
    expect(args.local).toBe(true);
  });

  it("defaults data/creds to empty objects and flags to false", () => {
    const args = parseArgs(["--url", "https://x.com", "--goal", "g"]);
    expect(args.data).toEqual({});
    expect(args.credentials).toEqual({});
    expect(args.auto).toBe(false);
    expect(args.local).toBe(false);
  });

  it("throws on missing required flags", () => {
    expect(() => parseArgs(["--goal", "g"])).toThrow(/url/);
    expect(() => parseArgs(["--url", "https://x.com"])).toThrow(/goal/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — cannot find module `../src/cli.js`.

- [ ] **Step 3: Write `src/cli.ts`**

```ts
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv } from "node:process";
import { runAgent, autoApprove } from "./index.js";
import type { AgentEvent, ConfirmFn, ProposedAction } from "./types.js";

export interface CliArgs {
  url: string;
  goal: string;
  data: Record<string, string>;
  credentials: Record<string, string>;
  model?: string;
  auto: boolean;
  local: boolean;
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

export function parseArgs(args: string[]): CliArgs {
  const url = getFlag(args, "--url");
  const goal = getFlag(args, "--goal");
  if (!url) throw new Error("Missing required flag: --url");
  if (!goal) throw new Error("Missing required flag: --goal");
  const dataRaw = getFlag(args, "--data");
  const credsRaw = getFlag(args, "--creds");
  return {
    url,
    goal,
    data: dataRaw ? (JSON.parse(dataRaw) as Record<string, string>) : {},
    credentials: credsRaw ? (JSON.parse(credsRaw) as Record<string, string>) : {},
    model: getFlag(args, "--model"),
    auto: args.includes("--auto"),
    local: args.includes("--local"),
  };
}

function interactiveConfirm(): ConfirmFn {
  const rl = createInterface({ input: stdin, output: stdout });
  return async (action: ProposedAction) => {
    const answer = await rl.question(
      `\n[confirm] Risky action: ${action.description}\n          (instruction: ${action.instruction})\n          Approve? [y/N] `,
    );
    return answer.trim().toLowerCase() === "y";
  };
}

function printEvent(e: AgentEvent): void {
  switch (e.type) {
    case "planned":
      stdout.write(`\n[step ${e.step}] plan: ${e.isDone ? "(goal complete)" : e.instruction}\n`);
      break;
    case "risk":
      stdout.write(`[step ${e.step}] risk: ${e.assessment.level} — ${e.assessment.reason}\n`);
      break;
    case "acted":
      stdout.write(`[step ${e.step}] acted: ${e.outcome}${e.message ? ` — ${e.message}` : ""}\n`);
      break;
    case "done":
      stdout.write(`\n[done] status: ${e.status}\n`);
      break;
    default:
      break;
  }
}

export async function main(rawArgs: string[]): Promise<void> {
  const args = parseArgs(rawArgs);
  if (args.local) process.env.WAA_ENV = "LOCAL";

  const rlConfirm = args.auto ? null : interactiveConfirm();
  const onBeforeAction: ConfirmFn = args.auto ? autoApprove : rlConfirm!;

  try {
    const result = await runAgent({
      url: args.url,
      goal: args.goal,
      data: args.data,
      credentials: args.credentials,
      model: args.model,
      onBeforeAction,
      onEvent: printEvent,
    });
    stdout.write(`\n=== RESULT ===\n${JSON.stringify(result, null, 2)}\n`);
  } finally {
    // readline keeps the process alive; nothing else to clean up.
    process.exit(0);
  }
}

// Run only when executed directly (not when imported by tests).
if (import.meta.url === `file://${argv[1]}`) {
  main(argv.slice(2)).catch((err) => {
    stdout.write(`\n[error] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Manual smoke of the CLI help path (arg parsing only)**

Run: `npx tsx src/cli.ts --url https://x.com 2>&1 | head -1 || true`
Expected: prints a "Missing required flag: --goal" error (confirms the CLI wires up and validates). A full live run requires real credentials and is exercised manually.

- [ ] **Step 6: Full suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: all PASS; `dist/` is produced with `.js` + `.d.ts` files.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: dev CLI wrapper with interactive confirmation"
```

---

## Notes / Known Risks (read before implementing)

1. **Planner reuses `extract()` as a reasoner.** `planNextStep` calls `stagehand.extract(prompt, planStepSchema)`; Stagehand feeds the current page content plus our prompt to the LLM and returns `{ reasoning, isDone, instruction }`. This avoids adding a second LLM integration. **Risk:** `extract` is designed to pull data *from* the page, so a stubborn model might return page content instead of a plan. If the local integration test (Task 6) shows poor planning, the fallback is to add a dedicated LLM call (`npm i ai @ai-sdk/anthropic`) inside `planNextStep` while keeping its signature identical — no other module changes. The `ExtractFn` seam already isolates this.

2. **Summary is deterministic, not LLM-generated.** The spec (§4) mentioned an LLM summary; we build a deterministic recap in `buildSummary` for reliability and zero extra cost. Swapping in an LLM summary later is a one-function change in `index.ts`.

3. **Two LLM calls per step** (plan via `extract`, ground via `observe`) plus the `act`. This is acceptable for v1 and bounded by `maxSteps`. If cost matters, a later optimization is to let `observe` do goal-aware grounding directly; out of scope now.

4. **LOCAL env browser dependency.** The Task 6 integration test needs `npx playwright install chromium` and a real `ANTHROPIC_API_KEY`. It is `describe.skip`-ed unless `WAA_ENV=LOCAL`, so CI and the default `npm test` stay green and free. The fake-adapter tests in Task 5 are the authoritative coverage for loop logic.

5. **Zod version boundary.** Stagehand accepts Zod 3 or 4; we standardize on Zod 4. The adapter casts the schema (`schema as never`) at the single boundary in `browser.ts` to bridge our `z.ZodType<T>` to Stagehand's internal schema type. Keep the cast confined to that one function.

6. **`import.meta.url` entry check** in `cli.ts` assumes execution via `tsx src/cli.ts` or `node dist/cli.js`. If invoked through a different launcher and the guard misfires, run `main(process.argv.slice(2))` explicitly.
