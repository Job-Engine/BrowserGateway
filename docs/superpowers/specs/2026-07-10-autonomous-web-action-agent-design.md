# Autonomous Web Action Agent — Design Spec

- **Date:** 2026-07-10
- **Status:** Approved (design), pending spec review
- **Author:** Andy Pilipovic (with Claude Code)

## 1. Overview

A TypeScript library that drives a Browserbase cloud browser (via the Stagehand v3 SDK) to
accomplish a natural-language **goal** on an **arbitrary website** — filling forms and taking
actions (submitting, posting, applying, updating records) — while **pausing for human
confirmation before risky/irreversible actions**. It returns a rich, structured result.

The library exposes one primary function, `runAgent(options)`, intended to be embedded inside a
larger application. A thin CLI wraps it for development and testing only.

### Why an owned control loop (not Stagehand's `agent()`)

Verified against the current Stagehand v3 docs: `stagehand.agent().execute()` runs a **fully
autonomous multi-step loop and executes each action itself**. Its `prepareStep` / `onStepFinish`
callbacks are observe-only and **cannot block a pending action**; the only interruption is a
whole-run `AbortSignal`. Therefore Stagehand's built-in agent **cannot honor a "pause and confirm
before risky actions" hook**.

The documented way to achieve true per-action approval is a loop _we_ own, built on Stagehand's
lower-level primitives: `observe()` returns a concrete candidate action **without executing it**,
which we can classify, gate through a confirmation hook, and only then execute with `act()`. This
design is the honest match for the chosen safety model.

## 2. Goals / Non-goals

### Goals (v1)

- One embeddable async function `runAgent(options)` returning a structured `AgentRunResult`.
- Works on arbitrary sites given `{ url, goal, data }` — plans and grounds each step live.
- Per-action human-in-the-loop confirmation before risky/irreversible actions, via an
  `onBeforeAction` hook. Safe by default (risky actions blocked when no hook is supplied).
- Optional login via credentials passed in options and/or a persisted Browserbase Context.
- Secrets (credentials, sensitive data) never enter the LLM context.
- Optional final structured-data extraction against a caller-supplied Zod schema.
- Configurable LLM (default Claude Sonnet), bounded by `maxSteps`, cancellable via `AbortSignal`.
- A thin CLI wrapper for local dev/testing with an interactive terminal confirm.
- Real end-to-end verification via a local HTML fixture (Stagehand `env: "LOCAL"`).

### Non-goals (v1 — explicitly deferred)

- HTTP API service / deployment (the library is designed to be wrappable later).
- Multi-agent orchestration, chat UI, or a web front-end.
- A hardcoded `agent()`-powered "fast lane" for fully autonomous runs.
- Multi-site flow libraries / per-site tuned scripts (the agent is site-agnostic).

## 3. Public API

```ts
import { z } from "zod";

async function runAgent(options: RunAgentOptions): Promise<AgentRunResult>;

interface RunAgentOptions {
  /** Starting page URL. */
  url: string;
  /** Natural-language objective, e.g. "apply for the software engineer role". */
  goal: string;
  /** Non-secret values the agent may use to fill forms (name, email, free-text answers). */
  data?: Record<string, string>;
  /** Secret values (username, password, tokens). Injected via Stagehand `variables`; never sent to the LLM. */
  credentials?: Record<string, string>;
  /**
   * Confirmation gate, invoked before any action classified as risky.
   * Return true to approve, false to reject (rejection aborts the run with status "blocked").
   * If omitted, risky actions are BLOCKED (fail-closed). Use the exported `autoApprove` for full autonomy.
   */
  onBeforeAction?: (action: ProposedAction) => boolean | Promise<boolean>;
  /** Optional override of the default risk heuristic. */
  classifyRisk?: (action: ProposedAction) => RiskAssessment;
  /** If provided, structured data is extracted against this schema after the goal completes. */
  extractSchema?: z.ZodType;
  /** LLM model string (Stagehand "provider/model" form). Default: "anthropic/claude-sonnet-4-6". */
  model?: string;
  /** Hard upper bound on planning/action steps. Default: 25. */
  maxSteps?: number;
  /** Browserbase Context for persisting/reusing authentication across runs. */
  context?: { id: string; persist?: boolean };
  /** External cancellation. */
  signal?: AbortSignal;
  /** Structured step-by-step telemetry (planning, observed candidate, risk, decision, act result). */
  onEvent?: (event: AgentEvent) => void;
}

interface ProposedAction {
  /** Locator (XPath) of the target element, from Stagehand observe(). */
  selector: string;
  /** Human-readable description of the action. */
  description: string;
  /** e.g. "click", "fill". */
  method?: string;
  /** Method arguments (e.g. the text to type — redacted if it maps to a secret). */
  arguments?: string[];
  /** The planner's natural-language instruction that produced this candidate. */
  instruction: string;
}

type RiskLevel = "safe" | "risky";
interface RiskAssessment {
  level: RiskLevel;
  reason: string;
}

interface ActionRecord {
  step: number;
  action: ProposedAction;
  risk: RiskAssessment;
  decision: "auto" | "approved" | "rejected";
  outcome: "executed" | "blocked" | "failed";
  message?: string;
}

type AgentEvent =
  | { type: "step_start"; step: number }
  | { type: "planned"; step: number; instruction: string; isDone: boolean }
  | { type: "observed"; step: number; action: ProposedAction | null }
  | { type: "risk"; step: number; assessment: RiskAssessment }
  | { type: "decision"; step: number; decision: ActionRecord["decision"] }
  | { type: "acted"; step: number; outcome: ActionRecord["outcome"]; message?: string }
  | { type: "done"; status: AgentRunResult["status"] };

interface AgentRunResult {
  success: boolean;
  status: "completed" | "blocked" | "aborted" | "max_steps" | "error";
  /** Natural-language recap of what happened. */
  summary: string;
  /** Every action proposed, with its risk level, decision, and outcome. */
  actionsLog: ActionRecord[];
  /** Present iff extractSchema was provided. */
  extractedData?: unknown;
  /** Browserbase session replay / live-view URL for debugging (BROWSERBASE env only). */
  sessionReplayUrl?: string;
  stepsUsed: number;
  error?: { message: string; step?: number };
}

/** Convenience export for full autonomy: `onBeforeAction: autoApprove`. */
declare const autoApprove: (action: ProposedAction) => true;
```

### Chosen defaults (agreed)

- **No `onBeforeAction` → risky actions are BLOCKED** (fail-closed). The run ends `status: "blocked"`
  and reports the action it wanted to take. Callers opt into autonomy with `autoApprove` or an
  interactive hook.
- **Hook returns false on a risky action → the run aborts** with `status: "blocked"` (the goal can't
  complete without it) rather than silently skipping the action.

## 4. Architecture — the control loop

ReAct-style loop that we own:

```
init Stagehand (env "BROWSERBASE", model, optional Context) → page.goto(url)
repeat up to maxSteps:
  if signal.aborted → status "aborted", break
  read page state         extract() → lightweight page text / summary
  plan next step          planner(goal, data, history, pageState) → { instruction, isDone }
  if isDone → break
  ground the instruction  observe(instruction) → candidate ProposedAction (NOT executed)
                          if no candidate → replan with a revised instruction (up to N retries)
  classify risk           classifyRisk(candidate) → { level, reason }
  if level === "risky":
      approved = await onBeforeAction(candidate)   // default: block
      if !approved → record "rejected"/"blocked", status "blocked", break
  execute                 act(candidate) with secrets injected via `variables`
  record ActionRecord, emit events
finally:
  if extractSchema → extractedData = extract(goalContext, extractSchema)
  summary = planner/LLM summary of history
  sessionReplayUrl = stagehand.browserbaseSessionURL
  stagehand.close()   // ALWAYS
```

- **Grounding without execution** is the linchpin: `observe(instruction)` returns
  `{ selector, description, method, arguments }` candidates and executes nothing, so we can gate
  before `act()`.
- **Secrets:** credentials and any sensitive `data` fields are passed to `act()` / `observe()`
  through Stagehand's `variables` map using `%name%` placeholders in the instruction. Variable
  values are not sent to the LLM. `ProposedAction.arguments` are redacted when they map to a secret.

## 5. Modules

Each is small, single-purpose, and independently testable.

| Module       | Responsibility                                                                                                                                                                                                | Depends on             | Testable via            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------- |
| `types.ts`   | Shared types/interfaces.                                                                                                                                                                                      | —                      | (types only)            |
| `browser.ts` | Stagehand/Browserbase session lifecycle. `createSession(config)` → `{ stagehand, page, sessionReplayUrl, close() }`. Isolates all init (env, model, projectId via `browserbaseSessionCreateParams`, Context). | Stagehand              | LOCAL env / integration |
| `risk.ts`    | **Pure** `classifyRisk(action, config)` → `RiskAssessment`. No I/O.                                                                                                                                           | —                      | unit table              |
| `planner.ts` | LLM planning: `(goal, data, history, pageState)` → `{ instruction, isDone }`; and end-of-run `summarize(history)`.                                                                                            | LLM client             | unit (mocked LLM)       |
| `loop.ts`    | Orchestrates planner → observe → risk → confirm → act; builds `actionsLog`; emits `AgentEvent`s.                                                                                                              | browser, risk, planner | integration (LOCAL)     |
| `extract.ts` | Optional final Zod-schema extraction.                                                                                                                                                                         | Stagehand              | integration (LOCAL)     |
| `index.ts`   | `runAgent()` public entry: validate options, create session, run loop, assemble result, `finally` close. Never throws on operational failure (returns `status: "error"`); throws only on invalid options.     | all                    | integration (LOCAL)     |
| `cli.ts`     | Dev wrapper: parse args / JSON file, provide interactive terminal confirm as the default `onBeforeAction`, pretty-print result. Not the primary artifact.                                                     | index                  | manual                  |

## 6. Risk classification (v1)

Deterministic, best-effort heuristic over the observed `ProposedAction`:

- **Method signal:** form submission or navigation-causing clicks.
- **Keyword signal:** `description` (and mapped instruction) matches any of:
  `submit, send, pay, purchase, checkout, buy, order, delete, remove, post, publish, confirm,
apply, sign, agree, accept, transfer, book, reserve`.
- Any match → `level: "risky"` with a `reason`; otherwise `"safe"`.

Documented as best-effort — the confirmation hook is the real safety net. Callers may override the
whole heuristic with `options.classifyRisk`. The keyword list lives in one place and is easy to tune.

## 7. Error handling & status semantics

- Per-step `try/catch`. Stagehand `selfHeal` (default on) absorbs minor DOM drift.
- `observe()` returns no candidate → planner retries with a revised instruction up to N times
  (default 2); if still none, that step fails and the loop records `outcome: "failed"` and replans;
  repeated failures within a step budget end the run with `status: "error"`.
- `maxSteps` reached without `isDone` → `status: "max_steps"`, `success: false`, partial log returned.
- `signal` aborted → `status: "aborted"`.
- Risky action rejected by hook (or no hook) → `status: "blocked"`.
- Unhandled operational failure → `status: "error"` with `{ message, step }`. `runAgent` does **not**
  throw for operational failures; it throws synchronously only for invalid options (programmer error).
- Session is **always** closed in a `finally` block; `sessionReplayUrl` is captured for post-mortem
  even on failure.

`success` is `true` only for `status: "completed"`.

## 8. Testing strategy (TDD)

- **Unit:**
  - `risk.ts` — table of `ProposedAction` → expected `RiskAssessment` (submit/pay/delete → risky;
    benign fill/click → safe).
  - `planner.ts` — with a mocked LLM client: correct prompt assembly, `isDone` handling, retry logic.
  - `index.ts` option validation — missing `url`/`goal` throws; bad types throw.
- **Integration (real end-to-end, free, deterministic):** run the whole loop in Stagehand
  `env: "LOCAL"` (local Chromium) against a **local static HTML form fixture** served over http.
  Assert: fields fill from `data`; the submit is classified risky; the run blocks when the hook
  returns false; the run submits and reports `completed` when the hook returns true; result shape and
  `actionsLog` are correct; secrets do not appear in emitted events.
- **Smoke (opt-in, gated by env flag, not in CI):** one real Browserbase run against a public form
  with `autoApprove`. Off by default (costs money, flaky).

Order: write the fixture + `risk` unit tests + the loop's confirm-behavior integration test before
implementing `loop.ts`.

## 9. Stack, config, environment

- **Language/runtime:** TypeScript, ESM, Node 20+.
- **Deps:** `@browserbasehq/stagehand` (v3), `zod` (peer of Stagehand; used for `extractSchema`).
- **Dev deps:** `vitest` (tests), `tsx` (run CLI/dev + local server), `typescript` (build to `dist/`).
- **Env vars:** `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `ANTHROPIC_API_KEY`.
  - `projectId` is passed via `browserbaseSessionCreateParams.projectId` (or `BROWSERBASE_PROJECT_ID`).
  - **Model Gateway option:** a `gateway/...` model prefix bills the LLM through the Browserbase key,
    removing the need for a separate `ANTHROPIC_API_KEY`. Supported by passing the prefixed model
    string; documented in `.env.example`.
- `.env.example` documents all of the above.

## 10. Notes / risks to verify during implementation

- **Exact Stagehand v3 type names** (`V3Options`/constructor params, `Action` fields, `AgentResult`)
  were summarized from docs; confirm against the shipped `.d.ts` when scaffolding. The method
  surface is `stagehand.act()/observe()/extract()` on the **instance** (not `page.*`) in v3;
  `page` (from `stagehand.context.pages()[0]`) is a plain Playwright page for `goto()`.
- **Claude model slug** (`claude-sonnet-4-6` vs `claude-sonnet-4.5`) churns across doc pages — keep
  it configurable, never hard-coded beyond the default constant.
- **Session URL property** (`stagehand.browserbaseSessionURL`) — confirm exact property name against
  the `.d.ts`.

```

```
