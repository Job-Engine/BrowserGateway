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
}

export interface GoalContext {
  /** True when the resolved credential includes a TOTP field. */
  hasOtp: boolean;
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
