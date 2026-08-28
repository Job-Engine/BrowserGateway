import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/testdb.js";
import { createJobStore, type JobStore } from "../../src/gateway/jobs/store.js";
import { createAuthStore } from "../../src/gateway/auth/tokens.js";
import { createLogger } from "../../src/gateway/observability/logger.js";
import { createRegistry } from "../../src/gateway/registry.js";
import { createTraceStore } from "../../src/gateway/traces.js";
import { createQueueWorker, type QueueWorker } from "../../src/gateway/queue/worker.js";
import { buildApp, type App } from "../../src/gateway/api/app.js";
import { ERROR_CODES as SERVER_ERROR_CODES } from "../../src/gateway/api/openapi.js";
import {
  ERROR_CODES as SDK_ERROR_CODES,
  GatewayClient,
  GatewayError,
} from "../../packages/gateway-client/src/index.js";

let db: TestDb;
let app: App;
let store: JobStore;
let worker: QueueWorker;
let baseUrl: string;
let token: string;

const goodInput = { name: "Jane Homeowner", address: "123 Solar Way, Austin TX 78701" };

beforeAll(async () => {
  db = await createTestDb();
  store = createJobStore(db.pool);
  const auth = createAuthStore(db.pool);
  const registry = createRegistry(db.pool);
  await registry.seed();
  await db.pool.query(
    `update action_clients set state = 'live'
     where use_case = 'lightreach.ntpDate' and client = 'default'`,
  );
  token = (await auth.issueToken("sdk-app", ["lightreach.ntpDate:default"])).token;
  const logger = createLogger("silent");
  const traces = createTraceStore(db.pool);
  app = buildApp({ store, auth, logger, registry, traces });
  worker = createQueueWorker({
    store,
    logger,
    execute: async (job) => ({
      jobId: job.id,
      useCase: job.useCase,
      client: job.client,
      status: "success",
      data: { matchVerified: true, ntpDateFound: true, ntpDate: "2026-06-30" },
      meta: { ranAt: new Date().toISOString(), durationMs: 12, attempts: 1, stepsUsed: 4 },
    }),
    config: { pollIntervalMs: 20, sweepIntervalMs: 60_000 },
  });
  worker.start();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await worker.stop();
  await app.close();
  await db.teardown();
});

describe("@job-engine/gateway-client", () => {
  it("keeps the error-code enum in parity with the server", () => {
    expect([...SDK_ERROR_CODES].sort()).toEqual([...SERVER_ERROR_CODES].sort());
  });

  it("submits, polls, and returns the envelope over real HTTP", async () => {
    const client = new GatewayClient({ baseUrl, token });
    const envelope = await client.run(
      { useCase: "lightreach.ntpDate", input: goodInput, idempotencyKey: "sdk-run-1" },
      { pollIntervalMs: 25, timeoutMs: 10_000 },
    );
    expect(envelope.status).toBe("success");
    expect(envelope.meta.attempts).toBe(1);
    expect((envelope.data as { ntpDate: string }).ntpDate).toBe("2026-06-30");
  });

  it("surfaces gateway refusals as GatewayError with the status code", async () => {
    const client = new GatewayClient({ baseUrl, token });
    await expect(
      client.submitJob({ useCase: "lightreach.ntpDate", client: "brandx", input: goodInput }),
    ).rejects.toMatchObject({ name: "GatewayError", statusCode: 403 });
    await expect(client.getJob("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
      GatewayError,
    );
  });
});
