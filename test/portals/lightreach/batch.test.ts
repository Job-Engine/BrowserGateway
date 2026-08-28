import { describe, expect, it } from "vitest";
import { PolitenessBudget } from "../../../src/portals/politeness.js";
import { LightreachAuthExpiredError } from "../../../src/portals/lightreach/read.js";
import { runLightreachBatch, type BatchDeps, type WarmSession } from "../../../src/portals/lightreach/batch.js";

const T0 = 1_700_000_000_000;
const ACCT = (n: number) => `acct-${n}`;

function bodiesFor(id: string) {
  return {
    [`https://palmetto.finance/api/v2/accounts/${id}`]: {
      id,
      milestones: [
        { name: "Notice to Proceed", status: "approved", completed: true, completedAt: "2026-08-21T00:00:00.000Z" },
      ],
    },
    [`https://palmetto.finance/api/accounts/${id}/stipulations`]: [],
    [`https://palmetto.finance/api/accounts/${id}/applications`]: [{ creditExpiryDate: "2027-02-17T00:00:00.000Z" }],
  } as Record<string, unknown>;
}

/** Build deps with a counting fake login and a programmable httpGet. */
function makeDeps(over: Partial<BatchDeps> = {}, statusFor?: (url: string, cookie: string) => number) {
  const state = { logins: 0 };
  const deps: BatchDeps = {
    client: "spartan",
    now: () => T0,
    budget: new PolitenessBudget({ loginsPerHour: 5, readsPerHour: 1000 }),
    login: async () => {
      state.logins += 1;
      return { cookieHeader: `jar-${state.logins}`, capturedAt: T0 };
    },
    httpGet: async (url, cookie) => {
      const status = statusFor?.(url, cookie) ?? 200;
      // Merge every account's bodies so any id resolves.
      const body = Object.assign({}, ...[0, 1, 2, 3, 4].map((n) => bodiesFor(ACCT(n))))[url];
      return { ok: status >= 200 && status < 300, status, json: async () => body };
    },
    ...over,
  };
  return { deps, state };
}

describe("runLightreachBatch", () => {
  it("logs in once, then reads every account into a success snapshot", async () => {
    const { deps, state } = makeDeps();
    const out = await runLightreachBatch([ACCT(0), ACCT(1), ACCT(2)], deps);
    expect(state.logins).toBe(1);
    expect(out.results.map((r) => r.status)).toEqual(["success", "success", "success"]);
    expect(out.results[0].snapshot?.ntpApproved).toBe(true);
    expect(out.session?.cookieHeader).toBe("jar-1");
  });

  it("reuses a valid warm session without logging in", async () => {
    const { deps, state } = makeDeps();
    const warm: WarmSession = { cookieHeader: "warm-jar", capturedAt: T0 };
    const out = await runLightreachBatch([ACCT(0)], deps, warm);
    expect(state.logins).toBe(0);
    expect(out.session?.cookieHeader).toBe("warm-jar");
  });

  it("re-logs-in when the passed session is older than the TTL", async () => {
    const { deps, state } = makeDeps({ sessionTtlMs: 60_000 });
    const stale: WarmSession = { cookieHeader: "old", capturedAt: T0 - 120_000 };
    await runLightreachBatch([ACCT(0)], deps, stale);
    expect(state.logins).toBe(1);
  });

  it("re-logs-in once on a mid-batch 401, then retries the read and succeeds", async () => {
    let first401 = true;
    const { deps, state } = makeDeps({}, (url) => {
      if (url.endsWith("/stipulations") && first401) {
        first401 = false;
        return 401;
      }
      return 200;
    });
    const out = await runLightreachBatch([ACCT(0)], deps);
    expect(state.logins).toBe(2); // initial + one re-login
    expect(out.results[0].status).toBe("success");
  });

  it("marks one failing record as error and still processes the rest", async () => {
    const { deps } = makeDeps({}, (url) => (url.includes(ACCT(1)) && url.endsWith("/applications") ? 500 : 200));
    const out = await runLightreachBatch([ACCT(0), ACCT(1), ACCT(2)], deps);
    expect(out.results.map((r) => r.status)).toEqual(["success", "error", "success"]);
    expect(out.results[1].error).toMatch(/500/);
  });

  it("stops politely when the read budget is exhausted (remaining = rate_limited)", async () => {
    const { deps } = makeDeps({ budget: new PolitenessBudget({ loginsPerHour: 5, readsPerHour: 2 }) });
    const out = await runLightreachBatch([ACCT(0), ACCT(1), ACCT(2), ACCT(3)], deps);
    const statuses = out.results.map((r) => r.status);
    expect(statuses.filter((s) => s === "success").length).toBe(2);
    expect(statuses.filter((s) => s === "rate_limited").length).toBe(2);
  });

  it("fails all records without hammering when the login budget is exhausted", async () => {
    const { deps, state } = makeDeps({ budget: new PolitenessBudget({ loginsPerHour: 0, readsPerHour: 1000 }) });
    const out = await runLightreachBatch([ACCT(0), ACCT(1)], deps);
    expect(state.logins).toBe(0);
    expect(out.session).toBeNull();
    expect(out.results.every((r) => r.status === "error")).toBe(true);
  });
});
