// Typed client for the Browser Automation Gateway. Semver; envelope changes
// are additive only. The error-code enum mirrors the server's closed set and
// is parity-checked by the gateway's test suite.

export const ERROR_CODES = [
  "INVALID_INPUT",
  "AUTH_UNAVAILABLE",
  "RUN_ERROR",
  "ACTION_BLOCKED",
  "TIMEOUT",
  "MATCH_FAILED",
  "NTP_FIELD_NOT_FOUND",
  "GOAL_NOT_COMPLETED",
  "GATEWAY_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type JobStatus = "success" | "failure" | "error";
export type JobState = "QUEUED" | "RUNNING" | "DONE";

export interface JobError {
  code: ErrorCode | (string & {});
  message: string;
  fields?: string[];
}

export interface JobMeta {
  sessionId?: string;
  sessionReplayUrl?: string;
  ranAt: string;
  durationMs: number;
  attempts: number;
  stepsUsed?: number;
}

export interface JobEnvelope {
  jobId: string;
  useCase: string;
  client?: string;
  /** success: automate on it. failure: clean negative answer, automate on it. error: alert. */
  status: JobStatus;
  data?: unknown;
  error?: JobError;
  meta: JobMeta;
}

export interface SubmitJobParams {
  useCase: string;
  client?: string;
  input: unknown;
  /** Reuse across retries; the gateway returns the same job instead of duplicating work. */
  idempotencyKey?: string;
}

export interface WaitOptions {
  /** Initial poll interval; doubles up to maxPollIntervalMs. */
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  /** Give up waiting after this long. The job itself keeps running. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export interface GatewayClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export class GatewayClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GatewayClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const body = await res.json().catch(() => undefined);
    if (!res.ok) {
      const message =
        body && typeof body === "object" && "error" in body
          ? String((body as { error: unknown }).error)
          : `${res.status} ${res.statusText}`;
      throw new GatewayError(message, res.status, body);
    }
    return body as T;
  }

  /** Machine-readable catalogue: useCases, input schemas, client rosters. */
  getCatalogue(): Promise<{ useCases: string[]; actions: unknown[] }> {
    return this.request("/catalogue");
  }

  /** Submit a job. Returns 202 immediately; poll with waitForResult. */
  submitJob(params: SubmitJobParams): Promise<{ jobId: string; state: JobState }> {
    return this.request("/jobs", { method: "POST", body: JSON.stringify(params) });
  }

  getJob(jobId: string): Promise<{ jobId: string; state: JobState; envelope?: JobEnvelope }> {
    return this.request(`/jobs/${jobId}`);
  }

  /** Poll with backoff until the job is DONE, then return its envelope. */
  async waitForResult(jobId: string, options: WaitOptions = {}): Promise<JobEnvelope> {
    const start = Date.now();
    const timeoutMs = options.timeoutMs ?? 6 * 60_000;
    let interval = options.pollIntervalMs ?? 1_000;
    const maxInterval = options.maxPollIntervalMs ?? 10_000;
    for (;;) {
      if (options.signal?.aborted) throw new Error("waitForResult aborted");
      const job = await this.getJob(jobId);
      if (job.state === "DONE" && job.envelope) return job.envelope;
      if (Date.now() - start > timeoutMs) {
        throw new GatewayError(`job ${jobId} still ${job.state} after ${timeoutMs}ms`, 408);
      }
      await new Promise((r) => setTimeout(r, interval));
      interval = Math.min(interval * 2, maxInterval);
    }
  }

  /** Convenience: submit and wait in one call. */
  async run(params: SubmitJobParams, options?: WaitOptions): Promise<JobEnvelope> {
    const { jobId } = await this.submitJob(params);
    return this.waitForResult(jobId, options);
  }
}
