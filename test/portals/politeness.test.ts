import { describe, expect, it } from "vitest";
import { PolitenessBudget } from "../../src/portals/politeness.js";

const T0 = 1_700_000_000_000; // fixed epoch ms; time is injected, never ambient

describe("PolitenessBudget", () => {
  it("allows reads up to the hourly limit, then denies", () => {
    const b = new PolitenessBudget({ loginsPerHour: 1, readsPerHour: 3 });
    expect(b.tryReads("spartan", 1, T0)).toBe(true);
    expect(b.tryReads("spartan", 2, T0)).toBe(true); // 3 total, at the limit
    expect(b.tryReads("spartan", 1, T0)).toBe(false); // over
  });

  it("is all-or-nothing: a batch that would exceed the limit spends nothing", () => {
    const b = new PolitenessBudget({ loginsPerHour: 1, readsPerHour: 3 });
    expect(b.tryReads("spartan", 5, T0)).toBe(false); // 5 > 3, rejected whole
    expect(b.tryReads("spartan", 3, T0)).toBe(true); // budget was untouched
  });

  it("frees budget as the hour window slides", () => {
    const b = new PolitenessBudget({ loginsPerHour: 1, readsPerHour: 2 });
    expect(b.tryReads("spartan", 2, T0)).toBe(true);
    expect(b.tryReads("spartan", 1, T0 + 59 * 60_000)).toBe(false); // still within the hour
    expect(b.tryReads("spartan", 2, T0 + 60 * 60_000 + 1)).toBe(true); // window slid past
  });

  it("keeps login and read budgets independent", () => {
    const b = new PolitenessBudget({ loginsPerHour: 1, readsPerHour: 200 });
    expect(b.tryLogin("spartan", T0)).toBe(true);
    expect(b.tryLogin("spartan", T0)).toBe(false); // login exhausted
    expect(b.tryReads("spartan", 200, T0)).toBe(true); // reads unaffected
  });

  it("isolates clients from each other", () => {
    const b = new PolitenessBudget({ loginsPerHour: 1, readsPerHour: 1 });
    expect(b.tryReads("spartan", 1, T0)).toBe(true);
    expect(b.tryReads("spartan", 1, T0)).toBe(false); // spartan exhausted
    expect(b.tryReads("lgcyco", 1, T0)).toBe(true); // a different client is fine
  });

  it("backoff grows exponentially, is capped, and jitter stays in [half, full]", () => {
    const b = new PolitenessBudget({
      loginsPerHour: 1,
      readsPerHour: 1,
      baseBackoffMs: 1_000,
      maxBackoffMs: 60_000,
    });
    // attempt 0: full = 1000; jitter range [500, 1000]
    expect(b.backoffMs(0, 0)).toBe(500);
    expect(b.backoffMs(0, 0.9999999)).toBeCloseTo(1000, 0);
    // attempt 2: full = 4000; jitter range [2000, 4000]
    expect(b.backoffMs(2, 0)).toBe(2000);
    // deep attempt: capped at 60000; range [30000, 60000]
    expect(b.backoffMs(20, 0)).toBe(30_000);
    expect(b.backoffMs(20, 0.9999999)).toBeCloseTo(60_000, 0);
  });
});
