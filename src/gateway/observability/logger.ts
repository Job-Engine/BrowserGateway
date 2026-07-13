// pino logger with redaction. Single responsibility: every structured log line
// in the gateway flows through here; secrets and customer PII never leave it.
import { pino } from "pino";

/**
 * Redaction paths, S4: customer PII in job input (names, addresses) plus every
 * place a credential or token could appear. Extend when a new action adds a
 * PII input field.
 */
export const REDACT_PATHS = [
  "input.name",
  "input.address",
  "*.input.name",
  "*.input.address",
  "credentials",
  "*.credentials",
  "*.password",
  "*.otp",
  "*.username",
  "*.token",
  "req.headers.authorization",
  'req.headers["x-api-key"]',
];

export function createLogger(level = process.env.LOG_LEVEL ?? "info") {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
