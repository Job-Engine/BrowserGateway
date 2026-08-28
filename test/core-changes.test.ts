import { describe, it, expect, vi, beforeEach } from "vitest";
import { runLoop } from "../src/loop.js";
import type { BrowserAgent, ObservedAction } from "../src/types.js";
import type { PlanStep } from "../src/planner.js";

/**
 * The four sanctioned agent-core changes from Architecture Review 2.0:
 * sessionId on the port, wall-clock timeout, one free re-plan on observe
 * failure, and a method allowlist replacing the confirm gate.
 */

function makeFakeAgent(opts: {
  plans: PlanStep[];
  observe?: (instruction: string, call: number) => ObservedAction[] | Promise<ObservedAction[]>;
  sessionId?: string;
  hangActMs?: number;
}): { agent: BrowserAgent; acted: ObservedAction[] } {
  const plans = [...opts.plans];
  const acted: ObservedAction[] = [];
  let observeCalls = 0;
  const agent: BrowserAgent = {
    sessionReplayUrl: "https://browserbase.test/sessions/abc-123",
    sessionId: opts.sessionId,
    goto: vi.fn(async () => {}),
    observe: vi.fn(async (instruction: string) => {
      observeCalls++;
      return opts.observe
        ? opts.observe(instruction, observeCalls)
        : [{ selector: "x", description: instruction, method: "click", arguments: [] }];
    }),
    act: vi.fn(async (action: ObservedAction) => {
      if (opts.hangActMs) await new Promise((r) => setTimeout(r, opts.hangActMs));
      acted.push(action);
      return { success: true, message: "ok" };
    }),
    extract: vi.fn(async (_i: string, schema: any) => {
      const shape = schema?.shape ?? {};
      if ("isDone" in shape)
        return plans.shift() ?? { reasoning: "", isDone: true, instruction: "" };
      return {};
    }) as unknown as BrowserAgent["extract"],
    readText: async () => null,
    close: vi.fn(async () => {}),
  };
  return { agent, acted };
}

const base = {
  url: "https://example.com",
  goal: "do the thing",
  variables: {} as Record<string, string>,
  secretValues: [] as string[],
  maxSteps: 25,
  maxObserveRetries: 0,
  maxConsecutiveFailures: 1,
};

describe("method allowlist (replaces the confirm gate for read-only entries)", () => {
  it("executes an allowlisted method without any confirm hook, even for risky-looking text", async () => {
    const hook = vi.fn(async () => false);
    const { agent, acted } = makeFakeAgent({
      plans: [
        { reasoning: "", isDone: false, instruction: "log in" },
        { reasoning: "", isDone: true, instruction: "" },
      ],
      observe: () => [{ selector: "x", description: "Click the Sign in button", method: "click" }],
    });
    const res = await runLoop({
      ...base,
      agent,
      allowedMethods: ["click", "fill"],
      onBeforeAction: hook,
    });
    expect(res.status).toBe("completed");
    expect(acted).toHaveLength(1);
    expect(hook).not.toHaveBeenCalled();
  });

  it("blocks a method outside the allowlist, fail-closed, without calling act", async () => {
    const { agent, acted } = makeFakeAgent({
      plans: [{ reasoning: "", isDone: false, instruction: "upload the file" }],
      observe: () => [{ selector: "x", description: "Upload document", method: "uploadFile" }],
    });
    const res = await runLoop({ ...base, agent, allowedMethods: ["click", "fill"] });
    expect(res.status).toBe("blocked");
    expect(acted).toHaveLength(0);
    expect(res.actionsLog.at(-1)?.decision).toBe("rejected");
    expect(res.actionsLog.at(-1)?.outcome).toBe("blocked");
  });

  it("blocks an action with no method at all (fail closed)", async () => {
    const { agent, acted } = makeFakeAgent({
      plans: [{ reasoning: "", isDone: false, instruction: "do something odd" }],
      observe: () => [{ selector: "x", description: "Mystery control" }],
    });
    const res = await runLoop({ ...base, agent, allowedMethods: ["click"] });
    expect(res.status).toBe("blocked");
    expect(acted).toHaveLength(0);
  });

  it("compares methods case-insensitively", async () => {
    const { agent, acted } = makeFakeAgent({
      plans: [
        { reasoning: "", isDone: false, instruction: "choose an option" },
        { reasoning: "", isDone: true, instruction: "" },
      ],
      observe: () => [{ selector: "x", description: "Pick state", method: "selectOption" }],
    });
    const res = await runLoop({ ...base, agent, allowedMethods: ["selectoption"] });
    expect(res.status).toBe("completed");
    expect(acted).toHaveLength(1);
  });
});

describe("re-plan once on observe failure", () => {
  it("does not count the first observe failure toward consecutive failures", async () => {
    const { agent, acted } = makeFakeAgent({
      plans: [
        { reasoning: "", isDone: false, instruction: "click the missing button" },
        { reasoning: "", isDone: false, instruction: "click the visible button" },
        { reasoning: "", isDone: true, instruction: "" },
      ],
      observe: (_i, call) =>
        call === 1 ? [] : [{ selector: "x", description: "Visible", method: "click" }],
    });
    // maxConsecutiveFailures is 1: without the free re-plan this run errors immediately.
    const res = await runLoop({ ...base, agent, allowedMethods: ["click"] });
    expect(res.status).toBe("completed");
    expect(acted).toHaveLength(1);
  });

  it("still errors when observe keeps failing after the free re-plan", async () => {
    const { agent } = makeFakeAgent({
      plans: Array.from({ length: 5 }, () => ({
        reasoning: "",
        isDone: false,
        instruction: "click the missing button",
      })),
      observe: () => [],
    });
    const res = await runLoop({ ...base, agent, allowedMethods: ["click"] });
    expect(res.status).toBe("error");
    expect(res.error?.message).toMatch(/locate/);
  });
});

// runAgent-level tests: sessionId passthrough and the wall-clock timeout.
const fakeSession: { agent: BrowserAgent | null } = { agent: null };
vi.mock("../src/browser.js", () => ({
  createSession: vi.fn(async () => fakeSession.agent),
}));

import { runAgent } from "../src/index.js";

describe("runAgent core changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the Browserbase session ID from the adapter, not a URL scrape", async () => {
    const { agent } = makeFakeAgent({ plans: [], sessionId: "sess-direct-42" });
    fakeSession.agent = agent;
    const res = await runAgent({ url: "https://x.com", goal: "done immediately" });
    expect(res.sessionId).toBe("sess-direct-42");
  });

  it("stops a run at the wall-clock timeout with status timeout and closes the session", async () => {
    const { agent } = makeFakeAgent({
      plans: Array.from({ length: 50 }, () => ({
        reasoning: "",
        isDone: false,
        instruction: "keep clicking",
      })),
      hangActMs: 5_000,
    });
    fakeSession.agent = agent;
    const res = await runAgent({
      url: "https://x.com",
      goal: "never finishes",
      timeoutMs: 80,
      allowedMethods: ["click"],
    });
    expect(res.status).toBe("timeout");
    expect(res.success).toBe(false);
    expect(res.error?.message).toMatch(/timeout/i);
    expect(agent.close).toHaveBeenCalled();
  });

  it("does not time out a run that finishes in budget", async () => {
    const { agent } = makeFakeAgent({ plans: [], sessionId: "s" });
    fakeSession.agent = agent;
    const res = await runAgent({ url: "https://x.com", goal: "quick", timeoutMs: 5_000 });
    expect(res.status).toBe("completed");
  });
});
