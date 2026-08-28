import type { LightreachRawBodies } from "./snapshot.js";

/**
 * LightReach read client — the pure-HTTP half of the code-action (issue #467).
 * Given an account id and an authenticated fetch (one that carries the session
 * cookie jar captured after the browser login), GET the three endpoints the
 * portal's own API exposes and return their raw bodies for the parser.
 *
 * No browser here: this runs after login, reusing the 24h cookie jar.
 */

export const LIGHTREACH_API_BASE = "https://palmetto.finance";

/** A fetch that already carries the authenticated session (cookie jar). */
export type AuthedFetch = (url: string) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** Thrown on a 401 so the orchestrator re-logs-in (the jar expired) rather than
 *  surfacing a spurious business failure. */
export class LightreachAuthExpiredError extends Error {
  constructor(public readonly url: string) {
    super(`LightReach session expired (401) at ${url}`);
    this.name = "LightreachAuthExpiredError";
  }
}

function endpoints(accountId: string) {
  const id = encodeURIComponent(accountId);
  return {
    account: `${LIGHTREACH_API_BASE}/api/v2/accounts/${id}`,
    stipulations: `${LIGHTREACH_API_BASE}/api/accounts/${id}/stipulations`,
    applications: `${LIGHTREACH_API_BASE}/api/accounts/${id}/applications`,
  };
}

async function getJson(url: string, fetchImpl: AuthedFetch): Promise<unknown> {
  const res = await fetchImpl(url);
  if (res.status === 401) throw new LightreachAuthExpiredError(url);
  if (!res.ok) throw new Error(`LightReach read failed (${res.status}) at ${url}`);
  return res.json();
}

export async function readLightreachAccount(
  accountId: string,
  fetchImpl: AuthedFetch,
): Promise<LightreachRawBodies> {
  const ep = endpoints(accountId);
  // Parallel: the three reads are independent GETs on the same session.
  const [account, stipulations, applications] = await Promise.all([
    getJson(ep.account, fetchImpl),
    getJson(ep.stipulations, fetchImpl),
    getJson(ep.applications, fetchImpl),
  ]);
  return { accountId, account, stipulations, applications };
}
