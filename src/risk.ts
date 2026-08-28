import type { RiskAssessment } from "./types.js";

export const DEFAULT_RISKY_KEYWORDS = [
  "submit",
  "send",
  "pay",
  "purchase",
  "checkout",
  "buy",
  "order",
  "delete",
  "remove",
  "post",
  "publish",
  "confirm",
  "apply",
  "sign",
  "agree",
  "accept",
  "transfer",
  "book",
  "reserve",
] as const;

export interface RiskConfig {
  keywords?: readonly string[];
}

type ActionLike = {
  description?: string;
  method?: string;
  instruction?: string;
};

export function classifyRisk(action: ActionLike, config: RiskConfig = {}): RiskAssessment {
  const keywords = config.keywords ?? DEFAULT_RISKY_KEYWORDS;
  const haystack = [action.description, action.method, action.instruction]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const hit = keywords.find((k) => haystack.includes(k.toLowerCase()));
  return hit
    ? { level: "risky", reason: `matched risky keyword "${hit}"` }
    : { level: "safe", reason: "no risky signal detected" };
}
