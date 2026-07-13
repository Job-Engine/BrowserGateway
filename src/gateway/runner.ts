import { runAgent } from "../index.js";
import { READ_ONLY_METHODS } from "../types.js";
import type { ResolvedAction } from "./catalogue.js";
import { resolvePortalCredentials } from "./secrets.js";
import type { JobEnvelope, JobError, JobStatus } from "./types.js";

/** Default per-run wall-clock budget; a client override (timeoutMs) wins. */
const RUN_TIMEOUT_MS = 300_000;

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

  // 3. Drive the browser (self-hosted Stagehand via the web-action-agent loop).
  //    Read-only is enforced in code: only allowlisted act methods may run (S3).
  //    M1: the OTP step follows the resolved credential, not any input field.
  const result = await runAgent({
    url: action.url,
    goal: action.buildGoal(input, { hasOtp: Boolean(credentials.otp) }),
    data: input,
    credentials,
    extractSchema: action.extractSchema,
    allowedMethods: READ_ONLY_METHODS,
    timeoutMs: action.timeoutMs ?? RUN_TIMEOUT_MS,
  });

  const sessionUrl = result.sessionReplayUrl;
  const sessionId = result.sessionId;
  const extracted = result.extractedData;

  // 4. Normalize outcome.
  if (result.status === "error") {
    return base({
      status: "error",
      sessionUrl,
      sessionId,
      stepsUsed: result.stepsUsed,
      error: { code: "RUN_ERROR", message: result.error?.message ?? result.summary },
    });
  }
  if (result.status === "timeout") {
    return base({
      status: "error",
      sessionUrl,
      sessionId,
      stepsUsed: result.stepsUsed,
      error: { code: "TIMEOUT", message: "The run exceeded its wall-clock timeout." },
    });
  }
  if (result.status === "blocked") {
    return base({
      status: "error",
      sessionUrl,
      sessionId,
      stepsUsed: result.stepsUsed,
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
    data: extracted,
    error: result.success ? undefined : { code: "GOAL_NOT_COMPLETED", message: result.summary },
  });
}
