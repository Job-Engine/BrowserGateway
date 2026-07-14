import { describe, expect, it } from "vitest";
import { parameterizeSteps, resolveStep, type TraceStep } from "../src/replay.js";
import type { ActionRecord } from "../src/types.js";

function record(
  action: Partial<ActionRecord["action"]>,
  outcome: ActionRecord["outcome"] = "executed",
): ActionRecord {
  return {
    step: 1,
    action: {
      selector: "xpath=/html[1]/body[1]/a[1]",
      description: "click something",
      method: "click",
      arguments: [],
      instruction: "click something",
      ...action,
    },
    risk: { level: "safe", reason: "test" },
    decision: "auto",
    outcome,
  };
}

describe("parameterizeSteps", () => {
  it("keeps input-independent steps verbatim with a null template", () => {
    const [step] = parameterizeSteps([record({})], { name: "Jason Marshall" });
    expect(step.paramTemplate).toBeNull();
    expect(step.selector).toBe("xpath=/html[1]/body[1]/a[1]");
  });

  it("templates an input value found in arguments and description", () => {
    const [step] = parameterizeSteps(
      [
        record({
          method: "type",
          arguments: ["Jason Marshall"],
          description: 'Type "Jason Marshall" into the Search box',
        }),
      ],
      { name: "Jason Marshall", address: "205 Morningside Ct" },
    );
    expect(step.paramTemplate).not.toBeNull();
    expect(step.paramTemplate!.arguments).toEqual(["%name%"]);
  });

  it("templates an input value embedded in the selector", () => {
    const [step] = parameterizeSteps(
      [record({ selector: 'xpath=//a[contains(., "Jason Marshall")]' })],
      { name: "Jason Marshall" },
    );
    expect(step.paramTemplate!.selector).toBe('xpath=//a[contains(., "%name%")]');
  });

  it("requires whole-token matches so short values cannot false-positive", () => {
    const [step] = parameterizeSteps(
      [record({ selector: "xpath=/html[1]/body[1]/div[12]/a[1]" })],
      { projectId: "12" },
    );
    expect(step.paramTemplate).toBeNull();
  });

  it("drops non-executed steps", () => {
    const steps = parameterizeSteps([record({}, "failed"), record({})], {});
    expect(steps).toHaveLength(1);
  });

  it("never touches credential placeholders", () => {
    const [step] = parameterizeSteps([record({ method: "fill", arguments: ["%username%"] })], {
      name: "Jason Marshall",
    });
    expect(step.arguments).toEqual(["%username%"]);
    expect(step.paramTemplate).toBeNull();
  });
});

describe("resolveStep", () => {
  const templated: TraceStep = {
    selector: 'xpath=//a[contains(., "Jason Marshall")]',
    method: "click",
    arguments: [],
    description: "click the customer link",
    paramTemplate: { selector: 'xpath=//a[contains(., "%name%")]', arguments: [] },
  };

  it("substitutes current input into the template", () => {
    const action = resolveStep(templated, { name: "Maria Lopez" });
    expect(action.selector).toBe('xpath=//a[contains(., "Maria Lopez")]');
  });

  it("uses the recorded selector when no template exists", () => {
    const action = resolveStep({ ...templated, paramTemplate: null }, { name: "Maria Lopez" });
    expect(action.selector).toBe('xpath=//a[contains(., "Jason Marshall")]');
  });
});
