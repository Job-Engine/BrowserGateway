// Gateway bootstrap: pool, migrations, stores, queue worker, Fastify API,
// graceful shutdown (M4). This file only wires modules together; tests target
// the modules directly.
import { pathToFileURL } from "node:url";
import { createPool, migrate } from "./db.js";
import { createLogger } from "./observability/logger.js";
import { createJobStore } from "./jobs/store.js";
import { createAuthStore, hashToken } from "./auth/tokens.js";
import { buildApp } from "./api/app.js";
import { createQueueWorker } from "./queue/worker.js";
import { getEntry } from "./catalogue.js";
import { runJob } from "./runner.js";

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

  const queue = createQueueWorker({
    store,
    logger,
    execute: (job) => runJob(job.id, getEntry(job.useCase), job.input),
    config: {
      globalCap: intEnv("GATEWAY_GLOBAL_CAP", 3),
      defaultPlatformCap: intEnv("GATEWAY_PLATFORM_CAP", 2),
    },
  });

  const app = buildApp({ store, auth, logger });
  queue.start();
  await app.listen({ port: intEnv("PORT", 8080), host: "0.0.0.0" });
  logger.info({ port: intEnv("PORT", 8080) }, "gateway listening");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down: draining queue");
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
