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
