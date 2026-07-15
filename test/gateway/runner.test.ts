import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortalCredentials } from "../../src/gateway/secrets.js";
import type { TraceRow, TraceStore } from "../../src/gateway/traces.js";

/**
 * Runner tests: the OTP goal decision is wired from the resolved credential
 * (M1), and outcomes map onto the three-outcome envelope.
 */

const mocks = vi.hoisted(() => ({
  resolvePortalCredentials: vi.fn(),
}));

const runDeterministicMock = vi.hoisted(() => vi.fn());

vi.mock("../../src/gateway/secrets.js", () => ({
  resolvePortalCredentials: mocks.resolvePortalCredentials,
}));

vi.mock("../../src/replay.js", () => ({
  runDeterministic: runDeterministicMock,
}));

import { runJob } from "../../src/gateway/runner.js";
import { resolveAction } from "../../src/gateway/catalogue.js";

const entry = resolveAction("lightreach.ntpDate", "default");
const validInput = { name: "Jane Homeowner", address: "123 Solar Way, Austin TX 78701" };

function agentSuccess(extracted: Record<string, unknown>) {
  return {
    mode: "learned",
    status: "completed",
    success: true,
    summary: "done",
    data: extracted,
    actionsLog: [],
    stepsUsed: 1,
    sessionReplayUrl: "https://browserbase.com/sessions/abc-123",
    traceDraft: null,
  };
}

beforeEach(() => {
  mocks.resolvePortalCredentials.mockReset();
  runDeterministicMock.mockReset();
  runDeterministicMock.mockResolvedValue(
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

    await runJob("job-1", entry, validInput);

    const options = runDeterministicMock.mock.calls[0][0];
    expect(options.goal).toContain("%otp%");
    expect(options.credentials).toMatchObject({ username: "u", password: "p", otp: "123456" });
  });

  it("omits the OTP goal text when the credential has none, even with projectId", async () => {
    mocks.resolvePortalCredentials.mockResolvedValue({ username: "u", password: "p" });

    await runJob("job-2", entry, { ...validInput, projectId: "LR-123" });

    const options = runDeterministicMock.mock.calls[0][0];
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
    const envelope = await runJob("job-wl", action, validInput);
    expect(mocks.resolvePortalCredentials).toHaveBeenCalledWith("lightreach.lgcyco", {
      withOtp: true,
    });
    expect(envelope.client).toBe("lgcyco");
    expect(envelope.useCase).toBe("lightreach.ntpDate");
  });

  it("passes the client timeout override through to runDeterministic", async () => {
    const action = { ...resolveAction("lightreach.ntpDate", "lgcyco"), timeoutMs: 45_000 };
    await runJob("job-wl-2", action, validInput);
    expect(runDeterministicMock.mock.calls[0][0].timeoutMs).toBe(45_000);
  });
});

describe("runJob envelope mapping", () => {
  beforeEach(() => {
    mocks.resolvePortalCredentials.mockResolvedValue({ username: "u", password: "p" });
  });

  it("maps a verified extraction to success with session metadata", async () => {
    const envelope = await runJob("job-3", entry, validInput);
    expect(envelope.status).toBe("success");
    expect(envelope.client).toBe("default");
    expect(envelope.meta.sessionId).toBe("abc-123");
    expect(envelope.meta.sessionReplayUrl).toContain("sessions/abc-123");
  });

  it("maps matchVerified=false to a clean failure with MATCH_FAILED", async () => {
    runDeterministicMock.mockResolvedValue(
      agentSuccess({ matchVerified: false, ntpDateFound: false, ntpDate: null }),
    );
    const envelope = await runJob("job-4", entry, validInput);
    expect(envelope.status).toBe("failure");
    expect(envelope.error?.code).toBe("MATCH_FAILED");
  });

  it("maps invalid input to an error envelope without running the agent", async () => {
    const envelope = await runJob("job-5", entry, { name: "" });
    expect(envelope.status).toBe("error");
    expect(envelope.error?.code).toBe("INVALID_INPUT");
    expect(runDeterministicMock).not.toHaveBeenCalled();
  });

  it("maps credential resolution failure to AUTH_UNAVAILABLE", async () => {
    mocks.resolvePortalCredentials.mockRejectedValue(new Error("No credentials for portal"));
    const envelope = await runJob("job-6", entry, validInput);
    expect(envelope.status).toBe("error");
    expect(envelope.error?.code).toBe("AUTH_UNAVAILABLE");
  });
});

function fakeTraces(active: TraceRow | null): {
  store: TraceStore;
  calls: { saved: unknown[]; successes: string[] };
} {
  const calls = { saved: [] as unknown[], successes: [] as string[] };
  const store = {
    saveTrace: vi.fn(async (opts: unknown) => {
      calls.saved.push(opts);
      return {
        ...(active ?? ({} as TraceRow)),
        id: "new",
        version: (active?.version ?? 0) + 1,
        state: "active",
      } as TraceRow;
    }),
    getActive: vi.fn(async () => active),
    recordSuccess: vi.fn(async (id: string) => {
      calls.successes.push(id);
    }),
    invalidate: vi.fn(async () => true),
    list: vi.fn(async () => []),
  } as unknown as TraceStore;
  return { store, calls };
}

const ACTIVE_TRACE: TraceRow = {
  id: "trace-1",
  useCase: "lightreach.ntpDate",
  client: "spartan",
  version: 3,
  state: "active",
  steps: [],
  readSelectors: {},
  recordedFromJobId: null,
  healCount: 0,
  lastSuccessAt: null,
  createdAt: new Date().toISOString(),
};

describe("runJob with traces", () => {
  beforeEach(() => {
    mocks.resolvePortalCredentials.mockResolvedValue({ username: "u", password: "p" });
  });

  it("uses replay mode metadata on a replay success", async () => {
    runDeterministicMock.mockResolvedValueOnce({
      mode: "replay",
      status: "completed",
      success: true,
      data: {
        matchVerified: true,
        matchedName: "n",
        matchedAddress: "a",
        ntpDateFound: true,
        ntpDate: null,
      },
      actionsLog: [],
      stepsUsed: 5,
      summary: "replayed",
      traceDraft: null,
    });
    const { store, calls } = fakeTraces(ACTIVE_TRACE);
    const envelope = await runJob(
      "job-1",
      resolveAction("lightreach.ntpDate", "spartan"),
      validInput,
      { traces: store },
    );
    expect(envelope.status).toBe("success");
    expect(envelope.meta.mode).toBe("replay");
    expect(envelope.meta.traceVersion).toBe(3);
    expect(calls.successes).toEqual(["trace-1"]);
  });

  it("records a trace after a learn run and reports mode learned", async () => {
    runDeterministicMock.mockResolvedValueOnce({
      mode: "learned",
      status: "completed",
      success: true,
      data: {
        matchVerified: true,
        matchedName: "n",
        matchedAddress: "a",
        ntpDateFound: true,
        ntpDate: "Jul 11, 2026",
      },
      actionsLog: [],
      stepsUsed: 6,
      summary: "learned",
      traceDraft: { steps: [], readSelectors: { matchedName: "xpath=//h1" }, complete: true },
    });
    const { store, calls } = fakeTraces(null);
    const envelope = await runJob(
      "job-2",
      resolveAction("lightreach.ntpDate", "spartan"),
      validInput,
      { traces: store },
    );
    expect(envelope.meta.mode).toBe("learned");
    expect(calls.saved).toHaveLength(1);
    expect((calls.saved[0] as { activate: boolean }).activate).toBe(true);
  });

  it("reports mode healed when replay escalated inside the run", async () => {
    runDeterministicMock.mockResolvedValueOnce({
      mode: "learned",
      status: "completed",
      success: true,
      data: {
        matchVerified: true,
        matchedName: "n",
        matchedAddress: "a",
        ntpDateFound: true,
        ntpDate: null,
      },
      actionsLog: [],
      stepsUsed: 6,
      summary: "healed",
      traceDraft: { steps: [], readSelectors: {}, complete: true },
      replayFailureReason: "verification mismatch on matchedName",
    });
    const { store, calls } = fakeTraces(ACTIVE_TRACE);
    const audit = vi.fn(async () => {});
    const envelope = await runJob(
      "job-3",
      resolveAction("lightreach.ntpDate", "spartan"),
      validInput,
      { traces: store, audit },
    );
    expect(envelope.meta.mode).toBe("healed");
    expect((calls.saved[0] as { healed?: boolean }).healed).toBe(true);
    expect(audit).toHaveBeenCalledWith(
      "trace.healed",
      "lightreach.ntpDate/spartan",
      expect.anything(),
    );
  });

  it("does not save a trace when the draft is incomplete", async () => {
    runDeterministicMock.mockResolvedValueOnce({
      mode: "learned",
      status: "completed",
      success: true,
      data: {
        matchVerified: true,
        matchedName: "n",
        matchedAddress: "a",
        ntpDateFound: true,
        ntpDate: null,
      },
      actionsLog: [],
      stepsUsed: 6,
      summary: "learned",
      traceDraft: { steps: [], readSelectors: {}, complete: false },
    });
    const { store, calls } = fakeTraces(null);
    await runJob("job-4", resolveAction("lightreach.ntpDate", "spartan"), validInput, {
      traces: store,
    });
    expect(calls.saved).toHaveLength(1);
    expect((calls.saved[0] as { activate: boolean }).activate).toBe(false);
  });
});
