// Deterministic replay: trace types, input parameterization, identity
// matching, the replay executor, and the learn wrapper that records traces.
// Sanctioned core change 5 (see docs/superpowers/specs/2026-07-14-deterministic-replay-design.md).
import type { z } from "zod";
import { createSession } from "./browser.js";
import { runLoop } from "./loop.js";
import type { ActionRecord, AgentStatus, BrowserAgent, ObservedAction } from "./types.js";

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

/**
 * Whole-token, case-insensitive occurrence of value inside text. The percent
 * sign is excluded from both boundaries so the interior of an existing
 * %placeholder% token can never match.
 */
function tokenPattern(value: string): RegExp {
  return new RegExp(`(^|[^a-zA-Z0-9%])(${escapeRegExp(value)})(?=[^a-zA-Z0-9%]|$)`, "gi");
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
        // Fix I: non-string input values (defensive; the type is nominally
        // Record<string, string>, but callers can still hand us other JSON
        // types at the runtime boundary) are skipped, never templated.
        if (typeof value !== "string" || !value || value.length < MIN_PARAM_LENGTH) continue;
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

/** Whole-token %placeholder% matches, e.g. %name% or %username%. */
const PLACEHOLDER_TOKENS = /%[a-zA-Z0-9_]+%/g;

function tokensOf(text: string): Set<string> {
  return new Set(text.match(PLACEHOLDER_TOKENS) ?? []);
}

/**
 * Fill %inputKey% tokens in `text` with the current job's input, then verify
 * no NEW %placeholder% token appeared in the result (Fix A). Templates
 * legitimately retain credential placeholders (%username%, %otp%, ...); those
 * are already present in `text` before filling and are left untouched here.
 * A caller who submits an input value that itself looks like a placeholder
 * token (e.g. name: "%password%") would otherwise inject that token into the
 * resolved action, which `agent.act(action, variables)` resolves against the
 * real credential. This is belt-and-suspenders: the gateway runner already
 * rejects such input before a job ever reaches replay.
 */
function fillChecked(text: string, input: Record<string, string>): string {
  const before = tokensOf(text);
  const filled = Object.entries(input).reduce(
    (acc, [key, value]) => (typeof value === "string" ? acc.split(`%${key}%`).join(value) : acc),
    text,
  );
  for (const token of tokensOf(filled)) {
    if (!before.has(token)) {
      throw new Error("resolveStep: input introduced a placeholder token");
    }
  }
  return filled;
}

/** Resolve a step against the current job's input for execution. */
export function resolveStep(step: TraceStep, input: Record<string, string>): ObservedAction {
  const source = step.paramTemplate ?? { selector: step.selector, arguments: step.arguments };
  return {
    selector: step.paramTemplate ? fillChecked(source.selector, input) : source.selector,
    method: step.method,
    // Credential tokens (%username%...) stay: Stagehand resolves them via variables.
    arguments: step.paramTemplate
      ? source.arguments.map((a) => fillChecked(a, input))
      : source.arguments,
    description: step.description,
  };
}

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
 * Conservative identity match. After normalization:
 * - empty shown or expected text never matches;
 * - every expected word token must be present in shown with at least the
 *   same multiplicity;
 * - the expected numeric tokens must appear in shown in the same order
 *   (subsequence), so transposed house/unit/zip numbers reject.
 * False rejects cost an extra LLM run; false accepts return the wrong
 * customer's data. When in doubt, reject.
 */
export function fuzzyMatch(shown: string, expected: string): boolean {
  const shownNorm = normalizeIdentity(shown);
  const expectedNorm = normalizeIdentity(expected);
  if (shownNorm === "" || expectedNorm === "") return false;

  const shownTokens = shownNorm.split(" ");
  const expectedTokens = expectedNorm.split(" ");

  const isNumeric = (t: string): boolean => /^\d+$/.test(t);

  const shownWordCounts = new Map<string, number>();
  for (const t of shownTokens) {
    if (!isNumeric(t)) shownWordCounts.set(t, (shownWordCounts.get(t) ?? 0) + 1);
  }
  for (const t of expectedTokens) {
    if (isNumeric(t)) continue;
    const left = shownWordCounts.get(t) ?? 0;
    if (left === 0) return false;
    shownWordCounts.set(t, left - 1);
  }

  const shownNumbers = shownTokens.filter(isNumeric);
  const expectedNumbers = expectedTokens.filter(isNumeric);
  let cursor = 0;
  for (const n of expectedNumbers) {
    let found = -1;
    for (let i = cursor; i < shownNumbers.length; i++) {
      if (shownNumbers[i] === n) {
        found = i;
        break;
      }
    }
    if (found === -1) return false;
    cursor = found + 1;
  }
  return true;
}

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
 * Read with settle-retry. readText is fail-fast (never waits), but the DOM
 * may still be settling right after the last replayed act. Retry up to 2
 * more times, 500ms apart, before recording a null, respecting the deadline.
 */
async function readWithSettle(
  agent: BrowserAgent,
  selector: string,
  deadline: number,
): Promise<string | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = await agent.readText(selector);
    if (text !== null) return text;
    if (Date.now() + 500 > deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

/**
 * Replace literal credential values with *** in outbound failure text.
 * Secrets are redacted longest-first (Fix F): redacting a short secret ("u")
 * before a longer one that contains it ("hunter2") would mangle the longer
 * secret into a partially-redacted, still-recoverable string ("h***nter2").
 */
function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
    if (s) out = out.split(s).join("***");
  }
  return out;
}

/**
 * Execute a stored trace with zero LLM calls. Returns ok only when every step
 * executed, every verify field fuzzy-matched the input, and the data reads
 * completed. Anything else returns ok: false; the caller escalates to the
 * learn path. This function never emits a business "failure".
 */
export async function replayTrace(options: ReplayRunOptions): Promise<ReplayOutcome> {
  const variables = { ...options.input, ...options.credentials };
  const secretValues = Object.values(options.credentials).filter((v) => v.length > 0);
  let stepsUsed = 0;
  const fail = (reason: string): ReplayOutcome => ({ ok: false, reason, stepsUsed });

  try {
    await options.agent.goto(options.url);
  } catch (e) {
    return fail(
      `navigation failed: ${redactSecrets(e instanceof Error ? e.message : String(e), secretValues)}`,
    );
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
    if (!outcome.success)
      return fail(`step ${stepsUsed} failed: ${redactSecrets(outcome.message, secretValues)}`);
  }

  if (Date.now() > options.deadline) return fail("deadline exceeded");

  const data: Record<string, unknown> = {};
  for (const field of Object.keys(options.plan.reads)) {
    const selector = options.trace.readSelectors[field];
    data[field] = selector ? await readWithSettle(options.agent, selector, options.deadline) : null;
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

// Duplicated deliberately: src/index.ts must never import src/replay.ts, so
// the default model value is repeated here rather than imported.
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

    // 3. Ground read selectors while the record page is still open. Each
    // observe() call costs real wall-clock time; stop grounding once the
    // budget is gone rather than run past the deadline (Fix C). A draft that
    // stops early is simply marked incomplete; it is never activated.
    let traceDraft: TraceDraft | null = null;
    if (success && options.replayPlan) {
      const readSelectors: Record<string, string> = {};
      let complete = Date.now() < deadline;
      if (complete) {
        for (const [field, hint] of Object.entries(options.replayPlan.reads)) {
          if (Date.now() >= deadline) {
            complete = false;
            break;
          }
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
