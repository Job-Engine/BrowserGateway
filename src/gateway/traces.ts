// Versioned replay traces per useCase and client. At most one active trace
// per pair; old versions are retired, never deleted. Secrets must never be
// stored: saveTrace rejects any payload containing a credential literal.
import type pg from "pg";
import type { TraceStep } from "../replay.js";

export type StoredStep = TraceStep;

export interface TraceRow {
  id: string;
  useCase: string;
  client: string;
  version: number;
  state: "active" | "retired";
  steps: StoredStep[];
  readSelectors: Record<string, string>;
  recordedFromJobId: string | null;
  healCount: number;
  lastSuccessAt: string | null;
  createdAt: string;
}

export interface SaveTraceOpts {
  useCase: string;
  client: string;
  steps: StoredStep[];
  readSelectors: Record<string, string>;
  recordedFromJobId?: string;
  /** false stores the trace retired (incomplete grounding); it never replays. */
  activate: boolean;
  /** true when this save heals a failed replay; increments heal_count. */
  healed?: boolean;
  /** Credential values that must not appear anywhere in the trace. */
  secretValues: string[];
}

function rowToTrace(r: Record<string, unknown>): TraceRow {
  return {
    id: r.id as string,
    useCase: r.use_case as string,
    client: r.client as string,
    version: r.version as number,
    state: r.state as TraceRow["state"],
    steps: r.steps as StoredStep[],
    readSelectors: r.read_selectors as Record<string, string>,
    recordedFromJobId: (r.recorded_from_job_id as string) ?? null,
    healCount: r.heal_count as number,
    lastSuccessAt: r.last_success_at ? new Date(r.last_success_at as string).toISOString() : null,
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

export function createTraceStore(pool: pg.Pool) {
  return {
    async saveTrace(opts: SaveTraceOpts): Promise<TraceRow> {
      const serialized = JSON.stringify({ steps: opts.steps, readSelectors: opts.readSelectors });
      for (const secret of opts.secretValues) {
        if (!secret) continue;
        // Fix D: also check the JSON-escaped form. A secret containing a
        // quote or backslash appears escaped in JSON.stringify output (e.g.
        // `pa"ss\word` becomes `pa\"ss\\word`), so a raw substring check alone
        // lets it slip through.
        const escaped = JSON.stringify(secret).slice(1, -1);
        if (serialized.includes(secret) || serialized.includes(escaped)) {
          throw new Error("trace rejected: payload contains a credential literal");
        }
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const prev = await client.query(
          `select version, heal_count, state from action_traces
           where use_case = $1 and client = $2
           order by version desc limit 1 for update`,
          [opts.useCase, opts.client],
        );
        const prevVersion = (prev.rows[0]?.version as number) ?? 0;
        const prevHeals = (prev.rows[0]?.heal_count as number) ?? 0;
        if (opts.activate) {
          await client.query(
            `update action_traces set state = 'retired'
             where use_case = $1 and client = $2 and state = 'active'`,
            [opts.useCase, opts.client],
          );
        }
        const inserted = await client.query(
          `insert into action_traces
             (use_case, client, version, state, steps, read_selectors, recorded_from_job_id, heal_count)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning *`,
          [
            opts.useCase,
            opts.client,
            prevVersion + 1,
            opts.activate ? "active" : "retired",
            JSON.stringify(opts.steps),
            JSON.stringify(opts.readSelectors),
            opts.recordedFromJobId ?? null,
            opts.healed ? prevHeals + 1 : prevHeals,
          ],
        );
        await client.query("commit");
        return rowToTrace(inserted.rows[0]);
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },

    async getActive(useCase: string, client: string): Promise<TraceRow | null> {
      const res = await pool.query(
        `select * from action_traces
         where use_case = $1 and client = $2 and state = 'active'`,
        [useCase, client],
      );
      return res.rows[0] ? rowToTrace(res.rows[0]) : null;
    },

    async recordSuccess(id: string): Promise<void> {
      await pool.query(`update action_traces set last_success_at = now() where id = $1`, [id]);
    },

    /** Retire the active trace, forcing a learn run on the next job. */
    async invalidate(useCase: string, client: string): Promise<boolean> {
      const res = await pool.query(
        `update action_traces set state = 'retired'
         where use_case = $1 and client = $2 and state = 'active'`,
        [useCase, client],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async list(useCase?: string): Promise<TraceRow[]> {
      const res = useCase
        ? await pool.query(
            `select * from action_traces where use_case = $1 order by client, version desc`,
            [useCase],
          )
        : await pool.query(`select * from action_traces order by use_case, client, version desc`);
      return res.rows.map(rowToTrace);
    },
  };
}

export type TraceStore = ReturnType<typeof createTraceStore>;
