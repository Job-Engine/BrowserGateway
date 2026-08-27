import { z } from "zod";

/**
 * LightReach (Palmetto) account snapshot — the pure data layer of the
 * code-action (issue #467, docs/lightreach-extension/). No browser, no LLM:
 * given the three JSON bodies the portal's own API returns (validated in
 * phase-0 recon 2026-08-27), produce one normalized snapshot.
 *
 * Field provenance (all keyed by palmetto account id):
 *   ntp*             ← GET api/v2/accounts/{id}          → milestones[] "Notice to Proceed"
 *   stipulations     ← GET api/accounts/{id}/stipulations
 *   creditExpiryDate ← GET api/accounts/{id}/applications → [].creditExpiryDate
 *
 * The consumer (job-automation) maps openStipulations → the Asana "Stips"/"N-A"
 * flag; that policy deliberately lives on the consumer, not here.
 */

export const lightreachSnapshotSchema = z.object({
  matchedAccountId: z.string(),
  ntpApproved: z.boolean(),
  ntpApprovedAt: z.string().nullable(),
  currentMilestone: z.string().nullable(),
  stipulations: z.array(
    z.object({
      type: z.string(),
      satisfied: z.boolean(),
      requiresReview: z.boolean(),
    }),
  ),
  openStipulations: z.array(z.string()),
  creditExpiryDate: z.string().nullable(),
});

export type LightreachSnapshot = z.infer<typeof lightreachSnapshotSchema>;

export interface LightreachRawBodies {
  accountId: string;
  /** GET api/v2/accounts/{id} */
  account: unknown;
  /** GET api/accounts/{id}/stipulations */
  stipulations: unknown;
  /** GET api/accounts/{id}/applications */
  applications: unknown;
}

interface Milestone {
  name?: unknown;
  status?: unknown;
  completed?: unknown;
  completedAt?: unknown;
}
interface Stipulation {
  stipulationType?: unknown;
  isSatisfied?: unknown;
  requiresReview?: unknown;
}
interface Application {
  creditExpiryDate?: unknown;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

export function parseLightreachSnapshot(raw: LightreachRawBodies): LightreachSnapshot {
  const account = (raw.account ?? {}) as { milestones?: Milestone[]; currentMilestone?: { name?: unknown } };
  const milestones = Array.isArray(account.milestones) ? account.milestones : [];

  const ntp = milestones.find((m) => m?.name === "Notice to Proceed");
  const ntpApproved = ntp?.status === "approved" && ntp?.completed === true;
  // Approved-but-blank is possible (completedAt ""): the flag can be true while
  // the date is still null — never surface "" as a date.
  const ntpApprovedAt = ntpApproved ? str(ntp?.completedAt) : null;
  const currentMilestone = str(account.currentMilestone?.name);

  const rawStips = Array.isArray(raw.stipulations) ? (raw.stipulations as Stipulation[]) : [];
  const stipulations = rawStips.map((s) => ({
    type: String(s?.stipulationType ?? ""),
    satisfied: s?.isSatisfied === true,
    requiresReview: s?.requiresReview === true,
  }));
  const openStipulations = stipulations.filter((s) => !s.satisfied).map((s) => s.type);

  const apps = Array.isArray(raw.applications) ? (raw.applications as Application[]) : [];
  const creditExpiryDate = apps.map((a) => str(a?.creditExpiryDate)).find((d) => d !== null) ?? null;

  return lightreachSnapshotSchema.parse({
    matchedAccountId: raw.accountId,
    ntpApproved,
    ntpApprovedAt,
    currentMilestone,
    stipulations,
    openStipulations,
    creditExpiryDate,
  });
}
