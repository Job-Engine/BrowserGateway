import { runAgent, autoApprove } from "../index.js";
import type { CatalogueEntry } from "./catalogue.js";
import { resolvePortalCredentials } from "./secrets.js";
import type { JobEnvelope, JobError, JobStatus } from "./types.js";

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
  entry: CatalogueEntry,
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
  }): JobEnvelope => ({
    jobId,
    useCase: entry.useCase,
    status: extra?.status ?? "error",
    data: extra?.data,
    error: extra?.error,
    meta: {
      sessionId: extra?.sessionId ?? sessionIdFromUrl(extra?.sessionUrl),
      sessionReplayUrl: extra?.sessionUrl,
      ranAt,
      durationMs: Date.now() - startedAt,
      attempts: 1,
    },
  });

  // 1. Validate caller input.
  const parsed = entry.inputSchema.safeParse(rawInput);
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

  // 2. Resolve credentials just-in-time (never logged, redacted downstream).
  let credentials: Record<string, string> = {};
  if (entry.requiresLogin) {
    try {
      const creds = await resolvePortalCredentials(entry.portalKey, { withOtp: true });
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
  //    autoApprove: headless service, so risky steps (login submit) are auto-approved.
  //    The catalogue goals are read-only after login; tighten per-entry if needed.
  //    M1: the OTP step follows the resolved credential, not any input field.
  const result = await runAgent({
    url: entry.url,
    goal: entry.buildGoal(input, { hasOtp: Boolean(credentials.otp) }),
    data: input,
    credentials,
    extractSchema: entry.extractSchema,
    onBeforeAction: autoApprove,
  });

  const sessionUrl = result.sessionReplayUrl;
  const extracted = result.extractedData;

  // 4. Normalize outcome.
  if (result.status === "error") {
    return base({
      status: "error",
      sessionUrl,
      error: { code: "RUN_ERROR", message: result.error?.message ?? result.summary },
    });
  }
  if (result.status === "blocked") {
    return base({
      status: "error",
      sessionUrl,
      error: { code: "ACTION_BLOCKED", message: "A risky action was not approved." },
    });
  }

  // Generic negative-outcome signals (present for portals that extract them).
  const matchVerified = boolField(extracted, "matchVerified");
  const ntpDateFound = boolField(extracted, "ntpDateFound");
  if (matchVerified === false) {
    return base({
      status: "failure",
      sessionUrl,
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
    data: extracted,
    error: result.success ? undefined : { code: "GOAL_NOT_COMPLETED", message: result.summary },
  });
}
