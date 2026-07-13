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
   */
  buildGoal: (input: Record<string, unknown>) => string;
  /** Whether this portal requires a login step. */
  requiresLogin: boolean;
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
    buildGoal: (input) =>
      [
        "If not already logged in, log in using %username% and %password%",
        input.projectId ? " (and %otp% if a one-time code is requested)." : ".",
        " Then search for the customer by name and open the matching account.",
        " Before reading anything, VERIFY the match: the record's customer name AND service address must both correspond to %name% and %address%.",
        " On a verified record, read the NTP Date field exactly as shown.",
        " Do not modify, submit, or change anything; this is read-only.",
      ].join(""),
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
