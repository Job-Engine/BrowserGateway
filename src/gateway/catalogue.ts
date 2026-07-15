import type { ReplayPlan } from "../replay.js";
import { z } from "zod";

/**
 * The agent catalogue. Each entry binds a useCase to a portal, the input it
 * needs, the goal the browser agent should pursue, and the schema of the data
 * to extract. Add a new portal by adding an entry here plus a matching login
 * item in 1Password (op://<vault>/<portalKey>/{username,password[,otp]}).
 */
export interface CatalogueEntry<I extends z.ZodTypeAny = z.ZodTypeAny> {
  useCase: string;
  /** Maps to the 1Password item name for this portal's login. */
  portalKey: string;
  /** Landing URL the agent starts from. */
  url: string;
  /** Validates the caller's input. */
  inputSchema: I;
  /** Structured data the agent should return. */
  extractSchema: z.ZodTypeAny;
  /**
   * Builds the natural-language goal. Reference values as %placeholders%:
   * credentials (%username%, %password%, %otp%) and input keys (%name%, ...)
   * are all available as Stagehand variables and are never sent to the LLM.
   * ctx.hasOtp reflects the resolved credential: mention %otp% only when the
   * login item actually carries a one-time password (M1).
   */
  buildGoal: (input: Record<string, unknown>, ctx: GoalContext) => string;
  /** Whether this portal requires a login step. */
  requiresLogin: boolean;
  /**
   * Deterministic replay configuration. Entries without one never replay
   * (every run takes the LLM learn path).
   */
  replay?: ReplayPlan;
  /**
   * Whitelabel clients allowed on this action. "default" is always allowed
   * even when absent here. Overrides are navigation-only by construction:
   * the type carries no schema fields, so the locked extract schema cannot
   * be overridden per client.
   */
  clients?: Record<string, ClientOverride>;
}

export interface GoalContext {
  /** True when the resolved credential includes a TOTP field. */
  hasOtp: boolean;
}

/** Per-client navigation adjustments. Never the output shape. */
export interface ClientOverride {
  /** 1Password item name; defaults to `<portalKey>.<client>` (`<portalKey>` for "default"). */
  credentialItem?: string;
  /** Landing URL for this client's skin, when it differs from the base. */
  startUrl?: string;
  /** Extra goal sentences appended after the base procedure. */
  goalHints?: string[];
  /** Base field label -> this skin's label; appended to the goal as guidance. */
  labelMap?: Record<string, string>;
  /** Per-run wall-clock override in ms. */
  timeoutMs?: number;
}

/** A catalogue entry merged with one client's overrides; what the runner consumes. */
export interface ResolvedAction {
  useCase: string;
  portalKey: string;
  client: string;
  url: string;
  inputSchema: z.ZodTypeAny;
  /** Always the base entry's schema; overrides cannot touch it. */
  extractSchema: z.ZodTypeAny;
  requiresLogin: boolean;
  credentialItem: string;
  timeoutMs?: number;
  replay?: ReplayPlan;
  buildGoal: (input: Record<string, unknown>, ctx: GoalContext) => string;
}

/**
 * Merge a base action with one client's navigation overrides. Unknown
 * clients are rejected; "default" needs no roster entry. The extract schema
 * is taken from the base entry unconditionally (locked decision).
 */
export function resolveAction(useCase: string, client: string): ResolvedAction {
  const entry = getEntry(useCase);
  const override = entry.clients?.[client];
  if (client !== "default" && !override) {
    const known = ["default", ...Object.keys(entry.clients ?? {})];
    throw new Error(
      `Unknown client "${client}" for ${useCase}. Known: ${[...new Set(known)].join(", ")}`,
    );
  }
  const credentialItem =
    override?.credentialItem ??
    (client === "default" ? entry.portalKey : `${entry.portalKey}.${client}`);
  return {
    useCase: entry.useCase,
    portalKey: entry.portalKey,
    client,
    url: override?.startUrl ?? entry.url,
    inputSchema: entry.inputSchema,
    extractSchema: entry.extractSchema,
    requiresLogin: entry.requiresLogin,
    credentialItem,
    timeoutMs: override?.timeoutMs,
    replay: entry.replay,
    buildGoal: (input, ctx) => {
      const parts = [entry.buildGoal(input, ctx)];
      const labels = Object.entries(override?.labelMap ?? {});
      if (labels.length > 0) {
        parts.push(
          `On this client's portal skin, field labels differ: ${labels
            .map(([base, skin]) => `"${base}" appears as "${skin}"`)
            .join("; ")}.`,
        );
      }
      if (override?.goalHints?.length) parts.push(...override.goalHints);
      return parts.join(" ");
    },
  };
}

const lightreachInput = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  projectId: z.string().optional(),
});

const lightreachExtract = z.object({
  matchVerified: z
    .boolean()
    .describe("True only if the record's customer name AND service address both match the input"),
  matchedName: z.string().nullable().describe("Customer name exactly as shown on the record"),
  matchedAddress: z.string().nullable().describe("Service address exactly as shown on the record"),
  ntpDateFound: z
    .boolean()
    .describe(
      "True when the Notice to Proceed milestone or an NTP Date field is visible on the record, even if it shows no date yet",
    ),
  ntpDate: z
    .string()
    .nullable()
    .describe(
      "The calendar date displayed for the Notice to Proceed milestone, exactly as shown. Null when no date is displayed (meaning the NTP is not complete yet). NEVER a status word like Submitted or Granted.",
    ),
});

export const CATALOGUE: Record<string, CatalogueEntry> = {
  "lightreach.ntpDate": {
    useCase: "lightreach.ntpDate",
    portalKey: "lightreach",
    url: "https://palmetto.finance/accounts",
    inputSchema: lightreachInput,
    extractSchema: lightreachExtract,
    requiresLogin: true,
    replay: {
      reads: {
        matchedName: "the customer name shown on the open record",
        matchedAddress: "the service address shown on the open record",
        ntpDate: 'the date next to the "Notice to Proceed" milestone in the Progress Tracker',
      },
      verify: { matchedName: "name", matchedAddress: "address" },
      assertTrue: ["matchVerified", "ntpDateFound"],
    },
    // Procedure folded from the retired hosted-agent spec (docs/lightreach-ntp-agent.md).
    buildGoal: (input, ctx) =>
      [
        "You are looking up ONE customer record in the LightReach / Palmetto financing portal and reading its NTP Date.",
        "This is read-only: do not modify, submit, save, delete, or change anything; never click buttons that alter data.",
        ctx.hasOtp
          ? "If not already logged in, log in using %username% and %password%, entering %otp% when a one-time code is requested."
          : "If not already logged in, log in using %username% and %password%.",
        input.projectId
          ? "Search for the customer by name %name%; the account/project ID %projectId% may help disambiguate."
          : "Search for the customer by name %name%.",
        "Open the matching record. Before trusting it, VERIFY the match: the record's customer name AND service address must both correspond to %name% and %address%.",
        "Minor formatting differences (case, abbreviations like St vs Street, unit spacing) are acceptable; a different person or a different street address is NOT a match.",
        "If no confident name and address match is found, stop; do not read fields from a record you could not verify.",
        'On a verified record, read the NTP (Notice to Proceed) date: it is the date shown next to the "Notice to Proceed" milestone at the top of the record\'s Progress Tracker. A banner may also say "Notice to Proceed Granted". It may also appear as a field labeled "NTP Date".',
        "If the milestone or field exists but shows no date, treat the value as null and note it; if neither can be found, report that explicitly.",
      ].join(" "),
    // Client roster. spartan is the first real client; its 1Password item
    // keeps its human title, referenced explicitly. lgcyco/brandx are
    // placeholders pending onboarding (items lightreach.<client>).
    clients: {
      spartan: {
        credentialItem: "Lightreach - Spartan",
        // First live runs measured ~15-20s per agent step; login + search +
        // verify + read needs more than the 300s default.
        timeoutMs: 600_000,
      },
      lgcyco: {},
      brandx: {
        labelMap: { "Progress Tracker": "Timeline" },
      },
    },
  },
};

export function getEntry(useCase: string): CatalogueEntry {
  const entry = CATALOGUE[useCase];
  if (!entry) {
    const known = Object.keys(CATALOGUE).join(", ") || "(none)";
    throw new Error(`Unknown useCase "${useCase}". Known: ${known}`);
  }
  return entry;
}
