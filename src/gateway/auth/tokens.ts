// Per-caller API keys (S1, S2). Tokens are random, shown once at issue time,
// stored only as sha256 hashes, verified by hash lookup, and carry
// useCase-by-client scopes. No token configured means no access: fail closed.
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

export interface Caller {
  id: string;
  name: string;
  scopes: string[];
  isAdmin: boolean;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Scope strings are "useCase:client" with "*" wildcards on either side.
 * "lightreach.ntpDate:*" grants every client of that action; "*:*" grants all.
 */
export function hasScope(scopes: string[], useCase: string, client: string): boolean {
  return scopes.some((scope) => {
    const [scopeUseCase, scopeClient] = scope.split(":");
    if (scopeUseCase === undefined || scopeClient === undefined) return false;
    const useCaseOk = scopeUseCase === "*" || scopeUseCase === useCase;
    const clientOk = scopeClient === "*" || scopeClient === client;
    return useCaseOk && clientOk;
  });
}

export function createAuthStore(pool: pg.Pool) {
  return {
    /** Create a caller and return the plaintext token exactly once. */
    async issueToken(
      name: string,
      scopes: string[],
      opts: { isAdmin?: boolean } = {},
    ): Promise<{ caller: Caller; token: string }> {
      const token = `bgw_${randomBytes(24).toString("base64url")}`;
      const res = await pool.query(
        `insert into callers (name, token_hash, scopes, is_admin)
         values ($1, $2, $3, $4) returning id, name, scopes, is_admin`,
        [name, hashToken(token), JSON.stringify(scopes), opts.isAdmin ?? false],
      );
      const row = res.rows[0];
      return {
        caller: { id: row.id, name: row.name, scopes: row.scopes, isAdmin: row.is_admin },
        token,
      };
    },

    /**
     * Resolve a presented bearer token to a caller. Lookup is by sha256 hash,
     * so the plaintext is never compared or stored; unknown or disabled
     * tokens resolve to null (fail closed).
     */
    async verifyToken(token: string | undefined): Promise<Caller | null> {
      if (!token || !token.startsWith("bgw_")) return null;
      const res = await pool.query(
        `select id, name, scopes, is_admin from callers
         where token_hash = $1 and disabled = false`,
        [hashToken(token)],
      );
      const row = res.rows[0];
      if (!row) return null;
      return { id: row.id, name: row.name, scopes: row.scopes, isAdmin: row.is_admin };
    },

    async disable(callerId: string): Promise<void> {
      await pool.query(`update callers set disabled = true where id = $1`, [callerId]);
    },
  };
}

export type AuthStore = ReturnType<typeof createAuthStore>;
