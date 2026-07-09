import { describe, it, expect } from "vitest";
import { classifyRisk, DEFAULT_RISKY_KEYWORDS } from "../src/risk.js";

describe("classifyRisk", () => {
  it("flags a submit action as risky", () => {
    const r = classifyRisk({ description: "Click the Submit button", method: "click" });
    expect(r.level).toBe("risky");
    expect(r.reason).toContain("submit");
  });

  it("flags payment/delete/post via keywords", () => {
    for (const desc of ["Pay now", "Delete account", "Publish post"]) {
      expect(classifyRisk({ description: desc }).level).toBe("risky");
    }
  });

  it("treats benign fills and clicks as safe", () => {
    expect(classifyRisk({ description: "Type into the First name field", method: "fill" }).level).toBe("safe");
    expect(classifyRisk({ description: "Click the Next tab", method: "click" }).level).toBe("safe");
  });

  it("matches keywords found only in the instruction", () => {
    expect(classifyRisk({ description: "Click element", instruction: "submit the application" }).level).toBe("risky");
  });

  it("honors a custom keyword list", () => {
    expect(classifyRisk({ description: "frobnicate" }, { keywords: ["frobnicate"] }).level).toBe("safe");
    expect(classifyRisk({ description: "frobnicate the widget" }, { keywords: ["frobnicate"] }).level).toBe("risky");
    expect(DEFAULT_RISKY_KEYWORDS.length).toBeGreaterThan(0);
  });
});
