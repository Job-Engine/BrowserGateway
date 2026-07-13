// DB-backed catalogue registry: action lifecycle, per-client enablement with
// the first-live-run rule enforced in code, canary state, and the audit log.
// Base definitions (zod schemas, goal builders) live in catalogue.ts; this
// module owns whether a pair may serve caller traffic.
import type pg from "pg";
import { CATALOGUE, getEntry, resolveAction } from "./catalogue.js";

export interface CataloguePairRow {
  useCase: string;
  platform: string;
  actionState: "draft" | "validated";
  client: string;
  clientState: "disabled" | "tested" | "live";
  testJobId: string | null;
  lastCanaryAt: string | null;
  lastCanaryStatus: string | null;
}

const CREDENTIAL_PLACEHOLDERS = new Set(["username", "password", "otp"]);

export function createRegistry(pool: pg.Pool) {
  async function audit(
    actor: string,
    action: string,
    entity: string,
    detail?: unknown,
  ): Promise<void> {
    await pool.query(
      `insert into audit_log (actor, action, entity, detail) values ($1, $2, $3, $4)`,
      [actor, action, entity, detail === undefined ? null : JSON.stringify(detail)],
    );
  }

  return {
    audit,

    /** Upsert the code catalogue into the registry. New rows start as draft/disabled. */
    async seed(): Promise<void> {
      for (const entry of Object.values(CATALOGUE)) {
        await pool.query(
          `insert into platforms (key, display_name) values ($1, initcap($1))
           on conflict (key) do nothing`,
          [entry.portalKey],
        );
        await pool.query(
          `insert into actions (use_case, platform) values ($1, $2)
           on conflict (use_case) do nothing`,
          [entry.useCase, entry.portalKey],
        );
        for (const client of ["default", ...Object.keys(entry.clients ?? {})]) {
          await pool.query(
            `insert into action_clients (use_case, client) values ($1, $2)
             on conflict do nothing`,
            [entry.useCase, client],
          );
        }
      }
    },

    /**
     * Lint gate, draft -> validated: every %placeholder% the goal can emit
     * must exist in the input schema or be a credential variable, and the
     * locked extract schema must be present.
     */
    async validateAction(
      useCase: string,
      actor: string,
    ): Promise<{ ok: boolean; problems: string[] }> {
      const entry = getEntry(useCase);
      const problems: string[] = [];
      const shape = (entry.inputSchema as { shape?: Record<string, unknown> }).shape ?? {};
      const inputKeys = new Set(Object.keys(shape));
      const sampleInput: Record<string, string> = {};
      for (const key of inputKeys) sampleInput[key] = `sample-${key}`;
      for (const client of ["default", ...Object.keys(entry.clients ?? {})]) {
        const action = resolveAction(useCase, client);
        for (const hasOtp of [true, false]) {
          const goal = action.buildGoal(sampleInput, { hasOtp });
          for (const match of goal.matchAll(/%([a-zA-Z0-9_]+)%/g)) {
            const name = match[1];
            if (!inputKeys.has(name) && !CREDENTIAL_PLACEHOLDERS.has(name)) {
              problems.push(`goal for client "${client}" references unknown placeholder %${name}%`);
            }
          }
        }
      }
      if (!entry.extractSchema) problems.push("extract schema missing");
      if (problems.length === 0) {
        await pool.query(`update actions set state = 'validated' where use_case = $1`, [useCase]);
        await audit(actor, "action.validated", useCase);
        return { ok: true, problems: [] };
      }
      await audit(actor, "action.validation_failed", useCase, { problems });
      return { ok: false, problems };
    },

    /**
     * Record a passing, match-verified test run for a pair (first-live-run
     * rule). The job must be DONE, success, and matchVerified where the
     * extract carries that flag. Promotes the pair to tested and stores the
     * input as the pair's canary configuration.
     */
    async recordTestRun(
      useCase: string,
      client: string,
      jobId: string,
      actor: string,
    ): Promise<{ ok: boolean; reason?: string }> {
      const actionRow = await pool.query(`select state from actions where use_case = $1`, [
        useCase,
      ]);
      if (actionRow.rows[0]?.state !== "validated") {
        return { ok: false, reason: "action must be validated before test runs count" };
      }
      const jobRow = await pool.query(
        `select state, envelope, input, use_case, client from jobs where id = $1`,
        [jobId],
      );
      const job = jobRow.rows[0];
      if (!job || job.state !== "DONE") return { ok: false, reason: "job not found or not DONE" };
      if (job.use_case !== useCase || job.client !== client) {
        return { ok: false, reason: "job does not belong to this action-client pair" };
      }
      const envelope = job.envelope as {
        status?: string;
        data?: { matchVerified?: unknown } | null;
      } | null;
      if (envelope?.status !== "success")
        return { ok: false, reason: "job envelope is not success" };
      if (envelope.data && envelope.data.matchVerified === false) {
        return { ok: false, reason: "test run did not verify the record match" };
      }
      await pool.query(
        `update action_clients set state = 'tested', test_input = $3, test_job_id = $4
         where use_case = $1 and client = $2`,
        [useCase, client, JSON.stringify(job.input), jobId],
      );
      await audit(actor, "pair.tested", `${useCase}:${client}`, { jobId });
      return { ok: true };
    },

    /** tested -> live. Without a recorded passing test this refuses (in code, not convention). */
    async setLive(
      useCase: string,
      client: string,
      actor: string,
    ): Promise<{ ok: boolean; reason?: string }> {
      const res = await pool.query(
        `update action_clients set state = 'live'
         where use_case = $1 and client = $2 and state = 'tested' and test_job_id is not null`,
        [useCase, client],
      );
      if (res.rowCount !== 1) {
        return { ok: false, reason: "pair has no recorded passing test run (first-live-run rule)" };
      }
      await audit(actor, "pair.live", `${useCase}:${client}`);
      return { ok: true };
    },

    async disablePair(useCase: string, client: string, actor: string): Promise<void> {
      await pool.query(
        `update action_clients set state = 'disabled' where use_case = $1 and client = $2`,
        [useCase, client],
      );
      await audit(actor, "pair.disabled", `${useCase}:${client}`);
    },

    /** The gate POST /jobs consults: only live pairs serve caller traffic. */
    async isLive(useCase: string, client: string): Promise<boolean> {
      const res = await pool.query(
        `select 1 from action_clients where use_case = $1 and client = $2 and state = 'live'`,
        [useCase, client],
      );
      return res.rowCount === 1;
    },

    async listCatalogue(): Promise<CataloguePairRow[]> {
      const res = await pool.query(
        `select a.use_case, a.platform, a.state as action_state,
                c.client, c.state as client_state, c.test_job_id,
                c.last_canary_at, c.last_canary_status
         from actions a join action_clients c on c.use_case = a.use_case
         order by a.use_case, c.client`,
      );
      return res.rows.map((r) => ({
        useCase: r.use_case,
        platform: r.platform,
        actionState: r.action_state,
        client: r.client,
        clientState: r.client_state,
        testJobId: r.test_job_id,
        lastCanaryAt: r.last_canary_at ? r.last_canary_at.toISOString() : null,
        lastCanaryStatus: r.last_canary_status,
      }));
    },

    /** Live pairs with canary config (the recorded test input). */
    async listCanaryTargets(): Promise<Array<{ useCase: string; client: string; input: unknown }>> {
      const res = await pool.query(
        `select use_case, client, test_input from action_clients
         where state = 'live' and test_input is not null`,
      );
      return res.rows.map((r) => ({ useCase: r.use_case, client: r.client, input: r.test_input }));
    },

    async recordCanaryResult(
      useCase: string,
      client: string,
      jobId: string,
      status: string,
    ): Promise<void> {
      await pool.query(
        `update action_clients
         set last_canary_at = now(), last_canary_status = $3, last_canary_job_id = $4
         where use_case = $1 and client = $2`,
        [useCase, client, status, jobId],
      );
    },

    async listAudit(
      limit = 100,
    ): Promise<
      Array<{
        id: string;
        actor: string;
        action: string;
        entity: string;
        detail: unknown;
        createdAt: string;
      }>
    > {
      const res = await pool.query(
        `select id, actor, action, entity, detail, created_at from audit_log
         order by created_at desc limit $1`,
        [limit],
      );
      return res.rows.map((r) => ({
        id: r.id,
        actor: r.actor,
        action: r.action,
        entity: r.entity,
        detail: r.detail,
        createdAt: r.created_at.toISOString(),
      }));
    },
  };
}

export type Registry = ReturnType<typeof createRegistry>;
