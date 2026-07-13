// Queue worker (C2): claims QUEUED jobs under concurrency caps, executes them,
// and writes envelopes. Retries system errors once via requeue; never retries
// a clean business failure. Sits between jobs/store.ts and runner.ts.
import type { JobEnvelope } from "../types.js";
import type { JobRow, JobStore } from "../jobs/store.js";
import type { Logger } from "../observability/logger.js";

export interface QueueConfig {
  globalCap: number;
  platformCaps?: Record<string, number>;
  defaultPlatformCap: number;
  /** DB-side deadline stamped at claim; the reaper sweep enforces it. */
  runDeadlineMs: number;
  pollIntervalMs: number;
  sweepIntervalMs: number;
  /** Total attempts a job may consume before its error envelope is final. */
  maxAttempts: number;
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  globalCap: 3,
  defaultPlatformCap: 2,
  runDeadlineMs: 330_000,
  pollIntervalMs: 500,
  sweepIntervalMs: 10_000,
  maxAttempts: 2,
};

/** Error codes worth a retry: transient system problems, not deterministic outcomes. */
const RETRYABLE_CODES = new Set(["RUN_ERROR", "AUTH_UNAVAILABLE", "GATEWAY_ERROR"]);

export interface QueueWorkerDeps {
  store: JobStore;
  /** Executes one job end to end; production wires runner.runJob. */
  execute: (job: JobRow) => Promise<JobEnvelope>;
  logger: Logger;
  config?: Partial<QueueConfig>;
}

export function createQueueWorker(deps: QueueWorkerDeps) {
  const config: QueueConfig = { ...DEFAULT_QUEUE_CONFIG, ...deps.config };
  const { store, execute } = deps;
  const log = deps.logger.child({ module: "queue" });
  const inFlight = new Set<Promise<void>>();
  let running = false;
  let loopPromise: Promise<void> | null = null;

  function fallbackEnvelope(job: JobRow, message: string): JobEnvelope {
    return {
      jobId: job.id,
      useCase: job.useCase,
      status: "error",
      error: { code: "GATEWAY_ERROR", message },
      meta: {
        ranAt: job.startedAt ?? job.createdAt,
        durationMs: job.startedAt ? Date.now() - Date.parse(job.startedAt) : 0,
        attempts: job.attempts,
      },
    };
  }

  async function settle(job: JobRow, envelope: JobEnvelope): Promise<void> {
    const retryable =
      envelope.status === "error" &&
      envelope.error !== undefined &&
      RETRYABLE_CODES.has(envelope.error.code) &&
      job.attempts < config.maxAttempts;
    if (retryable) {
      await store.requeue(job.id);
      log.warn(
        { jobId: job.id, attempts: job.attempts, code: envelope.error?.code },
        "job requeued",
      );
      return;
    }
    // attempts in the envelope reflects the store's count, not runner guesses.
    envelope.meta.attempts = job.attempts;
    await store.complete(job.id, envelope);
    log.info({ jobId: job.id, status: envelope.status, attempts: job.attempts }, "job done");
  }

  function launch(job: JobRow): void {
    const p = (async () => {
      let envelope: JobEnvelope;
      try {
        envelope = await execute(job);
      } catch (e) {
        envelope = fallbackEnvelope(job, e instanceof Error ? e.message : String(e));
      }
      try {
        await settle(job, envelope);
      } catch (e) {
        log.error({ jobId: job.id, err: e }, "failed to persist job outcome");
      }
    })();
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  }

  async function loop(): Promise<void> {
    let lastSweep = 0;
    while (running) {
      try {
        if (Date.now() - lastSweep >= config.sweepIntervalMs) {
          lastSweep = Date.now();
          const reaped = await store.sweepExpired();
          if (reaped.length > 0) {
            log.warn({ jobIds: reaped.map((j) => j.id) }, "reaped jobs past deadline");
          }
        }
        const job = await store.claimNext({
          globalCap: config.globalCap,
          platformCaps: config.platformCaps,
          defaultPlatformCap: config.defaultPlatformCap,
          runDeadlineMs: config.runDeadlineMs,
        });
        if (job) {
          log.info({ jobId: job.id, useCase: job.useCase, client: job.client }, "job claimed");
          launch(job);
          continue; // drain the queue before sleeping
        }
      } catch (e) {
        log.error({ err: e }, "queue loop error");
      }
      await new Promise((r) => setTimeout(r, config.pollIntervalMs));
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      loopPromise = loop();
    },
    /** Graceful drain (M4): stop claiming, let in-flight runs finish. */
    async stop(): Promise<void> {
      running = false;
      await loopPromise;
      await Promise.allSettled([...inFlight]);
    },
    inFlightCount(): number {
      return inFlight.size;
    },
  };
}

export type QueueWorker = ReturnType<typeof createQueueWorker>;
