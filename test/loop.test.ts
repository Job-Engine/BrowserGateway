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
