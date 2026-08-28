// Durable Postgres job store (C3) with the QUEUED -> RUNNING -> DONE state
// machine. Claiming is the queue's entry point (queue/worker.ts); the API
// reads jobs with ownership enforced (S1). State reaches DONE only in the
// same statement that writes the envelope.
import type pg from "pg";
import type { JobEnvelope } from "../types.js";

export type JobState = "QUEUED" | "RUNNING" | "DONE";

export interface JobRow {
  id: string;
  useCase: string;
  client: string;
  platform: string;
  input: unknown;
  callerId: string;
  state: JobState;
  envelope: JobEnvelope | null;
  idempotencyKey: string | null;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface EnqueueParams {
  useCase: string;
  client: string;
  platform: string;
  input: unknown;
  callerId: string;
  idempotencyKey?: string;
}

export interface ClaimParams {
  /** Max jobs RUNNING across all platforms. */
  globalCap: number;
  /** Per-platform overrides; platforms absent fall back to defaultPlatformCap. */
  platformCaps?: Record<string, number>;
  defaultPlatformCap: number;
  /** Wall-clock budget stamped on the claimed job as deadline_at. */
  runDeadlineMs: number;
}

function rowToJob(r: Record<string, unknown>): JobRow {
  return {
    id: r.id as string,
    useCase: r.use_case as string,
    client: r.client as string,
    platform: r.platform as string,
    input: r.input,
    callerId: r.caller_id as string,
    state: r.state as JobState,
    envelope: (r.envelope as JobEnvelope) ?? null,
    idempotencyKey: (r.idempotency_key as string) ?? null,
    attempts: r.attempts as number,
    createdAt: (r.created_at as Date).toISOString(),
    startedAt: r.started_at ? (r.started_at as Date).toISOString() : null,
    finishedAt: r.finished_at ? (r.finished_at as Date).toISOString() : null,
  };
}

export function createJobStore(pool: pg.Pool) {
  return {
    /**
     * Insert a job, or return the existing one when the caller reuses an
     * idempotency key (retries never create duplicate work).
     */
    async enqueue(params: EnqueueParams): Promise<{ job: JobRow; deduplicated: boolean }> {
      const inserted = await pool.query(
        `insert into jobs (use_case, client, platform, input, caller_id, idempotency_key)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (caller_id, idempotency_key) where idempotency_key is not null
         do nothing
         returning *`,
        [
          params.useCase,
          params.client,
          params.platform,
          JSON.stringify(params.input),
          params.callerId,
          params.idempotencyKey ?? null,
        ],
      );
      if (inserted.rows[0]) return { job: rowToJob(inserted.rows[0]), deduplicated: false };
      const existing = await pool.query(
        `select * from jobs where caller_id = $1 and idempotency_key = $2`,
        [params.callerId, params.idempotencyKey],
      );
      return { job: rowToJob(existing.rows[0]), deduplicated: true };
    },

    /** Ownership-scoped read (S1): a caller sees only their own jobs. */
    async getForCaller(id: string, callerId: string): Promise<JobRow | null> {
      const res = await pool.query(`select * from jobs where id = $1 and caller_id = $2`, [
        id,
        callerId,
      ]);
      return res.rows[0] ? rowToJob(res.rows[0]) : null;
    },

    /** Unscoped read for the admin surface and the queue. */
    async get(id: string): Promise<JobRow | null> {
      const res = await pool.query(`select * from jobs where id = $1`, [id]);
      return res.rows[0] ? rowToJob(res.rows[0]) : null;
    },

    /**
     * Claim the oldest QUEUED job that fits under the global and per-platform
     * concurrency caps (C2). Serialized by an advisory lock so cap checks are
     * exact; FOR UPDATE SKIP LOCKED keeps concurrent claimers from colliding.
     */
    async claimNext(params: ClaimParams): Promise<JobRow | null> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(`select pg_advisory_xact_lock(hashtext('gateway-job-claim'))`);
        const res = await client.query(
          `with running as (
             select platform, count(*)::int as n from jobs where state = 'RUNNING' group by platform
           ),
           total as (select coalesce(sum(n), 0)::int as n from running),
           candidate as (
             select j.id from jobs j
             where j.state = 'QUEUED'
               and (select n from total) < $1
               and coalesce((select n from running r where r.platform = j.platform), 0)
                   < coalesce(($2::jsonb ->> j.platform)::int, $3)
               -- WL: one login per platform.client credential at a time
               and not exists (
                 select 1 from jobs r2
                 where r2.state = 'RUNNING' and r2.platform = j.platform and r2.client = j.client
               )
             order by j.created_at
             for update skip locked
             limit 1
           )
           update jobs set state = 'RUNNING',
                           started_at = now(),
                           attempts = attempts + 1,
                           deadline_at = now() + ($4 || ' milliseconds')::interval
           where id in (select id from candidate)
           returning *`,
          [
            params.globalCap,
            JSON.stringify(params.platformCaps ?? {}),
            params.defaultPlatformCap,
            String(params.runDeadlineMs),
          ],
        );
        await client.query("commit");
        return res.rows[0] ? rowToJob(res.rows[0]) : null;
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    /** Advance to DONE with the envelope, atomically. Returns false if the job was not RUNNING. */
    async complete(
      id: string,
      envelope: JobEnvelope,
      extras: { stepsUsed?: number; costUsd?: number } = {},
    ): Promise<boolean> {
      const res = await pool.query(
        `update jobs set state = 'DONE', envelope = $2, finished_at = now(),
                         steps_used = $3, cost_usd = $4
         where id = $1 and state = 'RUNNING'`,
        [id, JSON.stringify(envelope), extras.stepsUsed ?? null, extras.costUsd ?? null],
      );
      return res.rowCount === 1;
    },

    /** Admin listing, newest first. */
    async list(opts: { state?: JobState; limit?: number } = {}): Promise<JobRow[]> {
      const limit = opts.limit ?? 50;
      const res = opts.state
        ? await pool.query(
            `select * from jobs where state = $1 order by created_at desc limit $2`,
            [opts.state, limit],
          )
        : await pool.query(`select * from jobs order by created_at desc limit $1`, [limit]);
      return res.rows.map(rowToJob);
    },

    /** Put a RUNNING job back in the queue (retry path). */
    async requeue(id: string): Promise<boolean> {
      const res = await pool.query(
        `update jobs set state = 'QUEUED', deadline_at = null where id = $1 and state = 'RUNNING'`,
        [id],
      );
      return res.rowCount === 1;
    },

    /**
     * Sweep RUNNING jobs past their deadline into DONE with a TIMEOUT error
     * envelope. Covers crashed workers and restarts; the normal path is the
     * runner's own wall-clock timeout.
     */
    async sweepExpired(): Promise<JobRow[]> {
      const res = await pool.query(
        `update jobs set state = 'DONE',
                         finished_at = now(),
                         envelope = jsonb_build_object(
                           'jobId', id::text,
                           'useCase', use_case,
                           'client', client,
                           'status', 'error',
                           'error', jsonb_build_object(
                             'code', 'TIMEOUT',
                             'message', 'The run exceeded its deadline and was reaped.'),
                           'meta', jsonb_build_object(
                             'ranAt', to_char(coalesce(started_at, created_at) at time zone 'utc',
                                              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                             'durationMs', (extract(epoch from (now() - coalesce(started_at, created_at))) * 1000)::int,
                             'attempts', attempts))
         where state = 'RUNNING' and deadline_at is not null and deadline_at < now()
         returning *`,
      );
      return res.rows.map(rowToJob);
    },

    async countByState(): Promise<Record<JobState, number>> {
      const res = await pool.query(`select state, count(*)::int as n from jobs group by state`);
      const out: Record<JobState, number> = { QUEUED: 0, RUNNING: 0, DONE: 0 };
      for (const row of res.rows) out[row.state as JobState] = row.n;
      return out;
    },
  };
}

export type JobStore = ReturnType<typeof createJobStore>;
