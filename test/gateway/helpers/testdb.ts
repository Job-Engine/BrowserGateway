import { randomBytes } from "node:crypto";
import pg from "pg";
import { migrate } from "../../../src/gateway/db.js";

/**
 * One throwaway database per test file so files can run in parallel.
 * Needs the docker-compose Postgres (npm run db:up) or TEST_DATABASE_URL.
 */
const ADMIN_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://gateway:gateway@localhost:5433/browsergateway";

export interface TestDb {
  pool: pg.Pool;
  teardown: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const name = `test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 1 });
  try {
    await admin.query(`create database ${name}`);
  } catch (e) {
    await admin.end();
    throw new Error("Cannot create test database. Is Postgres up? (docker compose up -d)", {
      cause: e,
    });
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 5 });
  // The force-drop at teardown may kill a straggling idle client; that must
  // not surface as an unhandled error event.
  pool.on("error", () => {});
  admin.on("error", () => {});
  await migrate(pool);
  return {
    pool,
    teardown: async () => {
      await pool.end();
      await admin.query(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}
