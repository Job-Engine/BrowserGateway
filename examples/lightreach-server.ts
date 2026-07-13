/**
 * Minimal backend endpoint that exposes the Lightreach NTP Agent to your app.
 *
 * Why a backend: your BROWSERBASE_API_KEY must never ship to a browser/mobile
 * client. Your app calls THIS endpoint; this endpoint calls Browserbase.
 *
 * Run locally:
 *   BROWSERBASE_API_KEY=... BB_AGENT_ID=... npx tsx examples/lightreach-server.ts
 *
 * Then from your app:
 *   POST http://localhost:8787/ntp-check
 *   { "name": "Jane Homeowner", "address": "123 Solar Way, Austin TX 78701", "projectId": "LR-123" }
 *
 * No web framework required; uses the built-in node:http server.
 */
import { createServer } from "node:http";
import { runLightreachNtpCheck, type LightreachRecord } from "../src/lightreachAgent.js";

const PORT = Number(process.env.PORT ?? 8787);

function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST" || req.url !== "/ntp-check") {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "POST /ntp-check only" }));
    return;
  }

  try {
    const body = (await readJson(req)) as Partial<LightreachRecord>;
    if (!body.name || !body.address) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "name and address are required" }));
      return;
    }

    const { runId, run, result } = await runLightreachNtpCheck(
      { name: body.name, address: body.address, projectId: body.projectId },
      {
        proxies: true, // portals often need this; drop if not required
        contextId: process.env.BB_CONTEXT_ID, // reuse a logged-in Context if you have one
        timeoutMs: 5 * 60_000,
      },
    );

    // Always return the troubleshooting handles the caller asked for.
    res.writeHead(run.status === "COMPLETED" && result?.status === "success" ? 200 : 502);
    res.end(
      JSON.stringify({
        runId,
        runStatus: run.status,
        sessionId: run.sessionId ?? result?.sessionId,
        result,
      }),
    );
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
});

server.listen(PORT, () => {
  process.stdout.write(`lightreach ntp endpoint listening on http://localhost:${PORT}/ntp-check\n`);
});
