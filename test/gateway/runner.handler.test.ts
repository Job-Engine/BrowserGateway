import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedAction } from "../../src/gateway/catalogue.js";
import { runJob } from "../../src/gateway/runner.js";

// A code-action ResolvedAction with a handler and no login (so no op/DB needed).
function codeAction(over: Partial<ResolvedAction> = {}): ResolvedAction {
  return {
    useCase: "demo.code",
    portalKey: "demo",
    client: "spartan",
    url: "https://example.test",
    inputSchema: z.object({ accountIds: z.array(z.string()).min(1) }),
    extractSchema: z.object({ ok: z.boolean() }),
    requiresLogin: false,
    credentialItem: "demo.spartan",
    buildGoal: () => "code-action; no goal",
    ...over,
  };
}

describe("runJob — code-action handler branch", () => {
  it("runs the handler and wraps its output as a success envelope, skipping the LLM path", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const env = await runJob("job-1", codeAction({ handler }), { accountIds: ["a"] });
    expect(handler).toHaveBeenCalledOnce();
    expect(env.status).toBe("success");
    expect(env.data).toEqual({ ok: true });
    expect(env.meta.mode).toBeUndefined(); // no replay/learn/heal on a code action
  });

  it("passes the validated input and client to the handler", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    await runJob("job-2", codeAction({ handler }), { accountIds: ["x", "y"] });
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ input: { accountIds: ["x", "y"] }, client: "spartan" }),
    );
  });

  it("returns GATEWAY_ERROR when the handler output fails the extract schema", async () => {
    const handler = vi.fn(async () => ({ ok: "not-a-boolean" }));
    const env = await runJob("job-3", codeAction({ handler }), { accountIds: ["a"] });
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("GATEWAY_ERROR");
  });

  it("maps a thrown handler error to a RUN_ERROR envelope (retriable)", async () => {
    const handler = vi.fn(async () => {
      throw new Error("browser session died");
    });
    const env = await runJob("job-4", codeAction({ handler }), { accountIds: ["a"] });
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("RUN_ERROR");
    expect(env.error?.message).toMatch(/browser session died/);
  });

  it("still rejects invalid input before reaching the handler", async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const env = await runJob("job-5", codeAction({ handler }), { accountIds: [] });
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("INVALID_INPUT");
    expect(handler).not.toHaveBeenCalled();
  });
});
