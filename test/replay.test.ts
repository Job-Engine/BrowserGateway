import { describe, expect, it } from "vitest";
import {
  fuzzyMatch,
  normalizeIdentity,
  parameterizeSteps,
  replayTrace,
  resolveStep,
  type ReplayPlan,
  type ReplayRunOptions,
  type ReplayTrace,
  type TraceStep,
} from "../src/replay.js";
import {
  READ_ONLY_METHODS,
  type ActionRecord,
  type ActOutcome,
  type BrowserAgent,
  type ObservedAction,
} from "../src/types.js";

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

  it("never corrupts a credential placeholder even when an input value collides with its word", () => {
    const [step] = parameterizeSteps([record({ method: "fill", arguments: ["%username%"] })], {
      name: "username",
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

describe("normalizeIdentity", () => {
  it("lowercases, strips punctuation, expands abbreviations", () => {
    expect(normalizeIdentity("205 Morningside Ct. NE, Cedar Rapids")).toBe(
      "205 morningside court northeast cedar rapids",
    );
  });
});

describe("fuzzyMatch", () => {
  it("accepts exact matches ignoring case", () => {
    expect(fuzzyMatch("Jason Marshall", "jason marshall")).toBe(true);
  });
  it("accepts abbreviation and punctuation differences", () => {
    expect(
      fuzzyMatch(
        "205 Morningside Court Northeast, Cedar Rapids, IA 52402",
        "205 Morningside Ct NE Cedar Rapids IA 52402",
      ),
    ).toBe(true);
  });
  it("accepts extra tokens on the page (middle name) when all expected tokens appear", () => {
    expect(fuzzyMatch("Jason A Marshall", "Jason Marshall")).toBe(true);
  });
  it("rejects a different person", () => {
    expect(fuzzyMatch("Mason Marshall", "Jason Marshall")).toBe(false);
  });
  it("rejects a different street", () => {
    expect(
      fuzzyMatch(
        "206 Sunnyside Court Northeast, Cedar Rapids",
        "205 Morningside Ct NE Cedar Rapids",
      ),
    ).toBe(false);
  });

  it("rejects empty or punctuation-only values on either side", () => {
    expect(fuzzyMatch("", "")).toBe(false);
    expect(fuzzyMatch("...", "")).toBe(false);
    expect(fuzzyMatch("   ", "###")).toBe(false);
    expect(fuzzyMatch("", "Jason Marshall")).toBe(false);
    expect(fuzzyMatch("Jason Marshall", "")).toBe(false);
  });

  it("rejects transposed numeric address components", () => {
    expect(fuzzyMatch("5 Main Street Apt 12", "12 Main St Apt 5")).toBe(false);
  });

  it("still accepts when numeric order is preserved", () => {
    expect(
      fuzzyMatch(
        "205 Morningside Court Northeast, Cedar Rapids, IA 52402",
        "205 Morningside Ct NE Cedar Rapids IA 52402",
      ),
    ).toBe(true);
  });
});

function fakeReplayAgent(opts: {
  actResults?: ActOutcome[];
  texts?: Record<string, string | null>;
}): { agent: BrowserAgent; acted: ObservedAction[] } {
  const acted: ObservedAction[] = [];
  let i = 0;
  const agent: BrowserAgent = {
    goto: async () => {},
    observe: async () => [],
    act: async (action) => {
      acted.push(action);
      return opts.actResults?.[i++] ?? { success: true, message: "ok" };
    },
    extract: (async () => ({})) as unknown as BrowserAgent["extract"],
    readText: async (selector) => opts.texts?.[selector] ?? null,
    close: async () => {},
  };
  return { agent, acted };
}

const TRACE: ReplayTrace = {
  steps: [
    {
      selector: "xpath=/html/body/input[1]",
      method: "fill",
      arguments: ["%username%"],
      description: "fill username",
      paramTemplate: null,
    },
    {
      selector: 'xpath=//a[contains(., "Jason Marshall")]',
      method: "click",
      arguments: [],
      description: "open the record",
      paramTemplate: { selector: 'xpath=//a[contains(., "%name%")]', arguments: [] },
    },
  ],
  readSelectors: {
    matchedName: "xpath=//h1",
    matchedAddress: "xpath=//p[1]",
    ntpDate: "xpath=//span[1]",
  },
};

const PLAN: ReplayPlan = {
  reads: { matchedName: "", matchedAddress: "", ntpDate: "" },
  verify: { matchedName: "name", matchedAddress: "address" },
  assertTrue: ["matchVerified", "ntpDateFound"],
};

const INPUT = { name: "Maria Lopez", address: "10 Oak St" };
const OK_TEXTS = {
  "xpath=//h1": "Maria Lopez",
  "xpath=//p[1]": "10 Oak Street",
  "xpath=//span[1]": "Jul 11, 2026",
};

function run(overrides?: Partial<ReplayRunOptions>) {
  return replayTrace({
    agent: fakeReplayAgent({ texts: OK_TEXTS }).agent,
    url: "https://example.test",
    trace: TRACE,
    plan: PLAN,
    input: INPUT,
    credentials: { username: "u", password: "p" },
    allowedMethods: READ_ONLY_METHODS,
    deadline: Date.now() + 60_000,
    ...overrides,
  });
}

describe("replayTrace", () => {
  it("replays, reads, verifies, and asserts booleans", async () => {
    const { agent, acted } = fakeReplayAgent({ texts: OK_TEXTS });
    const out = await replayTrace({
      agent,
      url: "https://example.test",
      trace: TRACE,
      plan: PLAN,
      input: INPUT,
      credentials: { username: "u", password: "p" },
      allowedMethods: READ_ONLY_METHODS,
      deadline: Date.now() + 60_000,
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data).toEqual({
        matchedName: "Maria Lopez",
        matchedAddress: "10 Oak Street",
        ntpDate: "Jul 11, 2026",
        matchVerified: true,
        ntpDateFound: true,
      });
    }
    expect(acted[1].selector).toBe('xpath=//a[contains(., "Maria Lopez")]');
  });

  it("fails closed on a method outside the allowlist", async () => {
    const trace: ReplayTrace = {
      ...TRACE,
      steps: [{ ...TRACE.steps[0], method: "uploadFile" }],
    };
    const out = await run({ trace });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/allowlist/);
  });

  it("escalates when an act fails", async () => {
    const { agent } = fakeReplayAgent({
      actResults: [{ success: false, message: "detached" }],
      texts: OK_TEXTS,
    });
    const out = await run({ agent });
    expect(out.ok).toBe(false);
  });

  it("escalates on identity mismatch", async () => {
    const { agent } = fakeReplayAgent({
      texts: { ...OK_TEXTS, "xpath=//h1": "Someone Else" },
    });
    const out = await run({ agent });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/mismatch/);
  });

  it("escalates when a verify read is missing", async () => {
    const { agent } = fakeReplayAgent({ texts: { ...OK_TEXTS, "xpath=//h1": null } });
    const out = await run({ agent, deadline: Date.now() + 1500 });
    expect(out.ok).toBe(false);
  });

  it("returns null for an empty data read without escalating", async () => {
    const { agent } = fakeReplayAgent({ texts: { ...OK_TEXTS, "xpath=//span[1]": null } });
    const out = await run({ agent, deadline: Date.now() + 1500 });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.ntpDate).toBeNull();
  });

  it("stops at the deadline", async () => {
    const out = await run({ deadline: Date.now() - 1 });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/deadline/);
  });

  it("retries a settling read once before giving up, then succeeds", async () => {
    let calls = 0;
    const agent: BrowserAgent = {
      goto: async () => {},
      observe: async () => [],
      act: async () => ({ success: true, message: "ok" }),
      extract: (async () => ({})) as unknown as BrowserAgent["extract"],
      readText: async (selector) => {
        if (selector === "xpath=//span[1]") {
          calls++;
          if (calls === 1) return null;
        }
        return OK_TEXTS[selector as keyof typeof OK_TEXTS] ?? null;
      },
      close: async () => {},
    };
    const out = await run({ agent });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.ntpDate).toBe("Jul 11, 2026");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("redacts credential values from escalation reasons", async () => {
    const { agent } = fakeReplayAgent({
      actResults: [{ success: false, message: "fill failed for value hunter2 on selector" }],
      texts: OK_TEXTS,
    });
    const out = await replayTrace({
      agent,
      url: "https://example.test",
      trace: TRACE,
      plan: PLAN,
      input: INPUT,
      credentials: { username: "u", password: "hunter2" },
      allowedMethods: READ_ONLY_METHODS,
      deadline: Date.now() + 60_000,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).not.toContain("hunter2");
      expect(out.reason).toContain("***");
    }
  });
});
