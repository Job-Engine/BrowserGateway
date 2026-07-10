import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createSession } from "../src/browser.js";
import { runLoop } from "../src/loop.js";
import type { BrowserAgent, ProposedAction } from "../src/types.js";

const RUN_LOCAL = process.env.WAA_ENV === "LOCAL";
const d = RUN_LOCAL ? describe : describe.skip;

let server: Server;
let baseUrl: string;
const html = readFileSync(fileURLToPath(new URL("./fixtures/form.html", import.meta.url)), "utf8");

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://localhost:${port}/`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const loopBase = {
  maxSteps: 12,
  maxObserveRetries: 2,
  maxConsecutiveFailures: 3,
  secretValues: [] as string[],
};

d("browser adapter + loop against a local form (real Stagehand)", () => {
  let agent: BrowserAgent;
  afterAll(async () => {
    await agent?.close();
  });

  it("fills the form and blocks the submit when the hook rejects it", async () => {
    agent = await createSession({ env: "LOCAL", model: "anthropic/claude-sonnet-4-6", headless: true });
    const risky: ProposedAction[] = [];
    const res = await runLoop({
      ...loopBase,
      agent,
      url: baseUrl,
      goal: "Fill in the full name and email, then submit the application.",
      variables: { name: "Ada Lovelace", email: "ada@example.com" },
      onBeforeAction: async (a) => {
        risky.push(a);
        return false; // reject the submit
      },
      extractSchema: z.object({ result: z.string() }),
    });

    expect(res.status).toBe("blocked");
    expect(risky.some((a) => /submit/i.test(a.description) || /submit/i.test(a.instruction))).toBe(true);
    expect(res.actionsLog.some((r) => r.outcome === "executed")).toBe(true); // at least one field was filled
  });
});
