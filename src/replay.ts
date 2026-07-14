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
