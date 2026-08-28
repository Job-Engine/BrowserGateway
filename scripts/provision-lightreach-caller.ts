/**
 * One-off: mint a scoped bgw_ caller token for job-automation's LightReach
 * consumer (#467). Run AFTER the gateway + its Postgres are deployed, with
 * DATABASE_URL pointing at the gateway's database, e.g.:
 *
 *   railway run --service <gateway-service> tsx scripts/provision-lightreach-caller.ts
 *
 * The raw token is written to a 0600 file, NEVER printed to stdout — copy it
 * into job-automation's LIGHTREACH_GATEWAY_TOKEN, then delete the file. The
 * token is stored only as a sha256 hash and cannot be recovered later; re-run
 * to mint a fresh one (the prior caller row remains — delete it in the DB if
 * it is no longer used).
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPool } from "../src/gateway/db.js";
import { createAuthStore } from "../src/gateway/auth/tokens.js";

const CALLER_NAME = "spartanx-job-automation";
// Scope is "useCase:client" (auth/tokens.ts hasScope). Non-admin, single action.
const SCOPES = ["lightreach.accountSnapshot:spartan"];

async function main(): Promise<void> {
  const pool = createPool();
  try {
    const { caller, token } = await createAuthStore(pool).issueToken(CALLER_NAME, SCOPES, {
      isAdmin: false,
    });
    const out = process.env.OUT_FILE ?? join(homedir(), "lightreach-bgw-token.txt");
    writeFileSync(out, `${token}\n`, { mode: 0o600 });
    console.log(`✓ caller "${caller.name}" (${caller.id}) provisioned — scopes: ${caller.scopes.join(", ")}`);
    console.log(`✓ raw token written to ${out} (0600). Copy into LIGHTREACH_GATEWAY_TOKEN, then delete the file.`);
    console.log("  (stored only as a sha256 hash; not recoverable — re-run to mint a new one.)");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("provisioning failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
