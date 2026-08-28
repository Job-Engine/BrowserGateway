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
    const p = buildPlanPrompt({
      goal: "Apply for the job",
      variableNames: ["email", "password"],
      history: [record],
    });
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
    const extract = vi
      .fn()
      .mockResolvedValue({ reasoning: "r", isDone: false, instruction: "click Next" });
    const step = await planNextStep(extract, { goal: "g", variableNames: [], history: [] });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0][1]).toBe(planStepSchema);
    expect(step.instruction).toBe("click Next");
    expect(step.isDone).toBe(false);
  });
});
