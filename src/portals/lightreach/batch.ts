import type { PolitenessBudget } from "../politeness.js";
import {
  LightreachAuthExpiredError,
  LightreachThrottledError,
  readLightreachAccount,
  type AuthedFetch,
} from "./read.js";
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
  /** Pause between accounts (not before the first). Default 0; the production
   *  handler sets it — see action.ts. Each account is 3 parallel GETs. */
  paceMs?: number;
  /** Times to back off and retry ONE account on a 429 before giving up on the
   *  batch. Default 2. */
  max429Retries?: number;
  /** Stop starting new accounts after this much wall clock (callers poll with a
   *  180s timeout and the gateway reaps at 330s). Default: no cap. */
  maxRunMs?: number;
  /** Reads a MULTI-account batch must leave unspent in the hourly budget, so a
   *  single-account create-poll still gets through after a sweep. Default 0. */
  reserveReads?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source for back-off, in [0,1). */
  rand?: () => number;
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

  const paceMs = deps.paceMs ?? 0;
  const max429Retries = deps.max429Retries ?? 2;
  const reserve = accountIds.length > 1 ? (deps.reserveReads ?? 0) : 0;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rand = deps.rand ?? Math.random;
  const startedAt = deps.now();

  const deferRest = (from: number, error: string, firstError = error) => {
    for (let j = from; j < accountIds.length; j++) {
      results.push({ accountId: accountIds[j], status: "rate_limited", error: j === from ? firstError : error });
    }
  };

  for (let i = 0; i < accountIds.length; i++) {
    const accountId = accountIds[i];
    if (deps.maxRunMs !== undefined && deps.now() - startedAt >= deps.maxRunMs) {
      deferRest(i, "run time cap reached; deferred to the next run");
      break;
    }
    if (!deps.budget.tryReads(deps.client, 1, deps.now(), reserve)) {
      // Read budget hit: stop politely, mark this and the rest rate_limited.
      deferRest(i, "read budget exhausted");
      break;
    }
    if (i > 0 && paceMs > 0) await sleep(paceMs);

    const authed = (jar: string): AuthedFetch => (url) => deps.httpGet(url, jar);
    // Read one account, backing off on 429. Returns "throttled" when Palmetto
    // keeps refusing after the retries.
    const readWithBackoff = async (jar: string): Promise<BatchRecordResult | "throttled"> => {
      for (let attempt = 0; ; attempt++) {
        try {
          const raw = await readLightreachAccount(accountId, authed(jar));
          return { accountId, status: "success", snapshot: parseLightreachSnapshot(raw) };
        } catch (e) {
          if (!(e instanceof LightreachThrottledError)) throw e;
          if (attempt >= max429Retries) return "throttled";
          await sleep(deps.budget.backoffMs(attempt, rand()));
        }
      }
    };

    let outcome: BatchRecordResult | "throttled";
    try {
      outcome = await readWithBackoff(active.cookieHeader);
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
          outcome = await readWithBackoff(active.cookieHeader);
        } catch (e2) {
          results.push({ accountId, status: "error", error: String((e2 as Error).message ?? e2) });
          continue;
        }
      } else {
        results.push({ accountId, status: "error", error: String((e as Error).message ?? e) });
        continue;
      }
    }

    if (outcome === "throttled") {
      // Palmetto is still refusing: stop instead of firing the rest of the list
      // into a wall. The refused read returned no data, so it does not count
      // against our own hourly budget. Unread accounts stay due for next run.
      deps.budget.refundReads(deps.client, 1);
      deferRest(i, "deferred: portal throttling (429)", `portal throttled (429) after ${max429Retries} retries`);
      break;
    }
    results.push(outcome);
  }

  return { session: active, results };
}
