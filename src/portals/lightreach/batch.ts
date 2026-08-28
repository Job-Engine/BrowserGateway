import { PolitenessBudget } from "../politeness.js";
import { LightreachAuthExpiredError, readLightreachAccount, type AuthedFetch } from "./read.js";
import { parseLightreachSnapshot, type LightreachSnapshot } from "./snapshot.js";

/**
 * LightReach batch orchestration — the economics of the code-action (issue #467):
 * log in ONCE per run (or reuse a warm session), then read N accounts over the
 * 24h cookie jar. Per-record status so one bad account never fails the batch.
 * Re-login on a 401 (jar expired). Every login and read passes the politeness
 * budget so we stay an extremely light guest on Palmetto.
 *
 * Pure orchestration: login + HTTP are injected, so this is unit-tested with
 * fakes; the live Browserbase login lives in login.ts.
 */

export interface WarmSession {
  /** Cookie header carrying the authenticated palmetto.finance jar. */
  cookieHeader: string;
  /** epoch ms the jar was captured (for TTL). */
  capturedAt: number;
}

/** An authed GET keyed by an explicit cookie header (so a refreshed jar is used). */
export type CookieGet = (
  url: string,
  cookieHeader: string,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface BatchDeps {
  client: string;
  /** Performs the Browserbase login, returns a fresh warm session. */
  login: () => Promise<WarmSession>;
  httpGet: CookieGet;
  budget: PolitenessBudget;
  now: () => number;
  /** Warm-session TTL; default 23h (under the observed 24h cookie life). */
  sessionTtlMs?: number;
}

export type BatchRecordStatus = "success" | "error" | "rate_limited";

export interface BatchRecordResult {
  accountId: string;
  status: BatchRecordStatus;
  snapshot?: LightreachSnapshot;
  error?: string;
}

export interface BatchOutcome {
  /** The (possibly refreshed) session, for reuse across runs. Null if login failed. */
  session: WarmSession | null;
  results: BatchRecordResult[];
}

const DEFAULT_TTL_MS = 23 * 3_600_000;

export async function runLightreachBatch(
  accountIds: string[],
  deps: BatchDeps,
  session: WarmSession | null = null,
): Promise<BatchOutcome> {
  const ttl = deps.sessionTtlMs ?? DEFAULT_TTL_MS;
  const isExpired = (s: WarmSession) => deps.now() - s.capturedAt > ttl;

  // Acquire a valid session (login only when needed, and only within budget).
  const ensureSession = async (): Promise<WarmSession | null> => {
    if (session && !isExpired(session)) return session;
    if (!deps.budget.tryLogin(deps.client, deps.now())) return null; // over login budget
    session = await deps.login();
    return session;
  };

  const results: BatchRecordResult[] = [];
  let active = await ensureSession();
  if (!active) {
    // Login budget exhausted: fail every record without touching the portal.
    return { session: null, results: accountIds.map((accountId) => ({ accountId, status: "error", error: "login budget exhausted" })) };
  }

  for (let i = 0; i < accountIds.length; i++) {
    const accountId = accountIds[i];
    if (!deps.budget.tryReads(deps.client, 1, deps.now())) {
      // Read budget hit: stop politely, mark this and the rest rate_limited.
      for (let j = i; j < accountIds.length; j++) {
        results.push({ accountId: accountIds[j], status: "rate_limited", error: "read budget exhausted" });
      }
      break;
    }

    const authed = (jar: string): AuthedFetch => (url) => deps.httpGet(url, jar);
    try {
      const raw = await readLightreachAccount(accountId, authed(active.cookieHeader));
      results.push({ accountId, status: "success", snapshot: parseLightreachSnapshot(raw) });
    } catch (e) {
      if (e instanceof LightreachAuthExpiredError) {
        // Jar expired mid-batch: force a re-login (budget permitting) and retry once.
        session = null;
        const renewed = await ensureSession();
        if (!renewed) {
          results.push({ accountId, status: "error", error: "session expired and login budget exhausted" });
          continue;
        }
        active = renewed;
        try {
          const raw = await readLightreachAccount(accountId, authed(active.cookieHeader));
          results.push({ accountId, status: "success", snapshot: parseLightreachSnapshot(raw) });
        } catch (e2) {
          results.push({ accountId, status: "error", error: String((e2 as Error).message ?? e2) });
        }
      } else {
        results.push({ accountId, status: "error", error: String((e as Error).message ?? e) });
      }
    }
  }

  return { session: active, results };
}
