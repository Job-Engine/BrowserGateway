import { describe, it, expect } from "vitest";
import { parseArgs } from "../src/cli.js";

describe("parseArgs", () => {
  it("parses url, goal, json data/creds, and flags", () => {
    const args = parseArgs([
      "--url", "https://x.com/apply",
      "--goal", "apply for the job",
      "--data", '{"name":"Ada"}',
      "--creds", '{"password":"pw"}',
      "--model", "anthropic/claude-opus-4-8",
      "--auto",
      "--local",
    ]);
    expect(args.url).toBe("https://x.com/apply");
    expect(args.goal).toBe("apply for the job");
    expect(args.data).toEqual({ name: "Ada" });
    expect(args.credentials).toEqual({ password: "pw" });
    expect(args.model).toBe("anthropic/claude-opus-4-8");
    expect(args.auto).toBe(true);
    expect(args.local).toBe(true);
  });

  it("defaults data/creds to empty objects and flags to false", () => {
    const args = parseArgs(["--url", "https://x.com", "--goal", "g"]);
    expect(args.data).toEqual({});
    expect(args.credentials).toEqual({});
    expect(args.auto).toBe(false);
    expect(args.local).toBe(false);
  });

  it("throws on missing required flags", () => {
    expect(() => parseArgs(["--goal", "g"])).toThrow(/url/);
    expect(() => parseArgs(["--url", "https://x.com"])).toThrow(/goal/);
  });
});
