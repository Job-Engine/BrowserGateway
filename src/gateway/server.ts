// Gateway bootstrap: pool, migrations, stores, queue worker, Fastify API,
// graceful shutdown (M4). This file only wires modules together; tests target
// the modules directly.
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createPool, migrate } from "./db.js";
import { createLogger } from "./observability/logger.js";
import { createJobStore } from "./jobs/store.js";
import { createAuthStore, hashToken } from "./auth/tokens.js";
import { buildApp } from "./api/app.js";
import { createQueueWorker } from "./queue/worker.js";
import { createRegistry } from "./registry.js";
import { createCanaryScheduler } from "./canary/scheduler.js";
import { resolveAction } from "./catalogue.js";
import { runJob } from "./runner.js";
import { createTraceStore } from "./traces.js";

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function main(): Promise<void> {
  const logger = createLogger();
  const pool = createPool();
  const applied = await migrate(pool);
  if (applied.length > 0) logger.info({ applied }, "migrations applied");

  const store = createJobStore(pool);
  const auth = createAuthStore(pool);
  const registry = createRegistry(pool);
  await registry.seed();
  const traces = createTraceStore(pool);

  // Local-dev convenience only: GATEWAY_DEV_TOKEN seeds one admin caller so a
  // fresh checkout can talk to itself. Without it the API is fail-closed.
  if (process.env.GATEWAY_DEV_TOKEN) {
    await pool.query(
      `insert into callers (name, token_hash, scopes, is_admin)
       values ('dev', $1, '["*:*"]', true)
       on conflict (name) do update set token_hash = excluded.token_hash`,
      [hashToken(process.env.GATEWAY_DEV_TOKEN)],
    );
    logger.warn("dev caller active (GATEWAY_DEV_TOKEN); do not set in production");
  }

  // System caller canary jobs run as; its token is random and discarded.
  const canaryCaller = await pool.query(
    `insert into callers (name, token_hash, scopes, is_admin)
     values ('canary-system', $1, '["*:*"]', false)
     on conflict (name) do update set disabled = callers.disabled
     returning id`,
    [hashToken(`bgw_${randomBytes(24).toString("base64url")}`)],
  );

  const queue = createQueueWorker({
    store,
    logger,
    execute: (job) =>
      runJob(job.id, resolveAction(job.useCase, job.client), job.input, {
        traces,
        audit: (a, e, d) => registry.audit("system", a, e, d),
      }),
    config: {
      globalCap: intEnv("GATEWAY_GLOBAL_CAP", 3),
      defaultPlatformCap: intEnv("GATEWAY_PLATFORM_CAP", 2),
      // Must exceed the largest per-client runner timeout or the reaper
      // kills healthy runs.
      runDeadlineMs: intEnv("GATEWAY_RUN_DEADLINE_MS", 660_000),
      costPerStepUsd: Number(process.env.GATEWAY_COST_PER_STEP_USD ?? 0) || 0,
    },
  });

  const canary = createCanaryScheduler({
    store,
    registry,
    logger,
    callerId: canaryCaller.rows[0].id,
    intervalMs: intEnv("GATEWAY_CANARY_INTERVAL_MS", 0),
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
  });

  const app = buildApp({ store, auth, logger, registry, canary, traces });
  queue.start();
  canary.start();
  await app.listen({ port: intEnv("PORT", 8080), host: "0.0.0.0" });
  logger.info({ port: intEnv("PORT", 8080) }, "gateway listening");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down: draining queue");
    canary.stop();
    await app.close();
    await queue.stop();
    await pool.end();
    logger.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`gateway failed to start: ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  });
}
