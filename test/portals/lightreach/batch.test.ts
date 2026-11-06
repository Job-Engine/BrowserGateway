import { describe, expect, it } from "vitest";
import { PolitenessBudget } from "../../../src/portals/politeness.js";
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

  describe("pacing, 429 back-off, run-time cap, single-call reserve (prod 2026-11-06)", () => {
    // Measured in prod: every 2h sweep fired ~250 accounts x 3 GETs back-to-back
    // in ~22s; Palmetto 429'd from position 16 on, and the 429'd reads still
    // spent the 200/h budget, so the create-poll ~90s later got
    // "read budget exhausted" on EVERY new deal.

    it("sleeps paceMs between accounts (not before the first)", async () => {
      const sleeps: number[] = [];
      const { deps } = makeDeps({ paceMs: 1500, sleep: async (ms) => void sleeps.push(ms) });
      await runLightreachBatch([ACCT(0), ACCT(1), ACCT(2)], deps);
      expect(sleeps).toEqual([1500, 1500]);
    });

    it("on a 429 backs off and retries the SAME account, then succeeds", async () => {
      let throttled = 1;
      const sleeps: number[] = [];
      const { deps } = makeDeps(
        { paceMs: 0, sleep: async (ms) => void sleeps.push(ms), rand: () => 0 },
        (url) => (url.includes(ACCT(1)) && url.endsWith("/stipulations") && throttled-- > 0 ? 429 : 200),
      );
      const out = await runLightreachBatch([ACCT(0), ACCT(1), ACCT(2)], deps);
      expect(out.results.map((r) => r.status)).toEqual(["success", "success", "success"]);
      expect(sleeps.some((ms) => ms > 0)).toBe(true); // a back-off happened
    });

    it("when 429s persist past the retries, stops the batch: this + rest = rate_limited, nothing more is fetched", async () => {
      const fetched: string[] = [];
      const { deps } = makeDeps(
        { paceMs: 0, sleep: async () => {}, max429Retries: 2 },
        (url) => {
          fetched.push(url);
          return url.includes(ACCT(1)) ? 429 : 200;
        },
      );
      const out = await runLightreachBatch([ACCT(0), ACCT(1), ACCT(2), ACCT(3)], deps);
      expect(out.results.map((r) => r.status)).toEqual(["success", "rate_limited", "rate_limited", "rate_limited"]);
      expect(out.results[1].error).toMatch(/429/);
      expect(fetched.some((u) => u.includes(ACCT(2)) || u.includes(ACCT(3)))).toBe(false);
    });

    it("refunds the read budget for a throttled account (it never returned data)", async () => {
      const budget = new PolitenessBudget({ loginsPerHour: 5, readsPerHour: 1000 });
      const { deps } = makeDeps({ budget, paceMs: 0, sleep: async () => {}, max429Retries: 0 }, (url) =>
        url.includes(ACCT(1)) ? 429 : 200,
      );
      await runLightreachBatch([ACCT(0), ACCT(1)], deps);
      // 1 successful read spent; the throttled one refunded → 999 left exactly.
      expect(budget.tryReads("spartan", 999, T0)).toBe(true);
      expect(budget.tryReads("spartan", 1, T0)).toBe(false);
    });

    it("a multi-account batch leaves reserveReads for single-account (create-poll) calls", async () => {
      const budget = new PolitenessBudget({ loginsPerHour: 5, readsPerHour: 4 });
      const { deps } = makeDeps({ budget, paceMs: 0, sleep: async () => {}, reserveReads: 2 });
      const sweep = await runLightreachBatch([ACCT(0), ACCT(1), ACCT(2), ACCT(3)], deps);
      expect(sweep.results.map((r) => r.status)).toEqual(["success", "success", "rate_limited", "rate_limited"]);
      const poll = await runLightreachBatch([ACCT(4)], deps, sweep.session);
      expect(poll.results[0].status).toBe("success");
    });

    it("stops starting new accounts once maxRunMs has elapsed (callers time out at 180s)", async () => {
      let t = T0;
      const { deps } = makeDeps({
        now: () => t,
        paceMs: 0,
        maxRunMs: 10_000,
        sleep: async () => {},
        httpGet: async (url) => {
          t += 2_000; // each GET costs 2s of wall clock
          const body = Object.assign({}, ...[0, 1, 2, 3, 4].map((n) => bodiesFor(ACCT(n))))[url];
          return { ok: true, status: 200, json: async () => body };
        },
      });
      const out = await runLightreachBatch([ACCT(0), ACCT(1), ACCT(2), ACCT(3)], deps);
      const statuses = out.results.map((r) => r.status);
      expect(statuses[0]).toBe("success");
      expect(statuses).toContain("rate_limited");
      expect(out.results.find((r) => r.status === "rate_limited")?.error).toMatch(/run time/);
    });
  });
});
