import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { getEntry, CATALOGUE } from "./catalogue.js";
import { runJob } from "./runner.js";
import type { JobRecord } from "./types.js";

/**
 * Browser Automation Gateway.
 *
 * Callers POST a job (useCase + business input); the gateway resolves portal
 * credentials from 1Password, runs the browser automation, and returns a
 * normalized envelope. Callers never see credentials, agent IDs, or Browserbase.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /catalogue                 -> list of available useCases
 *   POST /jobs { useCase, input }   -> { jobId } (202, async)
 *   GET  /jobs/:id                  -> { state, envelope? }
 *
 * Auth: if GATEWAY_TOKEN is set, callers must send it as `authorization: Bearer <token>`.
 */

const PORT = Number(process.env.PORT ?? 8080);
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;

// In-memory job store. Swap for Redis/DB when you need durability across restarts.
const jobs = new Map<string, JobRecord>();

function readJson(req: IncomingMessage): Promise<unknown> {
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

function authorized(req: IncomingMessage): boolean {
  if (!GATEWAY_TOKEN) return true;
  return req.headers.authorization === `Bearer ${GATEWAY_TOKEN}`;
}

const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  const send = (code: number, body: unknown) => {
    res.writeHead(code);
    res.end(JSON.stringify(body));
  };

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === "GET" && path === "/health") return send(200, { ok: true });

  if (!authorized(req)) return send(401, { error: "unauthorized" });

  if (req.method === "GET" && path === "/catalogue") {
    return send(200, { useCases: Object.keys(CATALOGUE) });
  }

  if (req.method === "POST" && path === "/jobs") {
    let body: { useCase?: string; input?: unknown };
    try {
      body = (await readJson(req)) as typeof body;
    } catch {
      return send(400, { error: "invalid JSON body" });
    }
    if (!body.useCase) return send(400, { error: "useCase is required" });

    let entry;
    try {
      entry = getEntry(body.useCase);
    } catch (e) {
      return send(400, { error: e instanceof Error ? e.message : String(e) });
    }

    const jobId = randomUUID();
    const record: JobRecord = {
      jobId,
      useCase: entry.useCase,
      state: "PENDING",
      createdAt: new Date().toISOString(),
    };
    jobs.set(jobId, record);

    // Fire and forget; caller polls GET /jobs/:id.
    void (async () => {
      record.state = "RUNNING";
      try {
        record.envelope = await runJob(jobId, entry, body.input);
      } catch (e) {
        record.envelope = {
          jobId,
          useCase: entry.useCase,
          status: "error",
          error: { code: "GATEWAY_ERROR", message: e instanceof Error ? e.message : String(e) },
          meta: { ranAt: record.createdAt, durationMs: 0, attempts: 1 },
        };
      } finally {
        record.state = "DONE";
      }
    })();

    return send(202, { jobId, state: record.state });
  }

  const jobMatch = path.match(/^\/jobs\/([0-9a-f-]+)$/i);
  if (req.method === "GET" && jobMatch) {
    const record = jobs.get(jobMatch[1]);
    if (!record) return send(404, { error: "job not found" });
    return send(200, { jobId: record.jobId, state: record.state, envelope: record.envelope });
  }

  return send(404, { error: "not found" });
});

server.listen(PORT, () => {
  process.stdout.write(`browser-automation-gateway listening on http://localhost:${PORT}\n`);
});
