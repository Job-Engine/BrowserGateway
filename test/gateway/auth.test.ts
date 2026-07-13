import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/testdb.js";
import {
  createAuthStore,
  hasScope,
  hashToken,
  type AuthStore,
} from "../../src/gateway/auth/tokens.js";

let db: TestDb;
let auth: AuthStore;

beforeAll(async () => {
  db = await createTestDb();
  auth = createAuthStore(db.pool);
});

afterAll(async () => {
  await db.teardown();
});

describe("hasScope", () => {
  it("matches exact, wildcard, and rejects mismatches", () => {
    expect(hasScope(["lightreach.ntpDate:lgcyco"], "lightreach.ntpDate", "lgcyco")).toBe(true);
    expect(hasScope(["lightreach.ntpDate:*"], "lightreach.ntpDate", "brandx")).toBe(true);
    expect(hasScope(["*:*"], "anything.else", "any")).toBe(true);
    expect(hasScope(["lightreach.ntpDate:lgcyco"], "lightreach.ntpDate", "brandx")).toBe(false);
    expect(hasScope(["lightreach.ntpDate:lgcyco"], "other.action", "lgcyco")).toBe(false);
    expect(hasScope([], "lightreach.ntpDate", "lgcyco")).toBe(false);
    expect(hasScope(["malformed"], "lightreach.ntpDate", "lgcyco")).toBe(false);
  });
});

describe("token issue and verify (S2)", () => {
  it("issues a bgw_ token whose plaintext is never stored", async () => {
    const { caller, token } = await auth.issueToken("app-one", ["lightreach.ntpDate:*"]);
    expect(token).toMatch(/^bgw_/);
    const stored = await db.pool.query(`select token_hash from callers where id = $1`, [caller.id]);
    expect(stored.rows[0].token_hash).toBe(hashToken(token));
    expect(stored.rows[0].token_hash).not.toContain(token.slice(4));
  });

  it("verifies a valid token to its caller with scopes", async () => {
    const { token } = await auth.issueToken("app-two", ["lightreach.ntpDate:lgcyco"]);
    const caller = await auth.verifyToken(token);
    expect(caller?.name).toBe("app-two");
    expect(caller?.scopes).toEqual(["lightreach.ntpDate:lgcyco"]);
    expect(caller?.isAdmin).toBe(false);
  });

  it("fails closed: missing, malformed, unknown, and disabled tokens all resolve to null", async () => {
    expect(await auth.verifyToken(undefined)).toBeNull();
    expect(await auth.verifyToken("")).toBeNull();
    expect(await auth.verifyToken("not-a-gateway-token")).toBeNull();
    expect(await auth.verifyToken("bgw_definitely_not_issued")).toBeNull();
    const { caller, token } = await auth.issueToken("app-three", ["*:*"]);
    await auth.disable(caller.id);
    expect(await auth.verifyToken(token)).toBeNull();
  });
});
