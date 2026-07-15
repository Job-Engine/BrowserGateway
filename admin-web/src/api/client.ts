// Thin typed fetch layer over the gateway. Every admin call carries the bearer
// token from config. In dev, requests to a localhost gateway are sent as
// same-origin relative paths so Vite's proxy handles them and CORS never bites.
import type { GatewayConfig } from "../lib/config";
import type {
  AuditResponse,
  CallerCatalogueResponse,
  CallersResponse,
  CatalogueResponse,
  IssueTokenResponse,
  JobRow,
  JobsResponse,
  OkResult,
  RunCanariesResponse,
  StatsResponse,
  TraceSummary,
  TransitionFailure,
  ValidateFailure,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function resolveBase(baseUrl: string): string {
  if (import.meta.env.DEV) {
    try {
      const url = new URL(baseUrl);
      if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return "";
    } catch {
      // Relative base URL: use as-is (also proxied in dev).
      return "";
    }
  }
  return baseUrl.replace(/\/+$/, "");
}

function messageFrom(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    return String((body as { error: unknown }).error);
  }
  return fallback;
}

async function apiFetch<T>(
  config: GatewayConfig,
  path: string,
  init?: RequestInit,
  // Statuses that carry a meaningful body the caller wants (e.g. 422 lifecycle
  // failures with problems/reason). These are returned, not thrown.
  allow: number[] = [],
): Promise<T> {
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  if (init?.body) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${resolveBase(config.baseUrl)}${path}`, { ...init, headers });
  } catch (e) {
    throw new ApiError(
      `Cannot reach the gateway at ${config.baseUrl}. Is it running? (${
        e instanceof Error ? e.message : String(e)
      })`,
      0,
    );
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }

  if (!res.ok && !allow.includes(res.status)) {
    throw new ApiError(messageFrom(body, `${res.status} ${res.statusText}`), res.status, body);
  }
  return body as T;
}

/** A client bound to one config. Views call these; they never see raw fetch. */
export function makeApi(config: GatewayConfig) {
  const q = (params: Record<string, string | number | undefined>): string => {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") usp.set(k, String(v));
    }
    const s = usp.toString();
    return s ? `?${s}` : "";
  };

  return {
    health: () => apiFetch<{ ok: boolean }>(config, "/health"),
    stats: () => apiFetch<StatsResponse>(config, "/admin/stats"),
    jobs: (params: { state?: string; limit?: number } = {}) =>
      apiFetch<JobsResponse>(config, `/admin/jobs${q(params)}`),
    job: (id: string) => apiFetch<JobRow>(config, `/admin/jobs/${encodeURIComponent(id)}`),
    catalogue: () => apiFetch<CatalogueResponse>(config, "/admin/catalogue"),
    callerCatalogue: () => apiFetch<CallerCatalogueResponse>(config, "/catalogue"),
    tokens: () => apiFetch<CallersResponse>(config, "/admin/tokens"),
    issueToken: (body: { name: string; scopes: string[]; isAdmin: boolean }) =>
      apiFetch<IssueTokenResponse>(config, "/admin/tokens", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    disableToken: (id: string) =>
      apiFetch<OkResult>(config, `/admin/tokens/${encodeURIComponent(id)}/disable`, {
        method: "POST",
      }),
    validateAction: (useCase: string) =>
      apiFetch<OkResult | ValidateFailure>(
        config,
        `/admin/catalogue/${encodeURIComponent(useCase)}/validate`,
        { method: "POST" },
        [422],
      ),
    recordTest: (useCase: string, client: string, jobId: string) =>
      apiFetch<OkResult | TransitionFailure>(
        config,
        `/admin/catalogue/${encodeURIComponent(useCase)}/clients/${encodeURIComponent(
          client,
        )}/record-test`,
        { method: "POST", body: JSON.stringify({ jobId }) },
        [422],
      ),
    enablePair: (useCase: string, client: string) =>
      apiFetch<OkResult | TransitionFailure>(
        config,
        `/admin/catalogue/${encodeURIComponent(useCase)}/clients/${encodeURIComponent(
          client,
        )}/enable`,
        { method: "POST" },
        [422],
      ),
    disablePair: (useCase: string, client: string) =>
      apiFetch<OkResult>(
        config,
        `/admin/catalogue/${encodeURIComponent(useCase)}/clients/${encodeURIComponent(
          client,
        )}/disable`,
        { method: "POST" },
      ),
    runCanaries: () =>
      apiFetch<RunCanariesResponse>(config, "/admin/canaries/run", { method: "POST" }),
    audit: (limit = 100) => apiFetch<AuditResponse>(config, `/admin/audit${q({ limit })}`),
    traces: (useCase?: string) =>
      apiFetch<{ traces: TraceSummary[] }>(config, `/admin/traces${q({ useCase })}`),
    invalidateTrace: (useCase: string, client: string) =>
      apiFetch<{ ok: boolean }>(
        config,
        `/admin/traces/${encodeURIComponent(useCase)}/${encodeURIComponent(client)}/invalidate`,
        { method: "POST" },
      ),
  };
}

export type Api = ReturnType<typeof makeApi>;
