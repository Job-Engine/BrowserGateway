import { z } from "zod";
import type { ActionHandler } from "../../gateway/catalogue.js";
import { PolitenessBudget } from "../politeness.js";
import { runLightreachBatch } from "./batch.js";
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

export const lightreachSnapshotHandler: ActionHandler = async ({ input, credentials, client }) => {
  const accountIds = (input as { accountIds: string[] }).accountIds;
  const { results } = await runLightreachBatch(accountIds, {
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
  });
  return { results };
};
