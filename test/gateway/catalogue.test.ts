import { afterEach, describe, expect, it } from "vitest";
import { CATALOGUE, getEntry, resolveAction } from "../../src/gateway/catalogue.js";

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

describe("resolveAction (WL override merge)", () => {
  afterEach(() => {
    delete CATALOGUE["test.override"];
  });

  it("default client uses the bare portal credential item and base url", () => {
    const action = resolveAction("lightreach.ntpDate", "default");
    expect(action.credentialItem).toBe("lightreach");
    expect(action.client).toBe("default");
    expect(action.url).toBe(getEntry("lightreach.ntpDate").url);
  });

  it("a rostered client derives platform.client credential item", () => {
    const action = resolveAction("lightreach.ntpDate", "lgcyco");
    expect(action.credentialItem).toBe("lightreach.lgcyco");
    expect(action.client).toBe("lgcyco");
  });

  it("rejects clients not on the roster", () => {
    expect(() => resolveAction("lightreach.ntpDate", "ghost")).toThrow(/Unknown client/);
  });

  it("appends label mapping guidance to the goal without touching the base for others", () => {
    const brandx = resolveAction("lightreach.ntpDate", "brandx");
    const goal = brandx.buildGoal(input, { hasOtp: false });
    expect(goal).toContain("Notice to Proceed");
    const base = resolveAction("lightreach.ntpDate", "default").buildGoal(input, { hasOtp: false });
    expect(base).not.toContain("Notice to Proceed");
  });

  it("never overrides the extract schema: the resolved schema is the base object", () => {
    for (const client of ["default", "lgcyco", "brandx"]) {
      const action = resolveAction("lightreach.ntpDate", client);
      expect(action.extractSchema).toBe(getEntry("lightreach.ntpDate").extractSchema);
    }
  });

  it("merges startUrl, goalHints, timeout, and explicit credentialItem", () => {
    CATALOGUE["test.override"] = {
      ...getEntry("lightreach.ntpDate"),
      useCase: "test.override",
      clients: {
        special: {
          credentialItem: "custom.item",
          startUrl: "https://special.example.com/login",
          goalHints: ["Use the sidebar search, not the top bar."],
          timeoutMs: 120_000,
        },
      },
    };
    const action = resolveAction("test.override", "special");
    expect(action.credentialItem).toBe("custom.item");
    expect(action.url).toBe("https://special.example.com/login");
    expect(action.timeoutMs).toBe(120_000);
    expect(action.buildGoal(input, { hasOtp: false })).toContain("sidebar search");
  });
});
