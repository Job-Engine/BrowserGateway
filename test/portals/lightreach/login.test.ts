import { describe, expect, it, vi } from "vitest";
import { loginLightreach } from "../../../src/portals/lightreach/login.js";

// The live browser login (browserbaseConnect) is validated end-to-end in recon
// pass 5 (out of band). Here we lock the wrapper contract via the injected
// `connect` seam: capturedAt comes from the injected clock, and the session is
// always closed.
describe("loginLightreach (wrapper contract)", () => {
  it("stamps capturedAt from the injected clock and closes the session", async () => {
    const close = vi.fn(async () => {});
    const session = await loginLightreach({
      username: "u",
      password: "p",
      now: () => 42,
      connect: async () => ({ cookieHeader: "jar-abc", close }),
    });
    expect(session).toEqual({ cookieHeader: "jar-abc", capturedAt: 42 });
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the session even if capturing throws downstream", async () => {
    const close = vi.fn(async () => {});
    await loginLightreach({
      username: "u",
      password: "p",
      now: () => {
        throw new Error("clock boom");
      },
      connect: async () => ({ cookieHeader: "jar", close }),
    }).catch(() => {});
    expect(close).toHaveBeenCalledOnce();
  });
});
