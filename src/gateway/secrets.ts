import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Just-in-time credential resolution via the 1Password CLI.
 *
 * The container authenticates to 1Password with a service account token
 * (OP_SERVICE_ACCOUNT_TOKEN) scoped to a single vault of portal logins. Nothing
 * else in the process holds a portal password; we read it per run, hand it to
 * the browser run as a Stagehand variable, and let it fall out of memory.
 *
 * Convention: one 1Password login item per portal, named by portalKey, with
 * fields username, password, and optionally "one-time password" (TOTP).
 *   op://<OP_PORTALS_VAULT>/<portalKey>/username
 *   op://<OP_PORTALS_VAULT>/<portalKey>/password
 *   op://<OP_PORTALS_VAULT>/<portalKey>/one-time password?attribute=otp
 *
 * Docs: https://www.1password.dev/cli  (secret references, service accounts)
 */

export interface PortalCredentials {
  username: string;
  password: string;
  /** Current TOTP, if the portal uses 2FA and the item has an OTP field. */
  otp?: string;
}

interface CacheEntry {
  value: PortalCredentials;
  expires: number;
}

// Small per-process cache to respect 1Password service-account rate limits.
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

function vault(): string {
  return process.env.OP_PORTALS_VAULT ?? "Portals";
}

async function opRead(reference: string): Promise<string> {
  // OP_SERVICE_ACCOUNT_TOKEN is read from the environment by `op` automatically.
  const { stdout } = await execFileAsync("op", ["read", reference], {
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

/** Local dev fallback: PORTAL_<KEY>_USERNAME / _PASSWORD / _OTP env vars. */
function envFallback(portalKey: string): PortalCredentials | null {
  const upper = portalKey.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const username = process.env[`PORTAL_${upper}_USERNAME`];
  const password = process.env[`PORTAL_${upper}_PASSWORD`];
  if (username && password) {
    return { username, password, otp: process.env[`PORTAL_${upper}_OTP`] };
  }
  return null;
}

export async function resolvePortalCredentials(
  portalKey: string,
  opts: { withOtp?: boolean } = {},
): Promise<PortalCredentials> {
  const cached = cache.get(portalKey);
  if (cached && cached.expires > Date.now()) return cached.value;

  // Prefer 1Password; fall back to env vars only when op is not configured.
  let creds: PortalCredentials;
  const hasOp = Boolean(process.env.OP_SERVICE_ACCOUNT_TOKEN);
  if (hasOp) {
    const base = `op://${vault()}/${portalKey}`;
    const [username, password] = await Promise.all([
      opRead(`${base}/username`),
      opRead(`${base}/password`),
    ]);
    creds = { username, password };
    if (opts.withOtp) {
      try {
        creds.otp = await opRead(`${base}/one-time password?attribute=otp`);
      } catch {
        // No OTP field on this item; that's fine.
      }
    }
  } else {
    const fb = envFallback(portalKey);
    if (!fb) {
      throw new Error(
        `No credentials for portal "${portalKey}". Set OP_SERVICE_ACCOUNT_TOKEN (+ 1Password item) ` +
          `or PORTAL_${portalKey.toUpperCase()}_USERNAME / _PASSWORD for local testing.`,
      );
    }
    creds = fb;
  }

  cache.set(portalKey, { value: creds, expires: Date.now() + CACHE_TTL_MS });
  return creds;
}

/** Wipe the credential cache (e.g. after a portal password rotation). */
export function clearCredentialCache(): void {
  cache.clear();
}
