# AGENTS.md: Browser Automation Gateway

Canonical context for any AI agent working in or reasoning about this repository. Read this first. It states what the system is, what it must become, and the rules that are not yours to change.

## What this is

The Browser Automation Gateway is JobEngine's internal service that gives applications API access to web portals that have no API. A caller submits `{useCase, client, input}`; the gateway resolves the action from a catalogue, fetches that platform-and-client's login just in time from 1Password, drives a remote browser on Browserbase via Stagehand v3, and returns one normalized envelope. Callers never touch credentials, prompts, or browser infrastructure. First platform: LightReach/Palmetto financing portal (read the NTP Date for a customer record). Target scale: 10+ platforms, each with 5 to 7 whitelabel client logins.

## Machine-readable manifest

```json
{
  "name": "browser-automation-gateway",
  "owner": "andy@gojobengine.com",
  "purpose": "API access to portals that have no API, via LLM-driven cloud browsers",
  "domain": {
    "platform": "a website the gateway can operate (e.g. lightreach)",
    "action": "one task on a platform; owns inputSchema (zod), buildGoal(input), extractSchema (zod, LOCKED, never overridden per client), variants as input enums",
    "client": "a whitelabel login identity on a platform; credential item op://<vault>/<platform>.<client>; may carry navigation-only overrides: labelMap, startUrl, goalHints, timeout",
    "job": "one request: {useCase: 'platform.action', client, input}; async, poll for result",
    "envelope": {
      "jobId": "string",
      "useCase": "string",
      "client": "string",
      "status": "success | failure | error",
      "data": "shaped by the action's extractSchema",
      "error": {
        "code": "INVALID_INPUT | AUTH_UNAVAILABLE | RUN_ERROR | ACTION_BLOCKED | TIMEOUT | MATCH_FAILED | NTP_FIELD_NOT_FOUND | GOAL_NOT_COMPLETED | GATEWAY_ERROR",
        "message": "sanitized"
      },
      "meta": {
        "sessionId": "string",
        "sessionReplayUrl": "string",
        "ranAt": "iso",
        "durationMs": "number",
        "attempts": "number",
        "stepsUsed": "number",
        "mode": "replay | learned | healed (additive; present on every run that reaches the browser)",
        "traceVersion": "number (additive; the replay trace version used or recorded)"
      }
    },
    "statusSemantics": {
      "success": "goal met, record match verified, data extracted (a legitimately blank field still counts)",
      "failure": "ran cleanly with a negative business outcome (no match, missing record); callers may automate on this",
      "error": "system, auth, or navigation problem; callers alert on this"
    }
  },
  "api": {
    "public": ["GET /health", "GET /openapi.json", "GET /catalogue", "POST /jobs", "GET /jobs/:id"],
    "admin": [
      "GET /admin/stats",
      "GET /admin/jobs",
      "GET /admin/jobs/:id",
      "POST /admin/tokens",
      "GET /admin/tokens",
      "POST /admin/tokens/:id/disable",
      "GET /admin/catalogue",
      "POST /admin/catalogue/:useCase/validate",
      "POST /admin/catalogue/:useCase/clients/:client/record-test",
      "POST /admin/catalogue/:useCase/clients/:client/enable",
      "POST /admin/catalogue/:useCase/clients/:client/disable",
      "POST /admin/canaries/run",
      "GET /admin/audit",
      "GET /admin/traces",
      "POST /admin/traces/:useCase/:client/invalidate"
    ],
    "style": "async + poll; POST /jobs returns 202 {jobId, state}; poll GET /jobs/:id until state DONE; job states QUEUED -> RUNNING -> DONE"
  },
  "lockedDecisions": [
    "credentials fetched just in time via 1Password (op read / SDK), injected as Stagehand variables, never visible to callers or LLMs",
    "self-hosted Stagehand runner on Browserbase remote browsers; never hosted Browserbase agents",
    "async + poll API",
    "trust boundary is the gateway process; the container's only long-lived secrets are vault-scoped 1Password service account tokens",
    "extract schemas are locked per action and never overridden per client; a client whose data shape differs gets a new action",
    "read-only: no form submission, payment, or destructive action; enforced in code by a method allowlist, not prompt text"
  ],
  "invariants": [
    "secrets never appear in code, logs, envelopes, error messages, or LLM prompts",
    "customer PII is redacted from structured logs",
    "failure and error are never conflated",
    "job state advances to DONE only after the envelope is written",
    "TOTP codes are never cached",
    "one 1Password login item per platform.client pair; one vault per domain; one service account per vault",
    "an action-client pair cannot serve caller traffic without a passing match-verified test run (the first-live-run rule, enforced in code)",
    "action definitions are versioned; edits create a new draft version that re-walks the validation and test gates"
  ],
  "dataOwnership": {
    "ours (Postgres)": "platforms, actions and versions, goal templates, schemas, overrides, client rosters, jobs, tokens, canaries, audit, cost, replay traces (action_traces: versioned per useCase and client, at most one active, secret-scrubbed at save)",
    "browserbase": "sessions, replays, Contexts, projects, usage; referenced by ID from our catalogue and reconciled via their API, never the source of truth for definitions"
  },
  "actionLifecycle": ["draft", "validated", "tested", "live-per-client", "versioned"]
}
```

## Current state vs target state

**Current (v2 build in progress):** `src/` is the agent core (BrowserAgent port, ReAct loop, redaction, Stagehand adapter) with four sanctioned v2 changes applied: `sessionId` exposed from the adapter, `timeoutMs` wall-clock budget on `runAgent`, one free re-plan on observe failure, and `allowedMethods` enforcing read-only in code. A fifth sanctioned change reopens the same core freeze for deterministic replay: `readText(selector)` on the `BrowserAgent` port (`src/browser.ts`, `src/types.ts`), fail-fast and never throwing, plus the new `src/replay.ts` module (trace types, input parameterization, identity matching, the replay executor, and `runDeterministic`, the session owner that tries replay first and falls back to learn). Rationale: at thousands of runs per day, replaying a learned trace with zero LLM calls is a unit-economics necessity, not a nice-to-have. `src/gateway/` is the v2 shell: Fastify API (body limits, per-caller hashed scoped tokens, fail closed, ownership-checked job reads), Postgres job store and FOR UPDATE SKIP LOCKED queue (global, per-platform caps, per-credential serialization, deadlines, sweep), pino with PII redaction, single-flight JIT secrets keyed by `platform.client` credential item, catalogue with per-client navigation-only overrides, and a versioned trace store (`src/gateway/traces.ts`, `action_traces` table) behind `GET /admin/traces` and `POST /admin/traces/:useCase/:client/invalidate`. Run locally: `docker compose up -d`, set `DATABASE_URL` and `GATEWAY_DEV_TOKEN`, `npm run gateway`.

Every job resolves to one of three run paths, chosen in `runJob` (`src/gateway/runner.ts`): **replay**, when an active trace exists for the useCase-and-client pair, executing the stored steps with zero LLM calls and verifying reads by fuzzy identity match (`meta.mode: "replay"`); **learn**, when no active trace exists, driving the LLM ReAct loop and, on success, recording a new trace grounded with `observe` (`meta.mode: "learned"`); and **heal**, when a replay attempt fails and the same job falls through to learn without a separate round trip, re-recording the trace and flagging the event as `trace.healed` (rather than `trace.recorded`) in the audit log (`meta.mode: "healed"`).

Epic status: all five epics done (STAB, MVP, WL, OPS, CON). Live-validated on 2026-07-14: `lightreach.ntpDate:spartan` is LIVE, having walked validate -> record-test -> enable against real runs (one record with an NTP date, one without; both success with matchVerified true). The validated portal flow is documented in `docs/lightreach-ntp-agent.md`. Remaining: onboard a second client with its own credential to complete the two-client definition-of-done item.

Fixed and locked in (do not regress): TOTP never cached (username/password keep a 60s cache); OTP goal step follows the resolved credential, not `projectId`; the `op` subprocess gets a minimal env (`OP_SERVICE_ACCOUNT_TOKEN`, `HOME`, `PATH`); jobs are durable with wall-clock deadlines; `GET /jobs/:id` is ownership-scoped. The hosted-agent path is deleted; self-hosted Stagehand is the only path.

## File map

| Path                                  | Role                                                                                                                                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`                        | BrowserAgent port + core types; the seam that makes the loop testable                                                                                                                                                                                |
| `src/browser.ts`                      | Stagehand v3 adapter (Browserbase or local); adds `readText(selector)`, fail-fast, never throws (sanctioned change 5)                                                                                                                                |
| `src/loop.ts`                         | The agent loop: plan, observe, classify, act, extract; redaction lives here                                                                                                                                                                          |
| `src/planner.ts`                      | LLM planning step (via extract); sees variable names, never values                                                                                                                                                                                   |
| `src/risk.ts`                         | Risk keyword classifier (CLI confirm flow only; gateway runs use the code-enforced method allowlist)                                                                                                                                                 |
| `src/index.ts`                        | `runAgent()` entry; never throws for operational failures                                                                                                                                                                                            |
| `src/replay.ts`                       | deterministic replay (sanctioned change 5): trace types, `parameterizeSteps`, `resolveStep`, `normalizeIdentity` + `fuzzyMatch`, `replayTrace` (executor), `runDeterministic` (session owner: replay first, learn fallback, read-selector grounding) |
| `src/gateway/catalogue.ts`            | useCase registry: portal, url, schemas, buildGoal, client rosters + navigation overrides, per-action `replay` plan (base entry only, not client-overridable), resolveAction                                                                          |
| `src/gateway/secrets.ts`              | JIT 1Password resolution per platform.client; 60s username/password cache, OTP never cached, single-flight, minimal op env                                                                                                                           |
| `src/gateway/runner.ts`               | one job end to end: validate, creds, `runDeterministic` (replay / learn / heal, read-only allowlist, timeout), trace bookkeeping, envelope (`meta.mode`, `meta.traceVersion`)                                                                        |
| `src/gateway/traces.ts`               | versioned `action_traces` store: at most one active trace per useCase+client, retired history kept, `heal_count`, secret scrub enforced at save                                                                                                      |
| `src/gateway/registry.ts`             | DB-backed lifecycle: validation lint gate, first-live-run rule, enablement, canary state, audit                                                                                                                                                      |
| `src/gateway/db.ts`                   | pg pool + migration runner (migrations/*.sql, applied on boot)                                                                                                                                                                                       |
| `src/gateway/jobs/store.ts`           | durable job store: enqueue with idempotency, skip-locked claim under caps, complete/requeue, sweep                                                                                                                                                   |
| `src/gateway/queue/worker.ts`         | claim loop, one retry for transient errors, cost accounting, graceful drain                                                                                                                                                                          |
| `src/gateway/auth/tokens.ts`          | per-caller hashed tokens, useCase:client scopes, fail closed                                                                                                                                                                                         |
| `src/gateway/api/app.ts`              | Fastify public surface: health, openapi, catalogue, jobs                                                                                                                                                                                             |
| `src/gateway/api/admin.ts`            | /admin surface: jobs ops, tokens, catalogue lifecycle, canaries, audit, traces (`GET /admin/traces` summaries, `POST /admin/traces/:useCase/:client/invalidate`)                                                                                     |
| `src/gateway/api/openapi.ts`          | GET /openapi.json document + the closed error-code enum                                                                                                                                                                                              |
| `src/gateway/canary/scheduler.ts`     | scheduled known-record runs per live pair; Slack/log alerts                                                                                                                                                                                          |
| `src/gateway/observability/logger.ts` | pino with PII and credential redaction                                                                                                                                                                                                               |
| `src/gateway/server.ts`               | composition root: pool, migrate, seed, queue, canary, Fastify, SIGTERM drain                                                                                                                                                                         |
| `migrations/`                         | ordered SQL migrations (schema source of truth)                                                                                                                                                                                                      |
| `packages/gateway-client/`            | @job-engine/gateway-client typed caller SDK                                                                                                                                                                                                          |
| `admin-web/`                          | React 19 + Vite admin console (visual contract: BrowserGateway/admin-console-v2.html)                                                                                                                                                                |
| `docs/browser-automation-gateway.md`  | gateway v2 operator/integrator reference                                                                                                                                                                                                             |
| `docs/SESSION-HANDOFF.md`             | session context and decision history                                                                                                                                                                                                                 |
| `BrowserGateway/`                     | planning artifacts: reviews, mockups, instructions, feature guide                                                                                                                                                                                    |

## Glossary

Platform: a website the gateway can drive. Action: one task on it, `platform.action`, with a fixed recipe and locked output shape. Client: a whitelabel login identity (`lgcyco`, `brandx`). Override: a client's navigation-only adjustments to a base action (label map, start URL, goal hints, timeout); never the output shape. Canary: a scheduled known-record job per platform.client that catches broken logins and layout drift early. Replay: the Browserbase session recording attached to every job. Trace replay: the deterministic re-execution of a stored action trace (`src/replay.ts`), zero LLM calls; not to be confused with the session recording above. Envelope: the uniform answer object every job returns.

## Working rules for agents

- House stack for all new code: Node 20+, TypeScript stable 5.x, Fastify, zod, pino, PostgreSQL (Supabase), Vitest with TDD and 80 percent coverage, React 19 + Vite, Railway. ESLint + Prettier.
- Validate at the boundary with zod; keep domain (`catalogue`) pure and adapters (`secrets`, `runner`, `server`) replaceable.
- Never log, print, echo, or commit a secret. Sanitize subprocess errors. Pass minimal env to child processes.
- Keep the envelope contract stable; additive changes only.
- Update this file and `docs/` whenever the surface changes; stale context is worse than none.
- Verification: `npm run typecheck`, `npm test`. A live run needs `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `ANTHROPIC_API_KEY`, and either `OP_SERVICE_ACCOUNT_TOKEN` + `OP_PORTALS_VAULT` or `PORTAL_<KEY>_USERNAME/_PASSWORD` fallbacks.
- Writing style everywhere (docs, comments, UI copy): no em dashes, no emojis, concise.
