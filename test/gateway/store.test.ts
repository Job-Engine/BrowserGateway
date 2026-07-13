import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/testdb.js";
import { createJobStore, type JobStore } from "../../src/gateway/jobs/store.js";
import { createAuthStore } from "../../src/gateway/auth/tokens.js";
import type { JobEnvelope } from "../../src/gateway/types.js";

let db: TestDb;
let store: JobStore;
let callerA: string;
let callerB: string;

const claimDefaults = {
  globalCap: 10,
  defaultPlatformCap: 10,
  runDeadlineMs: 60_000,
};

function envelope(jobId: string, status: "success" | "failure" | "error" = "success"): JobEnvelope {
  return {
    jobId,
    useCase: "lightreach.ntpDate",
    status,
    meta: { ranAt: new Date().toISOString(), durationMs: 5, attempts: 1 },
  };
}

function enqueueParams(overrides: Partial<Parameters<JobStore["enqueue"]>[0]> = {}) {
  return {
    useCase: "lightreach.ntpDate",
    client: "default",
    platform: "lightreach",
    input: { name: "Jane", address: "123 Way" },
    callerId: callerA,
    ...overrides,
  };
}

beforeAll(async () => {
  db = await createTestDb();
  store = createJobStore(db.pool);
  const auth = createAuthStore(db.pool);
  callerA = (await auth.issueToken("caller-a", ["*:*"])).caller.id;
  callerB = (await auth.issueToken("caller-b", ["*:*"])).caller.id;
});

afterAll(async () => {
  await db.teardown();
});

describe("job store (C3)", () => {
  it("enqueues QUEUED jobs and survives lookups", async () => {
    const { job } = await store.enqueue(enqueueParams());
    expect(job.state).toBe("QUEUED");
    expect(job.attempts).toBe(0);
    const fetched = await store.get(job.id);
    expect(fetched?.useCase).toBe("lightreach.ntpDate");
  });

  it("deduplicates by idempotency key per caller", async () => {
    const first = await store.enqueue(enqueueParams({ idempotencyKey: "idem-1" }));
    const second = await store.enqueue(enqueueParams({ idempotencyKey: "idem-1" }));
    expect(second.deduplicated).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    // A different caller with the same key gets their own job.
    const other = await store.enqueue(
      enqueueParams({ callerId: callerB, idempotencyKey: "idem-1" }),
    );
    expect(other.deduplicated).toBe(false);
    expect(other.job.id).not.toBe(first.job.id);
  });

  it("S1: getForCaller hides other callers' jobs", async () => {
    const { job } = await store.enqueue(enqueueParams());
    expect(await store.getForCaller(job.id, callerA)).not.toBeNull();
    expect(await store.getForCaller(job.id, callerB)).toBeNull();
  });

  it("claims set RUNNING, bump attempts, stamp a deadline", async () => {
    const claimed = await store.claimNext(claimDefaults);
    expect(claimed).not.toBeNull();
    expect(claimed?.state).toBe("RUNNING");
    expect(claimed?.attempts).toBe(1);
    // Release the credential so later tests can claim (WL serialization).
    await store.complete(claimed!.id, envelope(claimed!.id));
  });

  it("advances to DONE only from RUNNING and only with an envelope", async () => {
    const { job } = await store.enqueue(enqueueParams());
    // Not running yet: complete refuses.
    expect(await store.complete(job.id, envelope(job.id))).toBe(false);
    // Drain claims until our job is the one claimed.
    let claimed = await store.claimNext(claimDefaults);
    const seen = new Set<string>();
    while (claimed && claimed.id !== job.id && !seen.has(claimed.id)) {
      seen.add(claimed.id);
      await store.complete(claimed.id, envelope(claimed.id));
      claimed = await store.claimNext(claimDefaults);
    }
    expect(claimed?.id).toBe(job.id);
    expect(await store.complete(job.id, envelope(job.id))).toBe(true);
    const done = await store.get(job.id);
    expect(done?.state).toBe("DONE");
    expect(done?.envelope?.status).toBe("success");
    // Double-complete refuses.
    expect(await store.complete(job.id, envelope(job.id))).toBe(false);
  });
});

describe("queue caps (C2)", () => {
  it("enforces the global concurrency cap", async () => {
    const dbx = await createTestDb();
    const s = createJobStore(dbx.pool);
    const auth = createAuthStore(dbx.pool);
    const caller = (await auth.issueToken("cap-caller", ["*:*"])).caller.id;
    await s.enqueue(enqueueParams({ callerId: caller }));
    await s.enqueue(enqueueParams({ callerId: caller }));
    const first = await s.claimNext({ ...claimDefaults, globalCap: 1 });
    expect(first).not.toBeNull();
    const second = await s.claimNext({ ...claimDefaults, globalCap: 1 });
    expect(second).toBeNull();
    await s.complete(first!.id, envelope(first!.id));
    const third = await s.claimNext({ ...claimDefaults, globalCap: 1 });
    expect(third).not.toBeNull();
    await dbx.teardown();
  });

  it("enforces per-platform caps while other platforms stay claimable", async () => {
    const dbx = await createTestDb();
    const s = createJobStore(dbx.pool);
    const auth = createAuthStore(dbx.pool);
    const caller = (await auth.issueToken("cap-caller-2", ["*:*"])).caller.id;
    await s.enqueue(enqueueParams({ callerId: caller, platform: "lightreach" }));
    await s.enqueue(enqueueParams({ callerId: caller, platform: "lightreach" }));
    await s.enqueue(enqueueParams({ callerId: caller, platform: "otherportal" }));
    const caps = { ...claimDefaults, platformCaps: { lightreach: 1 } };
    const first = await s.claimNext(caps);
    expect(first?.platform).toBe("lightreach");
    const second = await s.claimNext(caps);
    // lightreach is at cap; the other platform is claimable.
    expect(second?.platform).toBe("otherportal");
    const third = await s.claimNext(caps);
    expect(third).toBeNull();
    await dbx.teardown();
  });

  it("WL: serializes runs per platform.client credential", async () => {
    const dbx = await createTestDb();
    const s = createJobStore(dbx.pool);
    const auth = createAuthStore(dbx.pool);
    const caller = (await auth.issueToken("serial-caller", ["*:*"])).caller.id;
    await s.enqueue(enqueueParams({ callerId: caller, client: "lgcyco" }));
    await s.enqueue(enqueueParams({ callerId: caller, client: "lgcyco" }));
    await s.enqueue(enqueueParams({ callerId: caller, client: "brandx" }));
    const first = await s.claimNext(claimDefaults);
    expect(first?.client).toBe("lgcyco");
    const second = await s.claimNext(claimDefaults);
    // Same credential is busy; the other client's job runs instead.
    expect(second?.client).toBe("brandx");
    expect(await s.claimNext(claimDefaults)).toBeNull();
    await s.complete(first!.id, envelope(first!.id));
    expect((await s.claimNext(claimDefaults))?.client).toBe("lgcyco");
    await dbx.teardown();
  });

  it("sweeps RUNNING jobs past their deadline into TIMEOUT envelopes", async () => {
    const dbx = await createTestDb();
    const s = createJobStore(dbx.pool);
    const auth = createAuthStore(dbx.pool);
    const caller = (await auth.issueToken("sweep-caller", ["*:*"])).caller.id;
    const { job } = await s.enqueue(enqueueParams({ callerId: caller }));
    await s.claimNext({ ...claimDefaults, runDeadlineMs: 0 });
    await new Promise((r) => setTimeout(r, 25));
    const reaped = await s.sweepExpired();
    expect(reaped.map((j) => j.id)).toContain(job.id);
    const done = await s.get(job.id);
    expect(done?.state).toBe("DONE");
    expect(done?.envelope?.status).toBe("error");
    expect(done?.envelope?.error?.code).toBe("TIMEOUT");
    expect(done?.envelope?.meta.attempts).toBe(1);
    await dbx.teardown();
  });
});
