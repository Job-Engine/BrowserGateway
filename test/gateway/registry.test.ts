import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/testdb.js";
import { createJobStore, type JobStore } from "../../src/gateway/jobs/store.js";
import { createAuthStore } from "../../src/gateway/auth/tokens.js";
import { createRegistry, type Registry } from "../../src/gateway/registry.js";
import { createCanaryScheduler } from "../../src/gateway/canary/scheduler.js";
import { createLogger } from "../../src/gateway/observability/logger.js";
import type { JobEnvelope } from "../../src/gateway/types.js";

let db: TestDb;
let store: JobStore;
let registry: Registry;
let callerId: string;

const USE_CASE = "lightreach.ntpDate";
const input = { name: "Jane Homeowner", address: "123 Solar Way" };

function successEnvelope(jobId: string, matchVerified = true): JobEnvelope {
  return {
    jobId,
    useCase: USE_CASE,
    client: "default",
    status: "success",
    data: { matchVerified, ntpDateFound: true, ntpDate: "2026-06-30" },
    meta: { ranAt: new Date().toISOString(), durationMs: 5, attempts: 1 },
  };
}

/** Enqueue + claim + complete one job, returning its id. */
async function completedJob(envelopeStatus: "success" | "error", client = "default") {
  const { job } = await store.enqueue({
    useCase: USE_CASE,
    client,
    platform: "lightreach",
    input,
    callerId,
  });
  let claimed = null;
  while (!claimed || claimed.id !== job.id) {
    claimed = await store.claimNext({
      globalCap: 10,
      defaultPlatformCap: 10,
      runDeadlineMs: 60_000,
    });
    if (!claimed) throw new Error("claim failed");
    if (claimed.id !== job.id) {
      await store.complete(claimed.id, successEnvelope(claimed.id));
      claimed = null;
    }
  }
  const envelope =
    envelopeStatus === "success"
      ? { ...successEnvelope(job.id), client }
      : ({
          jobId: job.id,
          useCase: USE_CASE,
          client,
          status: "error",
          error: { code: "RUN_ERROR", message: "boom" },
          meta: { ranAt: new Date().toISOString(), durationMs: 5, attempts: 1 },
        } as JobEnvelope);
  await store.complete(job.id, envelope);
  return job.id;
}

beforeAll(async () => {
  db = await createTestDb();
  store = createJobStore(db.pool);
  registry = createRegistry(db.pool);
  await registry.seed();
  const auth = createAuthStore(db.pool);
  callerId = (await auth.issueToken("lifecycle-caller", ["*:*"])).caller.id;
});

afterAll(async () => {
  await db.teardown();
});

describe("registry seed and lifecycle (OPS)", () => {
  it("seeds platforms, actions, and pairs as draft/disabled; seeding twice is idempotent", async () => {
    await registry.seed();
    const pairs = await registry.listCatalogue();
    const ours = pairs.filter((p) => p.useCase === USE_CASE);
    expect(ours.map((p) => p.client).sort()).toEqual(["brandx", "default", "lgcyco", "spartan"]);
    expect(ours.every((p) => p.clientState === "disabled")).toBe(true);
    expect(ours[0].actionState).toBe("draft");
  });

  it("cannot go live without a recorded passing test (first-live-run rule in code)", async () => {
    const result = await registry.setLive(USE_CASE, "default", "tester");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("first-live-run");
    expect(await registry.isLive(USE_CASE, "default")).toBe(false);
  });

  it("test runs do not count before the action passes the validation lint gate", async () => {
    const jobId = await completedJob("success");
    const early = await registry.recordTestRun(USE_CASE, "default", jobId, "tester");
    expect(early.ok).toBe(false);
    expect(early.reason).toContain("validated");
  });

  it("walks draft -> validated -> tested -> live and records the audit trail", async () => {
    const validation = await registry.validateAction(USE_CASE, "tester");
    expect(validation).toEqual({ ok: true, problems: [] });

    const failedJob = await completedJob("error");
    const rejected = await registry.recordTestRun(USE_CASE, "default", failedJob, "tester");
    expect(rejected.ok).toBe(false);

    const passedJob = await completedJob("success");
    const recorded = await registry.recordTestRun(USE_CASE, "default", passedJob, "tester");
    expect(recorded.ok).toBe(true);

    const live = await registry.setLive(USE_CASE, "default", "tester");
    expect(live.ok).toBe(true);
    expect(await registry.isLive(USE_CASE, "default")).toBe(true);
    // The other clients stay dark: enablement is per client.
    expect(await registry.isLive(USE_CASE, "lgcyco")).toBe(false);

    const audit = await registry.listAudit();
    const actions = audit.map((a) => a.action);
    expect(actions).toContain("action.validated");
    expect(actions).toContain("pair.tested");
    expect(actions).toContain("pair.live");
  });

  it("disabling a live pair takes it out of traffic immediately", async () => {
    await registry.disablePair(USE_CASE, "default", "tester");
    expect(await registry.isLive(USE_CASE, "default")).toBe(false);
    // Re-enable for the canary test below: the recorded test still stands.
    await db.pool.query(
      `update action_clients set state = 'live' where use_case = $1 and client = 'default'`,
      [USE_CASE],
    );
  });
});

describe("canary scheduler (OPS)", () => {
  it("enqueues canaries from recorded test inputs and records verdicts", async () => {
    const logger = createLogger("silent");
    const canary = createCanaryScheduler({
      store,
      registry,
      logger,
      callerId,
      intervalMs: 0,
    });

    const enqueued = await canary.runOnce();
    expect(enqueued).toHaveLength(1);

    // Simulate the queue completing the canary with a failure envelope.
    const claimed = await store.claimNext({
      globalCap: 10,
      defaultPlatformCap: 10,
      runDeadlineMs: 60_000,
    });
    expect(claimed?.id).toBe(enqueued[0]);
    await store.complete(claimed!.id, {
      jobId: claimed!.id,
      useCase: USE_CASE,
      client: "default",
      status: "error",
      error: { code: "RUN_ERROR", message: "layout drift" },
      meta: { ranAt: new Date().toISOString(), durationMs: 5, attempts: 1 },
    });

    await canary.collectVerdicts();
    const pairs = await registry.listCatalogue();
    const pair = pairs.find((p) => p.useCase === USE_CASE && p.client === "default");
    expect(pair?.lastCanaryStatus).toBe("error");
    expect(pair?.lastCanaryAt).not.toBeNull();
  });

  it("is idempotent within a schedule bucket", async () => {
    const logger = createLogger("silent");
    const canary = createCanaryScheduler({
      store,
      registry,
      logger,
      callerId,
      intervalMs: 3_600_000,
    });
    const first = await canary.runOnce();
    const second = await canary.runOnce();
    expect(first).toHaveLength(1);
    // Same idempotency bucket: the store returns the same job, no duplicate work.
    expect(second).toEqual(first);
  });
});
