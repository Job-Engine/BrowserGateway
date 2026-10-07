import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture what createSession asks Browserbase for, without a real browser.
const ctorArgs: unknown[] = [];
vi.mock("@browserbasehq/stagehand", () => ({
  Stagehand: vi.fn(function (this: unknown, opts: unknown) {
    ctorArgs.push(opts);
    return {
      init: vi.fn(async () => undefined),
      context: { pages: () => [{}], newPage: vi.fn(async () => ({})) },
      browserbaseSessionURL: undefined,
      browserbaseSessionID: undefined,
    };
  }),
}));

const { createSession } = await import("../src/browser.js");

function lastSessionCreateParams(): Record<string, any> {
  const opts = ctorArgs.at(-1) as { browserbaseSessionCreateParams: Record<string, any> };
  return opts.browserbaseSessionCreateParams;
}

describe("Browserbase session recording", () => {
  beforeEach(() => {
    ctorArgs.length = 0;
    delete process.env.BB_RECORD_SESSION;
  });
  afterEach(() => {
    delete process.env.BB_RECORD_SESSION;
  });

  it("is off by default: portal logins are typed into the recorded page", async () => {
    await createSession({ model: "m", projectId: "p" });
    expect(lastSessionCreateParams().browserSettings).toEqual({ recordSession: false });
  });

  it("stays off when a persistent context is used", async () => {
    await createSession({ model: "m", projectId: "p", context: { id: "ctx", persist: true } });
    expect(lastSessionCreateParams().browserSettings).toEqual({
      recordSession: false,
      context: { id: "ctx", persist: true },
    });
  });

  it("can be turned on explicitly for debugging", async () => {
    process.env.BB_RECORD_SESSION = "true";
    await createSession({ model: "m", projectId: "p" });
    expect(lastSessionCreateParams().browserSettings.recordSession).toBe(true);
  });
});
