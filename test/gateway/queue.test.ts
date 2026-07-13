import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/testdb.js";
import { createJobStore, type JobRow, type JobStore } from "../../src/gateway/jobs/store.js";
import { createAuthStore } from "../../src/gateway/auth/tokens.js";
import { createLogger } from "../../src/gateway/observability/logger.js";
import { createQueueWorker } from "../../src/gateway/queue/worker.js";
import type { JobEnvelope } from "../../src/gateway/types.js";

let db: TestDb;
let store: JobStore;
let callerId: string;

const logger = createLogger("silent");

function envelopeFor(job: JobRow, status: "success" | "error", code?: string): JobEnvelope {
  return {
    jobId: job.id,
    useCase: job.useCase,
    status,
    error: status === "error" ? { code: code ?? "RUN_ERROR", message: "boom" } : undefined,
    meta: { ranAt: new Date().toISOString(), durationMs: 1, attempts: 1 },
  };
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition not reached in time");
}

beforeAll(async () => {
  db = await createTestDb();
  store = createJobStore(db.pool);
  const auth = createAuthStore(db.pool);
  callerId = (await auth.issueToken("queue-caller", ["*:*"])).caller.id;
});

afterAll(async () => {
  await db.teardown();
});

function enqueue(n = 1) {
  return Promise.all(
    Array.from({ length: n }, () =>
      store
        .enqueue({
          useCase: "lightreach.ntpDate",
          client: "default",
          platform: "lightreach",
          input: { name: "Jane", address: "123" },
          callerId,
        })
        .then((r) => r.job),
    ),
  );
}

describe("queue worker", () => {
  it("runs every queued job to DONE and stamps real attempt counts", async () => {
    const jobs = await enqueue(3);
    let peak = 0;
    let current = 0;
    const worker = createQueueWorker({
      store,
      logger,
      execute: async (job) => {
        current++;
        peak = Math.max(peak, current);
        await new Promise((r) => setTimeout(r, 40));
        current--;
        return envelopeFor(job, "success");
      },
      config: { globalCap: 1, defaultPlatformCap: 1, pollIntervalMs: 15, sweepIntervalMs: 60_000 },
    });
    worker.start();
    await waitFor(async () => {
      const states = await Promise.all(jobs.map((j) => store.get(j.id)));
      return states.every((j) => j?.state === "DONE");
    });
    await worker.stop();
    expect(peak).toBe(1); // global cap respected end to end
    const done = await store.get(jobs[0].id);
    expect(done?.envelope?.meta.attempts).toBe(1);
  });

  it("retries a retryable error once, then succeeds", async () => {
    const [job] = await enqueue(1);
    const attemptsSeen: number[] = [];
    const worker = createQueueWorker({
      store,
      logger,
      execute: async (j) => {
        attemptsSeen.push(j.attempts);
        return envelopeFor(j, attemptsSeen.length === 1 ? "error" : "success");
      },
      config: { pollIntervalMs: 15, sweepIntervalMs: 60_000, maxAttempts: 2 },
    });
    worker.start();
    await waitFor(async () => (await store.get(job.id))?.state === "DONE");
    await worker.stop();
    const done = await store.get(job.id);
    expect(attemptsSeen).toEqual([1, 2]);
    expect(done?.envelope?.status).toBe("success");
    expect(done?.envelope?.meta.attempts).toBe(2);
  });

  it("does not retry past maxAttempts or on non-retryable outcomes", async () => {
    const [errJob] = await enqueue(1);
    let calls = 0;
    const worker = createQueueWorker({
      store,
      logger,
      execute: async (j) => {
        calls++;
        return envelopeFor(j, "error", "ACTION_BLOCKED");
      },
      config: { pollIntervalMs: 15, sweepIntervalMs: 60_000, maxAttempts: 3 },
    });
    worker.start();
    await waitFor(async () => (await store.get(errJob.id))?.state === "DONE");
    await worker.stop();
    expect(calls).toBe(1); // ACTION_BLOCKED is deterministic; no retry
    const done = await store.get(errJob.id);
    expect(done?.envelope?.error?.code).toBe("ACTION_BLOCKED");
  });

  it("converts a throwing execute into a GATEWAY_ERROR envelope instead of losing the job", async () => {
    const [job] = await enqueue(1);
    const worker = createQueueWorker({
      store,
      logger,
      execute: async () => {
        throw new Error("runner exploded");
      },
      config: { pollIntervalMs: 15, sweepIntervalMs: 60_000, maxAttempts: 1 },
    });
    worker.start();
    await waitFor(async () => (await store.get(job.id))?.state === "DONE");
    await worker.stop();
    const done = await store.get(job.id);
    expect(done?.envelope?.status).toBe("error");
    expect(done?.envelope?.error?.code).toBe("GATEWAY_ERROR");
    expect(done?.envelope?.error?.message).toContain("runner exploded");
  });

  it("drains in-flight work on stop (M4)", async () => {
    const [job] = await enqueue(1);
    let finished = false;
    const worker = createQueueWorker({
      store,
      logger,
      execute: async (j) => {
        await new Promise((r) => setTimeout(r, 120));
        finished = true;
        return envelopeFor(j, "success");
      },
      config: { pollIntervalMs: 15, sweepIntervalMs: 60_000 },
    });
    worker.start();
    await waitFor(async () => (await store.get(job.id))?.state === "RUNNING");
    await worker.stop(); // must wait for the in-flight run
    expect(finished).toBe(true);
    expect((await store.get(job.id))?.state).toBe("DONE");
  });
});
