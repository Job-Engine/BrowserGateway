import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "./helpers/testdb.js";
import { createPool, migrate } from "../../src/gateway/db.js";
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

const logger = createLogger("silent");

beforeAll(async () => {
  db = await createTestDb();
  store = createJobStore(db.pool);
  registry = createRegistry(db.pool);
  await registry.seed();
  const auth = createAuthStore(db.pool);
  callerId = (await auth.issueToken("gaps-caller", ["*:*"])).caller.id;
});

afterAll(async () => {
  await db.teardown();
});

describe("db module", () => {
  it("createPool fails closed without a DATABASE_URL", () => {
    const original = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => createPool()).toThrow(/DATABASE_URL/);
    } finally {
      if (original !== undefined) process.env.DATABASE_URL = original;
    }
  });

  it("migrate is idempotent: a second run applies nothing", async () => {
    const applied = await migrate(db.pool);
    expect(applied).toEqual([]);
  });
});

describe("job store listings", () => {
  it("lists jobs newest first with and without a state filter", async () => {
    await store.enqueue({
      useCase: "lightreach.ntpDate",
      client: "default",
      platform: "lightreach",
      input: { name: "A", address: "B" },
      callerId,
    });
    const all = await store.list({ limit: 10 });
    expect(all.length).toBeGreaterThan(0);
    const queued = await store.list({ state: "QUEUED", limit: 10 });
    expect(queued.every((j) => j.state === "QUEUED")).toBe(true);
    const counts = await store.countByState();
    expect(counts.QUEUED).toBeGreaterThan(0);
  });
});

describe("canary alerting", () => {
  it("posts failed canary verdicts to the Slack webhook when configured", async () => {
    // Promote a pair with a recorded test so the canary has a target.
    await registry.validateAction("lightreach.ntpDate", "gaps");
    await db.pool.query(
      `update action_clients set state = 'live', test_input = $2
       where use_case = $1 and client = 'default'`,
      ["lightreach.ntpDate", JSON.stringify({ name: "Known", address: "Record" })],
    );

    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        posts.push(init?.body ?? "");
        return new Response("ok");
      }),
    );
    try {
      const canary = createCanaryScheduler({
        store,
        registry,
        logger,
        callerId,
        intervalMs: 0,
        slackWebhookUrl: "https://hooks.slack.example/services/T000/B000/xyz",
      });
      const [jobId] = await canary.runOnce();
      // Drain older queued jobs until the canary job itself is claimed.
      let claimed = await store.claimNext({
        globalCap: 10,
        defaultPlatformCap: 10,
        runDeadlineMs: 60_000,
      });
      while (claimed && claimed.id !== jobId) {
        await store.complete(claimed.id, {
          jobId: claimed.id,
          useCase: claimed.useCase,
          client: claimed.client,
          status: "success",
          meta: { ranAt: new Date().toISOString(), durationMs: 1, attempts: 1 },
        });
        claimed = await store.claimNext({
          globalCap: 10,
          defaultPlatformCap: 10,
          runDeadlineMs: 60_000,
        });
      }
      expect(claimed?.id).toBe(jobId);
      const envelope: JobEnvelope = {
        jobId: claimed!.id,
        useCase: "lightreach.ntpDate",
        client: "default",
        status: "error",
        error: { code: "RUN_ERROR", message: "login failed" },
        meta: { ranAt: new Date().toISOString(), durationMs: 3, attempts: 1 },
      };
      await store.complete(claimed!.id, envelope);
      await canary.collectVerdicts();
      expect(posts).toHaveLength(1);
      expect(posts[0]).toContain("Canary failed");
      expect(posts[0]).toContain(jobId);

      // start()/stop() are safe with a disabled interval.
      canary.start();
      canary.stop();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
