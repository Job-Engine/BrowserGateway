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
