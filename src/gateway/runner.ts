import { runDeterministic } from "../replay.js";
import { READ_ONLY_METHODS } from "../types.js";
import type { ResolvedAction } from "./catalogue.js";
import { resolvePortalCredentials } from "./secrets.js";
import type { JobEnvelope, JobError, JobMeta, JobStatus } from "./types.js";
import type { TraceStore } from "./traces.js";

/** Default per-run wall-clock budget; a client override (timeoutMs) wins. */
const RUN_TIMEOUT_MS = 300_000;

export interface RunnerDeps {
  traces?: TraceStore;
  audit?: (action: string, entity: string, detail?: unknown) => Promise<void>;
}

function sessionIdFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const m = url.match(/sessions\/([a-f0-9-]+)/i);
  return m?.[1];
}

/** Best-effort read of a boolean field from the extracted data. */
function boolField(data: unknown, key: string): boolean | undefined {
  if (data && typeof data === "object" && key in data) {
    const v = (data as Record<string, unknown>)[key];
    if (typeof v === "boolean") return v;
  }
  return undefined;
}

/**
 * Run one catalogue use case for one input and normalize to a JobEnvelope.
 * Never throws for business outcomes; only re-throws nothing (all captured).
 */
export async function runJob(
  jobId: string,
  action: ResolvedAction,
  rawInput: unknown,
  deps: RunnerDeps = {},
): Promise<JobEnvelope> {
  const startedAt = Date.now();
  const ranAt = new Date(startedAt).toISOString();

  const base = (extra?: {
    status: JobStatus;
    data?: unknown;
    error?: JobError;
    sessionUrl?: string;
    sessionId?: string;
    stepsUsed?: number;
    mode?: JobMeta["mode"];
    traceVersion?: number;
  }): JobEnvelope => ({
    jobId,
    useCase: action.useCase,
    client: action.client,
    status: extra?.status ?? "error",
    data: extra?.data,
    error: extra?.error,
    meta: {
      sessionId: extra?.sessionId ?? sessionIdFromUrl(extra?.sessionUrl),
      sessionReplayUrl: extra?.sessionUrl,
      ranAt,
      durationMs: Date.now() - startedAt,
      attempts: 1,
      stepsUsed: extra?.stepsUsed,
      mode: extra?.mode,
      traceVersion: extra?.traceVersion,
    },
  });

  // 1. Validate caller input.
  const parsed = action.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return base({
      status: "error",
      error: {
        code: "INVALID_INPUT",
        message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        fields: parsed.error.issues.map((i) => i.path.join(".")),
      },
    });
  }
  const input = parsed.data as Record<string, string>;

  // 2. Resolve this platform-and-client's credentials just in time (WL:
  //    one 1Password item per platform.client pair).
  let credentials: Record<string, string> = {};
  if (action.requiresLogin) {
    try {
      const creds = await resolvePortalCredentials(action.credentialItem, { withOtp: true });
      credentials = { username: creds.username, password: creds.password };
      if (creds.otp) credentials.otp = creds.otp;
    } catch (e) {
      return base({
        status: "error",
        error: { code: "AUTH_UNAVAILABLE", message: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  // 3. Deterministic replay when an active trace exists; LLM learn otherwise.
  //    Read-only stays code-enforced on both paths (S3).
  const timeoutMs = action.timeoutMs ?? RUN_TIMEOUT_MS;
  const activeTrace =
    deps.traces && action.replay
      ? await deps.traces.getActive(action.useCase, action.client)
      : null;

  const result = await runDeterministic({
    url: action.url,
    goal: action.buildGoal(input, { hasOtp: Boolean(credentials.otp) }),
    input,
    credentials,
    extractSchema: action.extractSchema,
    allowedMethods: READ_ONLY_METHODS,
    timeoutMs,
    replayPlan: action.replay,
    trace: activeTrace
      ? { steps: activeTrace.steps, readSelectors: activeTrace.readSelectors }
      : undefined,
  });

  const mode: NonNullable<JobMeta["mode"]> =
    result.mode === "replay" ? "replay" : result.replayFailureReason ? "healed" : "learned";
  let traceVersion = result.mode === "replay" ? activeTrace?.version : undefined;

  // 4. Trace bookkeeping (best effort; never fails the job).
  if (deps.traces) {
    try {
      if (result.mode === "replay" && result.success && activeTrace) {
        await deps.traces.recordSuccess(activeTrace.id);
      } else if (result.success && result.traceDraft) {
        const saved = await deps.traces.saveTrace({
          useCase: action.useCase,
          client: action.client,
          steps: result.traceDraft.steps,
          readSelectors: result.traceDraft.readSelectors,
          recordedFromJobId: jobId,
          activate: result.traceDraft.complete,
          healed: mode === "healed",
          secretValues: Object.values(credentials).filter((v) => v.length > 0),
        });
        traceVersion = saved.version;
        await deps.audit?.(
          mode === "healed" ? "trace.healed" : "trace.recorded",
          `${action.useCase}/${action.client}`,
          {
            version: saved.version,
            activated: result.traceDraft.complete,
            reason: result.replayFailureReason,
          },
        );
      }
    } catch {
      // Trace persistence is an optimization; the envelope is already decided.
    }
  }

  const sessionUrl = result.sessionReplayUrl;
  const sessionId = result.sessionId;
  const extracted = result.data;

  // 5. Normalize outcome.
  if (result.status === "error") {
    return base({
      status: "error",
      sessionUrl,
      sessionId,
      stepsUsed: result.stepsUsed,
      mode,
      traceVersion,
      error: { code: "RUN_ERROR", message: result.error?.message ?? result.summary },
    });
  }
  if (result.status === "timeout") {
    return base({
      status: "error",
      sessionUrl,
      sessionId,
      stepsUsed: result.stepsUsed,
      mode,
      traceVersion,
      error: { code: "TIMEOUT", message: "The run exceeded its wall-clock timeout." },
    });
  }
  if (result.status === "blocked") {
    return base({
      status: "error",
      sessionUrl,
      sessionId,
      stepsUsed: result.stepsUsed,
      mode,
      traceVersion,
      error: {
        code: "ACTION_BLOCKED",
        message: "An action outside the read-only method allowlist was blocked.",
      },
    });
  }

  // Generic negative-outcome signals (present for portals that extract them).
  const matchVerified = boolField(extracted, "matchVerified");
  const ntpDateFound = boolField(extracted, "ntpDateFound");
  if (matchVerified === false) {
    return base({
      status: "failure",
      sessionUrl,
      sessionId,
      stepsUsed: result.stepsUsed,
      mode,
      traceVersion,
      data: extracted,
      error: {
        code: "MATCH_FAILED",
        message: "No record matched on name and address.",
        fields: ["name", "address"],
      },
    });
  }
  if (ntpDateFound === false) {
    return base({
      status: "failure",
      sessionUrl,
      sessionId,
      stepsUsed: result.stepsUsed,
      mode,
      traceVersion,
      data: extracted,
      error: {
        code: "NTP_FIELD_NOT_FOUND",
        message: "NTP Date field was not found on the record.",
        fields: ["ntpDate"],
      },
    });
  }

  return base({
    status: result.success ? "success" : "failure",
    sessionUrl,
    sessionId,
    stepsUsed: result.stepsUsed,
    mode,
    traceVersion,
    data: extracted,
    error: result.success ? undefined : { code: "GOAL_NOT_COMPLETED", message: result.summary },
  });
}
