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
        "code": "AUTH_REQUIRED | LOGIN_FAILED | SEARCH_FAILED | RECORD_NOT_FOUND | MATCH_FAILED | FIELD_NOT_FOUND | NAVIGATION_ERROR | TIMEOUT",
        "message": "sanitized"
      },
      "meta": {
        "sessionId": "string",
        "sessionReplayUrl": "string",
        "credentialItem": "string",
        "ranAt": "iso",
        "durationMs": "number",
        "attempts": "number"
      }
    },
    "statusSemantics": {
      "success": "goal met, record match verified, data extracted (a legitimately blank field still counts)",
      "failure": "ran cleanly with a negative business outcome (no match, missing record); callers may automate on this",
      "error": "system, auth, or navigation problem; callers alert on this"
    }
  },
  "api": {
    "public": ["GET /health", "GET /catalogue", "POST /jobs", "GET /jobs/:id"],
    "style": "async + poll; POST /jobs returns 202 {jobId}; poll GET /jobs/:id until state DONE"
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
    "ours (Postgres)": "platforms, actions and versions, goal templates, schemas, overrides, client rosters, jobs, tokens, canaries, audit, cost",
    "browserbase": "sessions, replays, Contexts, projects, usage; referenced by ID from our catalogue and reconciled via their API, never the source of truth for definitions"
  },
  "actionLifecycle": ["draft", "validated", "tested", "live-per-client", "versioned"]
}
```

## Current state vs target state

Two truths coexist in this repo; do not confuse them.

**Current (v1 prototype):** `src/` is a working generic agent (BrowserAgent port, ReAct loop, redaction, Stagehand adapter) and `src/gateway/` is a single-tenant prototype: one portal, no `client` dimension, in-memory job store, shared static token, no queue, no tests on the gateway layer. `docs/browser-automation-gateway.md` describes this layer but is one version ahead of the code in places.

**Target (v2):** defined authoritatively in `BrowserGateway/architecture-review-2.0.docx` (findings, target modules, build order) and kicked off by `BrowserGateway/claude-code-instructions.md` (two-phase: spec in the product-ops-planning repo, then build). Visual contracts: `BrowserGateway/admin-console-v2.html` (admin console) and `BrowserGateway/architecture-explorer-v2.html` (system explainer). v2 adds: the client dimension, Fastify API, Postgres job store and queue with concurrency caps and deadlines, per-caller scoped tokens, pino logging, canaries, cost tracking, admin API, React 19 console.

Fixed in STAB (do not regress): TOTP is never cached (username/password keep a 60s cache); the OTP goal step follows the resolved credential having an OTP field, not `projectId`; the `op` subprocess gets a minimal env (`OP_SERVICE_ACCOUNT_TOKEN`, `HOME`, `PATH`). The hosted-agent path (`src/lightreachAgent.ts`, `examples/lightreach-server.ts`) is deleted; self-hosted Stagehand is the only path. Remaining v1 defects an agent must not replicate: unbounded fire-and-forget job spawning with no wall-clock timeout, unbounded in-memory job map, no ownership check on `GET /jobs/:id`.

## File map

| Path                                 | Role                                                                        |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `src/types.ts`                       | BrowserAgent port + core types; the seam that makes the loop testable       |
| `src/browser.ts`                     | Stagehand v3 adapter (Browserbase or local)                                 |
| `src/loop.ts`                        | The agent loop: plan, observe, classify, act, extract; redaction lives here |
| `src/planner.ts`                     | LLM planning step (via extract); sees variable names, never values          |
| `src/risk.ts`                        | Risk keyword classifier (being replaced by a method allowlist in v2)        |
| `src/index.ts`                       | `runAgent()` entry; never throws for operational failures                   |
| `src/gateway/catalogue.ts`           | useCase registry: portal, url, schemas, buildGoal                           |
| `src/gateway/secrets.ts`             | JIT 1Password resolution, 60s cache, env fallback                           |
| `src/gateway/runner.ts`              | one job end to end: validate, creds, runAgent, envelope                     |
| `src/gateway/server.ts`              | HTTP surface (node:http in v1, Fastify in v2)                               |
| `docs/browser-automation-gateway.md` | gateway reference (v1)                                                      |
| `docs/SESSION-HANDOFF.md`            | session context and decision history                                        |
| `BrowserGateway/`                    | planning artifacts: reviews, mockups, instructions, feature guide           |

## Glossary

Platform: a website the gateway can drive. Action: one task on it, `platform.action`, with a fixed recipe and locked output shape. Client: a whitelabel login identity (`lgcyco`, `brandx`). Override: a client's navigation-only adjustments to a base action (label map, start URL, goal hints, timeout); never the output shape. Canary: a scheduled known-record job per platform.client that catches broken logins and layout drift early. Replay: the Browserbase session recording attached to every job. Envelope: the uniform answer object every job returns.

## Working rules for agents

- House stack for all new code: Node 20+, TypeScript stable 5.x, Fastify, zod, pino, PostgreSQL (Supabase), Vitest with TDD and 80 percent coverage, React 19 + Vite, Railway. ESLint + Prettier.
- Validate at the boundary with zod; keep domain (`catalogue`) pure and adapters (`secrets`, `runner`, `server`) replaceable.
- Never log, print, echo, or commit a secret. Sanitize subprocess errors. Pass minimal env to child processes.
- Keep the envelope contract stable; additive changes only.
- Update this file and `docs/` whenever the surface changes; stale context is worse than none.
- Verification: `npm run typecheck`, `npm test`. A live run needs `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, `ANTHROPIC_API_KEY`, and either `OP_SERVICE_ACCOUNT_TOKEN` + `OP_PORTALS_VAULT` or `PORTAL_<KEY>_USERNAME/_PASSWORD` fallbacks.
- Writing style everywhere (docs, comments, UI copy): no em dashes, no emojis, concise.
