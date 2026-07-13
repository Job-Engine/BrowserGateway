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
  if (
    options.maxSteps !== undefined &&
    (!Number.isInteger(options.maxSteps) || options.maxSteps < 1)
  ) {
    throw new TypeError("runAgent: 'maxSteps' must be a positive integer");
  }
}

function buildSummary(result: LoopResult): string {
  const executed = result.actionsLog.filter((r) => r.outcome === "executed").length;
  const last = result.actionsLog.at(-1);
  const phrases: Record<LoopResult["status"], string> = {
    completed: "Goal completed",
    blocked: "Stopped: an action was not approved",
    aborted: "Aborted before completion",
    max_steps: "Stopped after reaching the step limit",
    timeout: "Stopped: wall-clock timeout exceeded",
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

  // Wall-clock budget: abort the loop at the deadline and, if it is stuck
  // inside a browser or LLM call, race past it with a synthetic timeout result.
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    const loopPromise = runLoop({
      agent,
      url: options.url,
      goal: options.goal,
      variables,
      secretValues,
      onBeforeAction: options.onBeforeAction,
      classifyRiskFn: options.classifyRisk,
      extractSchema: options.extractSchema,
      allowedMethods: options.allowedMethods,
      maxSteps,
      maxObserveRetries: 2,
      maxConsecutiveFailures: 3,
      signal: controller.signal,
      onEvent: options.onEvent,
    });

    let result: LoopResult;
    if (options.timeoutMs) {
      const timeoutResult = new Promise<LoopResult>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          resolve({
            status: "timeout",
            actionsLog: [],
            stepsUsed: 0,
            error: { message: `run exceeded wall-clock timeout of ${options.timeoutMs}ms` },
          });
        }, options.timeoutMs);
      });
      result = await Promise.race([loopPromise, timeoutResult]);
      // The losing loop promise must not surface as an unhandled rejection.
      loopPromise.catch(() => {});
    } else {
      result = await loopPromise;
    }
    if (timedOut && result.status === "aborted") {
      result = {
        ...result,
        status: "timeout",
        error: result.error ?? {
          message: `run exceeded wall-clock timeout of ${options.timeoutMs}ms`,
        },
      };
    }
    return {
      success: result.status === "completed",
      status: result.status,
      summary: buildSummary(result),
      actionsLog: result.actionsLog,
      extractedData: result.extractedData,
      sessionReplayUrl: agent.sessionReplayUrl,
      sessionId: agent.sessionId,
      stepsUsed: result.stepsUsed,
      error: result.error,
    };
  } catch (e) {
    return {
      success: false,
      status: "error",
      summary: "The agent run failed unexpectedly.",
      actionsLog: [],
      stepsUsed: 0,
      sessionReplayUrl: agent.sessionReplayUrl,
      sessionId: agent.sessionId,
      error: { message: errMsg(e) },
    };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
    await agent.close().catch(() => {});
  }
}
