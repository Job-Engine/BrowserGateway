/** Public contract returned to callers. Stable across every portal. */
export type JobStatus = "success" | "failure" | "error";

export interface JobError {
  /** Machine-readable code, e.g. AUTH_REQUIRED, MATCH_FAILED, NTP_FIELD_NOT_FOUND. */
  code: string;
  message: string;
  /** Which input/result fields the error relates to, if any. */
  fields?: string[];
}

export interface JobMeta {
  sessionId?: string;
  sessionReplayUrl?: string;
  ranAt: string;
  durationMs: number;
  attempts: number;
}

export interface JobEnvelope {
  jobId: string;
  useCase: string;
  /** Whitelabel client identity this job ran as. Additive; absent in v1 envelopes. */
  client?: string;
  /** success = goal met; failure = ran cleanly but negative outcome; error = system/auth/nav problem. */
  status: JobStatus;
  data?: unknown;
  error?: JobError;
  meta: JobMeta;
}

/** Internal run state tracked by the server for async polling. */
export type RunState = "PENDING" | "RUNNING" | "DONE";

export interface JobRecord {
  jobId: string;
  useCase: string;
  state: RunState;
  createdAt: string;
  envelope?: JobEnvelope;
}
