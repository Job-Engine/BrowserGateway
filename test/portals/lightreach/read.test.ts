import { describe, expect, it } from "vitest";
import {
  LightreachAuthExpiredError,
  readLightreachAccount,
  type AuthedFetch,
} from "../../../src/portals/lightreach/read.js";

const ACCT = "6a87900923781605da96a249";

/** A fake authed fetch driven by a url→body map; records the urls requested. */
function fakeFetch(
  bodies: Record<string, unknown>,
  opts: { status?: (url: string) => number } = {},
): { fetch: AuthedFetch; urls: string[] } {
  const urls: string[] = [];
  const fetch: AuthedFetch = async (url) => {
    urls.push(url);
    const status = opts.status?.(url) ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => bodies[url] };
  };
  return { fetch, urls };
}

const BASE = "https://palmetto.finance";
const urls = {
  account: `${BASE}/api/v2/accounts/${ACCT}`,
  stipulations: `${BASE}/api/accounts/${ACCT}/stipulations`,
  applications: `${BASE}/api/accounts/${ACCT}/applications`,
};

describe("readLightreachAccount", () => {
  it("GETs the three account endpoints and returns their raw bodies", async () => {
    const { fetch, urls: hit } = fakeFetch({
      [urls.account]: { id: ACCT, milestones: [] },
      [urls.stipulations]: [{ stipulationType: "identityVerification", isSatisfied: true }],
      [urls.applications]: [{ creditExpiryDate: "2027-02-17T01:43:35.262Z" }],
    });
    const raw = await readLightreachAccount(ACCT, fetch);

    expect(hit.sort()).toEqual([urls.account, urls.applications, urls.stipulations].sort());
    expect(raw.accountId).toBe(ACCT);
    expect(raw.account).toEqual({ id: ACCT, milestones: [] });
    expect(raw.stipulations).toHaveLength(1);
    expect(raw.applications).toHaveLength(1);
  });

  it("throws LightreachAuthExpiredError on a 401 (jar expired → re-login)", async () => {
    const { fetch } = fakeFetch(
      { [urls.account]: {}, [urls.stipulations]: [], [urls.applications]: [] },
      { status: (u) => (u === urls.stipulations ? 401 : 200) },
    );
    await expect(readLightreachAccount(ACCT, fetch)).rejects.toBeInstanceOf(LightreachAuthExpiredError);
  });

  it("throws on a non-401 error status", async () => {
    const { fetch } = fakeFetch(
      { [urls.account]: {}, [urls.stipulations]: [], [urls.applications]: [] },
      { status: (u) => (u === urls.applications ? 500 : 200) },
    );
    await expect(readLightreachAccount(ACCT, fetch)).rejects.toThrow(/500/);
  });

  it("url-encodes the account id in every endpoint", async () => {
    const weird = "abc/def?x";
    const { fetch, urls: hit } = fakeFetch({});
    await readLightreachAccount(weird, fetch).catch(() => {});
    for (const u of hit) expect(u).toContain(encodeURIComponent(weird));
  });
});
