// Deterministic replay: trace types, input parameterization, identity
// matching, the replay executor, and the learn wrapper that records traces.
// Sanctioned core change 5 (see docs/superpowers/specs/2026-07-14-deterministic-replay-design.md).
import type { ActionRecord, ObservedAction } from "./types.js";

export interface TraceStep {
  selector: string;
  method: string;
  arguments: string[];
  description: string;
  /** Set when the step embeds an input value; tokens are %inputKey%. */
  paramTemplate: { selector: string; arguments: string[] } | null;
}

export interface ReplayTrace {
  steps: TraceStep[];
  /** Extract field name to selector, grounded at record time. */
  readSelectors: Record<string, string>;
}

const MIN_PARAM_LENGTH = 3;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-token, case-insensitive occurrence of value inside text. The percent
 * sign is excluded from both boundaries so the interior of an existing
 * %placeholder% token can never match.
 */
function tokenPattern(value: string): RegExp {
  return new RegExp(`(^|[^a-zA-Z0-9%])(${escapeRegExp(value)})(?=[^a-zA-Z0-9%]|$)`, "gi");
}

function substitute(text: string, key: string, value: string): { out: string; hit: boolean } {
  let hit = false;
  const out = text.replace(tokenPattern(value), (_m, pre: string) => {
    hit = true;
    return `${pre}%${key}%`;
  });
  return { out, hit };
}

/**
 * Build replayable steps from a successful run's actionsLog. Any step text
 * that embeds an input VALUE gets a template with the value swapped for its
 * %inputKey% token. Credentials never appear literally (they are always
 * placeholder tokens already), so only input fields are considered.
 */
export function parameterizeSteps(
  records: ActionRecord[],
  input: Record<string, string>,
): TraceStep[] {
  return records
    .filter((r) => r.outcome === "executed")
    .map((r) => {
      const args = r.action.arguments ?? [];
      let selector = r.action.selector;
      let outArgs = [...args];
      let touched = false;
      for (const [key, value] of Object.entries(input)) {
        if (!value || value.length < MIN_PARAM_LENGTH) continue;
        const sel = substitute(selector, key, value);
        if (sel.hit) {
          selector = sel.out;
          touched = true;
        }
        outArgs = outArgs.map((a) => {
          const sub = substitute(a, key, value);
          if (sub.hit) touched = true;
          return sub.out;
        });
      }
      return {
        selector: r.action.selector,
        method: r.action.method ?? "",
        arguments: args,
        description: r.action.description,
        paramTemplate: touched ? { selector, arguments: outArgs } : null,
      };
    });
}

/** Resolve a step against the current job's input for execution. */
export function resolveStep(step: TraceStep, input: Record<string, string>): ObservedAction {
  const fill = (text: string): string =>
    Object.entries(input).reduce((acc, [key, value]) => acc.split(`%${key}%`).join(value), text);
  const source = step.paramTemplate ?? { selector: step.selector, arguments: step.arguments };
  return {
    selector: step.paramTemplate ? fill(source.selector) : source.selector,
    method: step.method,
    // Credential tokens (%username%...) stay: Stagehand resolves them via variables.
    arguments: step.paramTemplate ? source.arguments.map(fill) : source.arguments,
    description: step.description,
  };
}

/** Common US address and name abbreviations, both directions normalized. */
const ABBREVIATIONS: Record<string, string> = {
  st: "street",
  ave: "avenue",
  blvd: "boulevard",
  dr: "drive",
  rd: "road",
  ln: "lane",
  ct: "court",
  cir: "circle",
  hwy: "highway",
  pkwy: "parkway",
  apt: "apartment",
  ste: "suite",
  fl: "floor",
  n: "north",
  s: "south",
  e: "east",
  w: "west",
  ne: "northeast",
  nw: "northwest",
  se: "southeast",
  sw: "southwest",
};

export function normalizeIdentity(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,#()]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => ABBREVIATIONS[t] ?? t)
    .join(" ");
}

/**
 * Conservative identity match. After normalization:
 * - empty shown or expected text never matches;
 * - every expected word token must be present in shown with at least the
 *   same multiplicity;
 * - the expected numeric tokens must appear in shown in the same order
 *   (subsequence), so transposed house/unit/zip numbers reject.
 * False rejects cost an extra LLM run; false accepts return the wrong
 * customer's data. When in doubt, reject.
 */
export function fuzzyMatch(shown: string, expected: string): boolean {
  const shownNorm = normalizeIdentity(shown);
  const expectedNorm = normalizeIdentity(expected);
  if (shownNorm === "" || expectedNorm === "") return false;

  const shownTokens = shownNorm.split(" ");
  const expectedTokens = expectedNorm.split(" ");

  const isNumeric = (t: string): boolean => /^\d+$/.test(t);

  const shownWordCounts = new Map<string, number>();
  for (const t of shownTokens) {
    if (!isNumeric(t)) shownWordCounts.set(t, (shownWordCounts.get(t) ?? 0) + 1);
  }
  for (const t of expectedTokens) {
    if (isNumeric(t)) continue;
    const left = shownWordCounts.get(t) ?? 0;
    if (left === 0) return false;
    shownWordCounts.set(t, left - 1);
  }

  const shownNumbers = shownTokens.filter(isNumeric);
  const expectedNumbers = expectedTokens.filter(isNumeric);
  let cursor = 0;
  for (const n of expectedNumbers) {
    let found = -1;
    for (let i = cursor; i < shownNumbers.length; i++) {
      if (shownNumbers[i] === n) {
        found = i;
        break;
      }
    }
    if (found === -1) return false;
    cursor = found + 1;
  }
  return true;
}
