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
  /** When set, replaces the risk classifier + confirm gate with a code-enforced allowlist. */
  allowedMethods?: readonly string[];
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
  // Fix F: longest-first so a short secret cannot mangle a longer one it's a
  // substring of (e.g. "u" redacting inside "hunter2" before "hunter2" itself
  // is redacted would leak "h***nter2").
  for (const s of [...secrets].sort((a, b) => b.length - a.length)) {
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
  // One observe failure per run is forgiven: the planner sees the failed step
  // in history and gets a chance to re-plan before failures count toward error.
  let freeReplanUsed = false;

  const finalize = async (
    status: AgentStatus,
    error?: LoopResult["error"],
  ): Promise<LoopResult> => {
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
        // The envelope contract promises data shaped by the locked schema;
        // strip any extra keys the extraction backend tacks on.
        const parsed = params.extractSchema.safeParse(extractedData);
        if (parsed.success) extractedData = parsed.data;
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
    emit({
      type: "planned",
      step,
      instruction: redact(plan.instruction, secretValues) ?? plan.instruction,
      isDone: plan.isDone,
    });
    if (plan.isDone) return finalize("completed");

    // 2. Ground the instruction into a concrete action (retry for transient DOM settling)
    if (signal?.aborted) return finalize("aborted");
    let observed: ObservedAction | null = null;
    for (let attempt = 0; attempt <= maxObserveRetries; attempt++) {
      let candidates: ObservedAction[];
      try {
        candidates = await agent.observe(plan.instruction, variables);
      } catch {
        candidates = [];
      }
      if (candidates.length > 0) {
        observed = candidates[0];
        break;
      }
    }

    if (!observed) {
      const proposed: ProposedAction = {
        selector: "",
        description: `Could not locate an element for: ${redact(plan.instruction, secretValues) ?? plan.instruction}`,
        instruction: redact(plan.instruction, secretValues) ?? plan.instruction,
      };
      emit({ type: "observed", step, action: null });
      actionsLog.push({
        step,
        action: proposed,
        risk: { level: "safe", reason: "no target element" },
        decision: "auto",
        outcome: "failed",
        message: freeReplanUsed
          ? "no matching element found"
          : "no matching element found; re-planning once",
      });
      if (!freeReplanUsed) {
        freeReplanUsed = true;
        continue;
      }
      consecutiveFailures++;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        return finalize("error", { message: "repeated failure to locate elements", step });
      }
      continue;
    }

    const proposed = toProposed(observed, plan.instruction, secretValues);
    emit({ type: "observed", step, action: proposed });

    // 3 + 4. Gate. With an allowlist, enforcement is in code: only listed act
    // methods run, anything else blocks fail-closed and the confirm hook is
    // never consulted. Without one, the v1 risk classifier + confirm gate apply.
    let decision: ActionRecord["decision"] = "auto";
    let risk: RiskAssessment;
    if (params.allowedMethods) {
      const method = (observed.method ?? "").toLowerCase();
      const allowed =
        method !== "" && params.allowedMethods.some((m) => m.toLowerCase() === method);
      risk = allowed
        ? { level: "safe", reason: `method "${method}" is allowlisted` }
        : { level: "risky", reason: `method "${method || "(none)"}" is not in the allowlist` };
      emit({ type: "risk", step, assessment: risk });
      if (!allowed) {
        decision = "rejected";
        emit({ type: "decision", step, decision });
        actionsLog.push({ step, action: proposed, risk, decision, outcome: "blocked" });
        return finalize("blocked");
      }
      emit({ type: "decision", step, decision });
    } else {
      risk = classify(proposed);
      emit({ type: "risk", step, assessment: risk });
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
