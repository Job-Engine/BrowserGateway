import { z } from "zod";
import type { ActionHandler } from "../../gateway/catalogue.js";
import { PolitenessBudget } from "../politeness.js";
import { performDaylightLogin } from "./login.js";

/**
 * The Daylight code action: mint a portal session for one installer and hand
 * back the cookie.
 *
 * The calling app (job-automation) stores it in its own encrypted, per-tenant
 * `daylight_session` row and does all its reading itself over plain HTTP. This
 * gateway owns exactly one thing, the credential, which is the whole point:
 * `DAYLIGHT_USERNAME` / `DAYLIGHT_PASSWORD` stop living in that app's
 * environment, and the 1Password fetch happens here, just in time.
 *
 * ## Why the response includes an expiry the caller must not trust blindly
 *
 * Daylight states no expiry on the cookie, so `expiresAt` here is this
 * gateway's CONSERVATIVE ESTIMATE, labelled as such. Measured in the calling
 * app on 2026-09-07: a row recorded as expiring 09-04 still authenticated on
 * 09-07, so recorded expiries have historically been guesses. The real
 * protection is the caller's consecutive-failure breaker, not this field.
 */

export const daylightLoginInput = z.object({
  /** Which installer. Maps to a 1Password item via the catalogue's client roster. */
  tenant: z.enum(["wolfpack", "2ndcity"]),
});

export const daylightLoginExtract = z.object({
  /** The `daylight_sessionid` value. Secret: the caller encrypts it at rest. */
  sessionId: z.string().min(1),
  /** First 8 hex of sha256(sessionId). Safe to log; the cookie is not. */
  fingerprint: z.string().min(1),
  /** Always true, an unverified session is thrown rather than returned. */
  verified: z.boolean(),
  /** Conservative estimate, ISO. See the header: not authoritative. */
  expiresAt: z.string(),
  expiresAtIsEstimate: z.literal(true),
});

/**
 * Estimated session lifetime.
 *
 * Django's default is two weeks and Daylight has not been observed to shorten
 * it, but a session can also be invalidated server-side at any time. Seven days
 * is deliberately shorter than the default: erring short costs one extra login,
 * erring long costs a window where the caller believes a dead cookie is alive.
 */
const ESTIMATED_SESSION_DAYS = 7;

// Logins are expensive to the partner and this is the one write this whole
// integration makes. Steady state is one login per tenant per week; two per
// hour is headroom for a rotation, not a budget to spend.
const budgets = new Map<string, PolitenessBudget>();
function budgetFor(client: string): PolitenessBudget {
  let budget = budgets.get(client);
  if (!budget) {
    budget = new PolitenessBudget({ loginsPerHour: 2, readsPerHour: 10 });
    budgets.set(client, budget);
  }
  return budget;
}

export const daylightLoginHandler: ActionHandler = async ({ credentials, client }) => {
  // THERE IS NO DEFAULT DAYLIGHT LOGIN. `resolveAction` permits "default" for
  // every action, and for this one it would resolve the 1Password item to the
  // bare portalKey "daylight", which does not exist, surfacing as a confusing
  // credential-not-found rather than the real mistake. Daylight scopes every job
  // to the logged-in installer and 404s cross-installer reads, so a session is
  // only ever meaningful for a named tenant.
  if (client === "default") {
    throw new Error(
      'daylight.login has no "default" client: a Daylight session belongs to one installer. ' +
        "Call it with client=wolfpack or client=2ndcity.",
    );
  }

  const budget = budgetFor(client);
  if (!budget.tryLogin(client, Date.now())) {
    throw new Error(
      `daylight.login refused for client "${client}": the hourly login budget is spent. ` +
        "A session lasts about a week; repeated logins mean something upstream is looping.",
    );
  }

  const result = await performDaylightLogin({
    baseUrl: process.env.DAYLIGHT_BASE_URL ?? "https://daylightportal.com",
    username: credentials.username!,
    password: credentials.password!,
  });

  const expiresAt = new Date(Date.now() + ESTIMATED_SESSION_DAYS * 86_400_000);
  return {
    sessionId: result.sessionId,
    fingerprint: result.fingerprint,
    verified: result.verified,
    expiresAt: expiresAt.toISOString(),
    expiresAtIsEstimate: true as const,
  };
};
