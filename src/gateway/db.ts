// Postgres pool + migration runner. Single responsibility: give the gateway a
// connected pool with the schema applied. Sits below jobs/, auth/, queue/.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

export type Pool = pg.Pool;

export function createPool(databaseUrl = process.env.DATABASE_URL): pg.Pool {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  // An idle client dropped by the server must not crash the process.
  pool.on("error", () => {});
  return pool;
}

/**
 * Apply migrations/*.sql in lexicographic order, once each, inside a
 * transaction. Tracked in schema_migrations by filename.
 */
export async function migrate(
  pool: pg.Pool,
  dir = path.resolve(process.cwd(), "migrations"),
): Promise<string[]> {
  await pool.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const seen = await client.query(
        "select 1 from schema_migrations where name = $1 for update",
        [file],
      );
      if (seen.rowCount === 0) {
        const sql = await readFile(path.join(dir, file), "utf8");
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        applied.push(file);
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  return applied;
}
