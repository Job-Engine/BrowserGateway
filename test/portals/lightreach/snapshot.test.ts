import { describe, expect, it } from "vitest";
import { parseLightreachSnapshot, type LightreachRawBodies } from "../../../src/portals/lightreach/snapshot.js";

// Fixtures mirror the real Palmetto API bodies observed in phase-0 recon
// (2026-08-27). Shapes are exact; customer values are synthetic.
const ACCT = "6a87900923781605da96a249";

function raw(over: Partial<LightreachRawBodies> = {}): LightreachRawBodies {
  return {
    accountId: ACCT,
    account: {
      id: ACCT,
      currentMilestone: { name: "Install", type: "install" },
      milestones: [
        {
          name: "Notice to Proceed",
          type: "ntp",
          status: "approved",
          completed: true,
          completedAt: "2026-08-21T02:31:27.222Z",
        },
        { name: "Install", type: "install", status: "pending", completed: false, completedAt: "" },
      ],
    },
    stipulations: [
      { stipulationType: "identityVerification", isSatisfied: true, requiresReview: false },
      { stipulationType: "titleVerification", isSatisfied: true, requiresReview: false },
    ],
    applications: [{ creditExpiryDate: "2027-02-17T01:43:35.262Z", status: "approvedWithStipulations" }],
    ...over,
  };
}

describe("parseLightreachSnapshot", () => {
  it("reads the approved NTP milestone's completedAt as the NTP date", () => {
    const s = parseLightreachSnapshot(raw());
    expect(s.ntpApproved).toBe(true);
    expect(s.ntpApprovedAt).toBe("2026-08-21T02:31:27.222Z");
    expect(s.matchedAccountId).toBe(ACCT);
    expect(s.currentMilestone).toBe("Install");
  });

  it("treats a not-yet-approved NTP milestone as unapproved with no date", () => {
    const s = parseLightreachSnapshot(
      raw({
        account: {
          id: ACCT,
          currentMilestone: { name: "Notice to Proceed" },
          milestones: [
            { name: "Notice to Proceed", status: "submitted", completed: false, completedAt: "" },
          ],
        },
      }),
    );
    expect(s.ntpApproved).toBe(false);
    expect(s.ntpApprovedAt).toBeNull();
  });

  it("never returns a date when the approved milestone's completedAt is empty (the blank-vs-absent trap)", () => {
    const s = parseLightreachSnapshot(
      raw({
        account: {
          id: ACCT,
          milestones: [{ name: "Notice to Proceed", status: "approved", completed: true, completedAt: "" }],
        },
      }),
    );
    // Approved but no timestamp yet: approved flag can be true, date must be null (never "").
    expect(s.ntpApprovedAt).toBeNull();
  });

  it("returns ntpApproved false and null date when there is no NTP milestone", () => {
    const s = parseLightreachSnapshot(raw({ account: { id: ACCT, milestones: [] } }));
    expect(s.ntpApproved).toBe(false);
    expect(s.ntpApprovedAt).toBeNull();
    expect(s.currentMilestone).toBeNull();
  });

  it("lists open stipulations (isSatisfied=false) and leaves openStipulations empty when all cleared", () => {
    expect(parseLightreachSnapshot(raw()).openStipulations).toEqual([]);
    const s = parseLightreachSnapshot(
      raw({
        stipulations: [
          { stipulationType: "identityVerification", isSatisfied: false, requiresReview: false },
          { stipulationType: "titleVerification", isSatisfied: true, requiresReview: false },
          { stipulationType: "creditCheckConsent", isSatisfied: false, requiresReview: true },
        ],
      }),
    );
    expect(s.openStipulations).toEqual(["identityVerification", "creditCheckConsent"]);
    expect(s.stipulations).toHaveLength(3);
    expect(s.stipulations[2]).toEqual({ type: "creditCheckConsent", satisfied: false, requiresReview: true });
  });

  it("handles an empty stipulations array", () => {
    const s = parseLightreachSnapshot(raw({ stipulations: [] }));
    expect(s.stipulations).toEqual([]);
    expect(s.openStipulations).toEqual([]);
  });

  it("takes the first application's creditExpiryDate, or null when none carries one", () => {
    expect(parseLightreachSnapshot(raw()).creditExpiryDate).toBe("2027-02-17T01:43:35.262Z");
    expect(parseLightreachSnapshot(raw({ applications: [] })).creditExpiryDate).toBeNull();
    expect(
      parseLightreachSnapshot(
        raw({ applications: [{ status: "pending" }, { creditExpiryDate: "2027-05-01T00:00:00.000Z" }] }),
      ).creditExpiryDate,
    ).toBe("2027-05-01T00:00:00.000Z");
  });

  it("produces a schema-valid snapshot", () => {
    // Round-trips through the zod schema without throwing.
    expect(() => parseLightreachSnapshot(raw())).not.toThrow();
  });
});
