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
    }) as unknown as BrowserAgent["extract"], // cast: vi.fn can't express the generic extract<T> signature
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
