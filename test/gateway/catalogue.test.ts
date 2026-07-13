import { describe, expect, it } from "vitest";
import { CATALOGUE, getEntry } from "../../src/gateway/catalogue.js";

/**
 * Catalogue tests: M1 (OTP goal text follows the credential, not projectId)
 * and the folded LightReach procedure text.
 */

const input = { name: "Jane Homeowner", address: "123 Solar Way, Austin TX 78701" };

describe("getEntry", () => {
  it("returns the entry for a known useCase", () => {
    expect(getEntry("lightreach.ntpDate").portalKey).toBe("lightreach");
  });

  it("throws with the known list for an unknown useCase", () => {
    expect(() => getEntry("nope.nothing")).toThrow(/Unknown useCase/);
  });
});

describe("lightreach.ntpDate buildGoal", () => {
  const entry = getEntry("lightreach.ntpDate");

  it("M1: includes the OTP step when the credential has an OTP, without projectId", () => {
    const goal = entry.buildGoal(input, { hasOtp: true });
    expect(goal).toContain("%otp%");
  });

  it("M1: omits the OTP step when the credential has none, even with projectId", () => {
    const goal = entry.buildGoal({ ...input, projectId: "LR-123" }, { hasOtp: false });
    expect(goal).not.toContain("%otp%");
  });

  it("folds the LightReach procedure: verification tolerance and read-only rules", () => {
    const goal = entry.buildGoal(input, { hasOtp: false });
    expect(goal).toContain("%username%");
    expect(goal).toContain("%password%");
    expect(goal).toContain("%name%");
    expect(goal).toContain("%address%");
    expect(goal).toContain("NTP Date");
    expect(goal).toMatch(/St vs Street/);
    expect(goal.toLowerCase()).toContain("read-only");
    expect(goal.toLowerCase()).toContain("verify");
  });

  it("mentions the project ID for disambiguation only when provided", () => {
    expect(entry.buildGoal({ ...input, projectId: "LR-123" }, { hasOtp: false })).toContain(
      "%projectId%",
    );
    expect(entry.buildGoal(input, { hasOtp: false })).not.toContain("%projectId%");
  });
});

describe("catalogue shape", () => {
  it("every entry parses its own example-free schemas and has a portal key", () => {
    for (const entry of Object.values(CATALOGUE)) {
      expect(entry.portalKey.length).toBeGreaterThan(0);
      expect(entry.url).toMatch(/^https:\/\//);
      expect(entry.useCase).toContain(".");
    }
  });
});
