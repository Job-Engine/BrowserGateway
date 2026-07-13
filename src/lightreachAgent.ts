/**
 * Client for the hosted Browserbase "Lightreach NTP Passed" Agent.
 *
 * The Agent already runs in Browserbase's cloud. This module just triggers a
 * run over the REST API and polls it to completion. Runs are asynchronous:
 * POST /v1/agents/runs returns a runId, then you GET the run until it reaches a
 * terminal state and read `result` (shaped by the Agent's result schema).
 *
 * Docs: https://docs.browserbase.com/platform/agents/integrate-api-sdk
 *
 * IMPORTANT: never call this from a browser / client bundle. It uses your
 * BROWSERBASE_API_KEY, which must stay server-side. Call it from a backend
 * route (see examples/lightreach-server.ts).
 */

const API_BASE = "https://api.browserbase.com/v1";

export interface LightreachRecord {
  /** Customer full name, used for search and match verification. */
  name: string;
  /** Service / installation address, used for match verification. */
  address: string;
  /** Optional account or project ID to disambiguate search. */
  projectId?: string;
}

/** Terminal + active run states from the Agents API. */
export type RunStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "STOPPED"
  | "TIMED_OUT";

const TERMINAL: ReadonlySet<RunStatus> = new Set([
  "COMPLETED",
  "FAILED",
  "STOPPED",
  "TIMED_OUT",
]);

/** The structured output defined by the Agent's result schema. */
export interface NtpResult {
  status: "success" | "fail";
  sessionId: string;
  sessionReplayUrl?: string | null;
  ranAt: string;
  recordFound: boolean;
  recordOpened?: boolean;
  matchVerified: boolean;
  matchedName?: string | null;
  matchedAddress?: string | null;
  ntpDate: string | null;
  ntpDateFound?: boolean;
  errors: Array<{ code: string; message: string; step?: string | null }>;
  notes?: string | null;
}

/** A run as returned by GET /v1/agents/runs/{runId}. */
export interface AgentRun {
  id: string;
  agentId: string;
  sessionId?: string;
  status: RunStatus;
  result?: NtpResult;
  error?: unknown;
  createdAt?: string;
  endedAt?: string;
}

export interface RunConfig {
  /** Saved Agent ID (from the dashboard "View Agent API"). Defaults to env BB_AGENT_ID. */
  agentId?: string;
  /** Defaults to env BROWSERBASE_API_KEY. */
  apiKey?: string;
  /** Reuse a logged-in Browserbase Context so runs skip login. */
  contextId?: string;
  /** Route through proxies (often needed for portals). Default false. */
  proxies?: boolean;
  /** Poll interval in ms. Default 3000. */
  pollIntervalMs?: number;
  /** Give up after this many ms. Default 300000 (5 min). */
  timeoutMs?: number;
  /** AbortSignal to cancel polling. */
  signal?: AbortSignal;
}

function requireEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing ${name}. Set it in the environment or pass it explicitly.`);
  return value;
}

async function bbFetch(path: string, apiKey: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "x-bb-api-key": apiKey,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const msg = (body && (body.message || body.error)) || `${res.status} ${res.statusText}`;
    throw new Error(`Browserbase API error (${res.status}): ${msg}`);
  }
  return body;
}

/** Start a run of the saved Agent for one record. Returns the runId immediately. */
export async function startNtpRun(
  record: LightreachRecord,
  config: RunConfig = {},
): Promise<{ runId: string; agentId: string }> {
  const apiKey = requireEnv(config.apiKey ?? process.env.BROWSERBASE_API_KEY, "BROWSERBASE_API_KEY");
  const agentId = requireEnv(config.agentId ?? process.env.BB_AGENT_ID, "BB_AGENT_ID");

  const task = [
    `Look up this LightReach account and report its NTP Date.`,
    `Name: %name%.`,
    `Address: %address%.`,
    record.projectId ? `Project/Account ID: %projectId%.` : ``,
    `Verify the record by matching BOTH name and address before reading any field.`,
  ]
    .filter(Boolean)
    .join(" ");

  // Variables are substituted into the task/prompt but not shown inline; keep
  // any sensitive values here rather than in the task string.
  const variables: Record<string, { value: string; description?: string }> = {
    name: { value: record.name, description: "Customer full name to search and verify" },
    address: { value: record.address, description: "Service address to verify the match" },
  };
  if (record.projectId) {
    variables.projectId = { value: record.projectId, description: "Account/project ID to disambiguate" };
  }

  const body = await bbFetch("/agents/runs", apiKey, {
    method: "POST",
    body: JSON.stringify({
      agentId,
      task,
      variables,
      browserSettings: {
        ...(config.proxies ? { proxies: true } : {}),
        ...(config.contextId ? { context: { id: config.contextId, persist: false } } : {}),
      },
    }),
  }) as { runId: string; agentId?: string };

  return { runId: body.runId, agentId: body.agentId ?? agentId };
}

/** Fetch a single run's current state. */
export async function getRun(runId: string, config: RunConfig = {}): Promise<AgentRun> {
  const apiKey = requireEnv(config.apiKey ?? process.env.BROWSERBASE_API_KEY, "BROWSERBASE_API_KEY");
  return (await bbFetch(`/agents/runs/${runId}`, apiKey)) as AgentRun;
}

/** Poll a run until it reaches a terminal state (or the timeout elapses). */
export async function pollRun(runId: string, config: RunConfig = {}): Promise<AgentRun> {
  const pollIntervalMs = config.pollIntervalMs ?? 3000;
  const timeoutMs = config.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (config.signal?.aborted) throw new Error("pollRun aborted");
    const run = await getRun(runId, config);
    if (TERMINAL.has(run.status)) return run;
    if (Date.now() >= deadline) {
      throw new Error(`Run ${runId} did not finish within ${timeoutMs}ms (last status: ${run.status})`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}

/**
 * Convenience: start a run for one record and wait for the structured result.
 * Never throws on a business failure (unverified match, missing NTP field);
 * those come back as `status: "fail"` with populated `errors`. Throws only on
 * transport/auth problems or timeout.
 */
export async function runLightreachNtpCheck(
  record: LightreachRecord,
  config: RunConfig = {},
): Promise<{ runId: string; run: AgentRun; result?: NtpResult }> {
  const { runId } = await startNtpRun(record, config);
  const run = await pollRun(runId, config);
  return { runId, run, result: run.result };
}
