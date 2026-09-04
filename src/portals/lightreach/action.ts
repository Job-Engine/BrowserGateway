import { z } from "zod";
import type { ActionHandler } from "../../gateway/catalogue.js";
import { PolitenessBudget } from "../politeness.js";
import { runLightreachBatch, type WarmSession } from "./batch.js";
import { httpGetWithCookie, loginLightreach } from "./login.js";
import { lightreachSnapshotSchema } from "./snapshot.js";

/**
 * The LightReach code-action (issue #467): given a batch of palmetto account
 * ids, log in once and read each account's NTP / stipulations / credit-expiry
 * over the 24h cookie jar. Per-record status so one bad account never fails the
 * batch. Extreme politeness to Palmetto via a process-scoped PolitenessBudget.
 */

export const lightreachSnapshotInput = z.object({
  // A batch: one login serves them all. A single-account (creation-path) call
  // is just a batch of one.
  accountIds: z.array(z.string().min(1)).min(1).max(500),
});

export const lightreachSnapshotExtract = z.object({
  results: z.array(
    z.object({
      accountId: z.string(),
      status: z.enum(["success", "error", "rate_limited"]),
      snapshot: lightreachSnapshotSchema.optional(),
      error: z.string().optional(),
    }),
  ),
});

// Per-client politeness budget, PROCESS-scoped (not per-job): the hourly ceiling
// must persist across the serialized jobs of a client. Steady state is ~1
// login/day; the cap allows a re-auth headroom over the stated "1 login/hour".
const budgets = new Map<string, PolitenessBudget>();
function budgetFor(client: string): PolitenessBudget {
  let b = budgets.get(client);
  if (!b) {
    b = new PolitenessBudget({ loginsPerHour: 2, readsPerHour: 200 });
    budgets.set(client, b);
  }
  return b;
}

// Per-client WARM SESSION, PROCESS-scoped for the same reason as the budget:
// `runLightreachBatch` already accepts a session and returns "(possibly
// refreshed) session, for reuse across runs" with a 23h TTL, but the handler
// used to pass none and drop the one it got — so every job logged in fresh and
// the 2/hour login budget was consumed by create-polls, starving the 2h sweep
// (measured 2026-09-04: 7/7 accounts "login budget exhausted").
//
// Keyed by client so one tenant's jar is never served to another. Staleness is
// NOT this map's problem: the batch TTL-checks the session and re-logs in on a
// 401 (LightreachAuthExpiredError), so a dead jar self-heals on the next read.
const sessions = new Map<string, WarmSession>();

export const lightreachSnapshotHandler: ActionHandler = async ({ input, credentials, client }) => {
  const accountIds = (input as { accountIds: string[] }).accountIds;
  const { session, results } = await runLightreachBatch(
    accountIds,
    {
      client,
      login: () =>
        loginLightreach({
          username: credentials.username,
          password: credentials.password,
          otp: credentials.otp,
          // Seat the session on the first account we're about to read.
          seatAccountId: accountIds[0],
        }),
      httpGet: httpGetWithCookie,
      budget: budgetFor(client),
      now: () => Date.now(),
    },
    sessions.get(client) ?? null,
  );
  // Only overwrite on a real session. A null means login failed or the budget
  // refused one THIS run — discarding a still-valid warm jar for that would
  // turn a transient hiccup into a guaranteed re-login next run.
  if (session) sessions.set(client, session);
  return { results };
};
