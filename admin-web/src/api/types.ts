// Shapes returned by the gateway admin API (src/gateway/api/admin.ts) and the
// caller API (src/gateway/api/app.ts). Kept in sync by hand; the envelope shape
// mirrors src/gateway/types.ts.

export type JobStatus = "success" | "failure" | "error";
export type JobState = "QUEUED" | "RUNNING" | "DONE";

export interface JobError {
  code: string;
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
  status: JobStatus;
  data?: unknown;
  error?: JobError;
  meta: JobMeta;
}

export interface JobRow {
  id: string;
  useCase: string;
  client: string;
  platform: string;
  input: unknown;
  callerId: string;
  state: JobState;
  envelope: JobEnvelope | null;
  idempotencyKey: string | null;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface StatsResponse {
  jobs: Record<JobState, number>;
}

export interface JobsResponse {
  jobs: JobRow[];
}

/** Action lifecycle is per useCase; client lifecycle is per useCase-client pair. */
export type ActionState = "draft" | "validated";
export type ClientState = "disabled" | "tested" | "live";

export interface CataloguePair {
  useCase: string;
  platform: string;
  actionState: ActionState;
  client: string;
  clientState: ClientState;
  testJobId: string | null;
  lastCanaryAt: string | null;
  lastCanaryStatus: string | null;
}

export interface CatalogueResponse {
  pairs: CataloguePair[];
}

export interface Caller {
  id: string;
  name: string;
  scopes: string[];
  isAdmin: boolean;
  disabled: boolean;
  createdAt: string;
}

export interface CallersResponse {
  callers: Caller[];
}

export interface IssueTokenResponse {
  caller: { id: string; name: string; scopes: string[]; isAdmin: boolean };
  token: string;
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  entity: string;
  detail: unknown;
  createdAt: string;
}

export interface AuditResponse {
  entries: AuditEntry[];
}

export interface RunCanariesResponse {
  enqueued: string[];
}

/** Lint/lifecycle transition results. */
export interface OkResult {
  ok: true;
}
export interface ValidateFailure {
  ok: false;
  problems: string[];
}
export interface TransitionFailure {
  ok: false;
  reason: string;
}

/** Machine-readable caller catalogue (GET /catalogue), used by Docs. */
export interface CatalogueAction {
  useCase: string;
  platform: string;
  clients: string[];
  inputSchema: unknown;
  extractSchema: unknown;
  requiresLogin: boolean;
}

export interface CallerCatalogueResponse {
  useCases: string[];
  actions: CatalogueAction[];
}
