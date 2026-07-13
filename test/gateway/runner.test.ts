import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalCredentials } from "../../src/gateway/secrets.js";

/**
 * Runner tests: the OTP goal decision is wired from the resolved credential
 * (M1), and outcomes map onto the three-outcome envelope.
 */

const mocks = vi.hoisted(() => ({
  resolvePortalCredentials: vi.fn(),
  runAgent: vi.fn(),
}));

vi.mock("../../src/gateway/secrets.js", () => ({
  resolvePortalCredentials: mocks.resolvePortalCredentials,
}));

vi.mock("../../src/index.js", () => ({
  runAgent: mocks.runAgent,
  autoApprove: () => Promise.resolve(true),
}));

import { runJob } from "../../src/gateway/runner.js";
import { resolveAction } from "../../src/gateway/catalogue.js";

const entry = resolveAction("lightreach.ntpDate", "default");
const input = { name: "Jane Homeowner", address: "123 Solar Way, Austin TX 78701" };

function agentSuccess(extracted: Record<string, unknown>) {
  return {
    status: "completed",
    success: true,
    summary: "done",
    extractedData: extracted,
    sessionReplayUrl: "https://browserbase.com/sessions/abc-123",
  };
}

beforeEach(() => {
  mocks.resolvePortalCredentials.mockReset();
  mocks.runAgent.mockReset();
  mocks.runAgent.mockResolvedValue(
    agentSuccess({
      matchVerified: true,
      matchedName: "Jane Homeowner",
      matchedAddress: "123 Solar Way",
      ntpDateFound: true,
      ntpDate: "2026-06-30",
    }),
  );
});

describe("runJob OTP wiring (M1)", () => {
  it("passes an OTP goal and credential when the portal item has one", async () => {
    const creds: PortalCredentials = { username: "u", password: "p", otp: "123456" };
    mocks.resolvePortalCredentials.mockResolvedValue(creds);

    await runJob("job-1", entry, input);

    const options = mocks.runAgent.mock.calls[0][0];
    expect(options.goal).toContain("%otp%");
    expect(options.credentials).toMatchObject({ username: "u", password: "p", otp: "123456" });
  });

  it("omits the OTP goal text when the credential has none, even with projectId", async () => {
    mocks.resolvePortalCredentials.mockResolvedValue({ username: "u", password: "p" });

    await runJob("job-2", entry, { ...input, projectId: "LR-123" });

    const options = mocks.runAgent.mock.calls[0][0];
    expect(options.goal).not.toContain("%otp%");
    expect(options.credentials).not.toHaveProperty("otp");
  });
});

describe("runJob whitelabel wiring (WL)", () => {
  beforeEach(() => {
    mocks.resolvePortalCredentials.mockResolvedValue({ username: "u", password: "p" });
  });

  it("resolves the platform.client credential item and echoes client in the envelope", async () => {
    const action = resolveAction("lightreach.ntpDate", "lgcyco");
    const envelope = await runJob("job-wl", action, input);
    expect(mocks.resolvePortalCredentials).toHaveBeenCalledWith("lightreach.lgcyco", {
      withOtp: true,
    });
    expect(envelope.client).toBe("lgcyco");
    expect(envelope.useCase).toBe("lightreach.ntpDate");
  });

  it("passes the client timeout override through to runAgent", async () => {
    const action = { ...resolveAction("lightreach.ntpDate", "lgcyco"), timeoutMs: 45_000 };
    await runJob("job-wl-2", action, input);
    expect(mocks.runAgent.mock.calls[0][0].timeoutMs).toBe(45_000);
  });
});

describe("runJob envelope mapping", () => {
  beforeEach(() => {
    mocks.resolvePortalCredentials.mockResolvedValue({ username: "u", password: "p" });
  });

  it("maps a verified extraction to success with session metadata", async () => {
    const envelope = await runJob("job-3", entry, input);
    expect(envelope.status).toBe("success");
    expect(envelope.client).toBe("default");
    expect(envelope.meta.sessionId).toBe("abc-123");
    expect(envelope.meta.sessionReplayUrl).toContain("sessions/abc-123");
  });

  it("maps matchVerified=false to a clean failure with MATCH_FAILED", async () => {
    mocks.runAgent.mockResolvedValue(
      agentSuccess({ matchVerified: false, ntpDateFound: false, ntpDate: null }),
    );
    const envelope = await runJob("job-4", entry, input);
    expect(envelope.status).toBe("failure");
    expect(envelope.error?.code).toBe("MATCH_FAILED");
  });

  it("maps invalid input to an error envelope without running the agent", async () => {
    const envelope = await runJob("job-5", entry, { name: "" });
    expect(envelope.status).toBe("error");
    expect(envelope.error?.code).toBe("INVALID_INPUT");
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("maps credential resolution failure to AUTH_UNAVAILABLE", async () => {
    mocks.resolvePortalCredentials.mockRejectedValue(new Error("No credentials for portal"));
    const envelope = await runJob("job-6", entry, input);
    expect(envelope.status).toBe("error");
    expect(envelope.error?.code).toBe("AUTH_UNAVAILABLE");
  });
});
