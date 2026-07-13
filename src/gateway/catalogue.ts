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
  matchVerified: z.boolean(),
  matchedName: z.string().nullable(),
  matchedAddress: z.string().nullable(),
  ntpDateFound: z.boolean(),
  ntpDate: z.string().nullable(),
});

export const CATALOGUE: Record<string, CatalogueEntry> = {
  "lightreach.ntpDate": {
    useCase: "lightreach.ntpDate",
    portalKey: "lightreach",
    url: "https://palmetto.finance/accounts",
    inputSchema: lightreachInput,
    extractSchema: lightreachExtract,
    requiresLogin: true,
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
        'On a verified record, locate the "NTP Date" field and read its value exactly as shown.',
        "If the field exists but is blank, treat the value as null and note it; if the field cannot be found, report that explicitly.",
      ].join(" "),
    // Client roster. Overrides are placeholders pending the first live run
    // per client; the credential items must exist in 1Password as
    // lightreach.<client> before a client can serve traffic.
    clients: {
      lgcyco: {},
      brandx: {
        labelMap: { "NTP Date": "Notice to Proceed" },
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
