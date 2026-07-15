# CLAUDE.md — Claude Code entry point

Start here. This file orients Claude Code for building the Browser Automation
Gateway v2. It does not restate the whole design; it tells you what to read, where
the code stands right now, and what to do first. Facts live in `AGENTS.md`; the
process lives in `BrowserGateway/claude-code-instructions.md`; the audit and plan
live in `BrowserGateway/architecture-review-2.0.md`. If any two disagree, fix the
source of truth (AGENTS.md for system facts, the spec for intent) and propagate.

## Read in this order

1. `AGENTS.md` — canonical system context: domain model, locked decisions,
   invariants, current-vs-target state, file map, verification commands.
2. `BrowserGateway/architecture-review-2.0.md` — the audit: docs-vs-code drift,
   what to delete, findings C1-C3 / S1-S6 / M1-M5, target modules, roadmap.
   (`architecture-review-2.0.docx` is the formatted original.)
3. `BrowserGateway/claude-code-instructions.md` — the two-phase build kickoff
   (spec first in product-ops-planning, then build here) and the definition of done.
4. `BrowserGateway/admin-console-v2.html` — visual contract for the React console.
5. `BrowserGateway/architecture-explorer-v2.html` — interactive system explainer.
6. `docs/browser-automation-gateway.md` and `docs/SESSION-HANDOFF.md` — v1
   reference and decision history (one version ahead of the code in places).
7. `BrowserGateway/browser-gateway-features.docx` — plain-language feature guide
   (useful for console copy and stakeholder framing).

## What this is (one paragraph)

An internal containerized service that gives JobEngine apps API access to web
portals that have no API. Callers POST `{useCase, client, input}`; the gateway
resolves the action from a catalogue, pulls that platform-and-client login just in
time from 1Password, drives a remote browser on Browserbase via Stagehand v3, and
returns one normalized envelope (`status: success | failure | error`, `data`,
`error{code}`, `meta{sessionId, sessionReplayUrl, ...}`). Target scale: 10+
platforms, each with 5 to 7 whitelabel client logins. First platform:
LightReach/Palmetto (read the NTP Date for a customer record).

Locked decisions (do not reopen): JIT `op read` credentials injected as Stagehand
variables; self-hosted Stagehand, never hosted Browserbase agents; async + poll;
the trust boundary is the gateway process; extract schemas are locked per action and
never overridden per client; read-only, enforced in code by a method allowlist.

## Where the code stands right now (updated 2026-07-15)

v2 is built and green on branch `feat/gateway-v2`. STAB, MVP, WL, and OPS epics
are done: TypeScript 5.9 pinned, hosted-agent path deleted, C1/C2/C3, S1-S6,
M1-M5 fixed with tests; five sanctioned core changes applied (sessionId from
the adapter, wall-clock timeout, one free re-plan on observe failure,
read-only method allowlist, and the `readText` adapter primitive plus
`src/replay.ts` for deterministic replay). `src/gateway/` is the v2 shell:
Fastify, Postgres job store + skip-locked queue (caps, deadlines,
per-credential serialization), per-caller hashed scoped tokens, pino
redaction, lifecycle registry with the first-live-run rule, canaries, cost
columns, admin API, `GET /openapi.json`, and `packages/gateway-client`
(typed SDK). Deterministic replay is built: traces are recorded per useCase
and client, replayed with zero LLM calls, and healed (relearned and
re-recorded in the same job) on portal drift. 116+ tests, coverage gate 80
percent on `src/gateway` (actual ~93). Run: `docker compose up -d`, `.env`
from example, `npm run gateway`.

The Phase 1 spec lives in the local clone `~/Desktop/product-ops-planning` on
branch `browser-automation-gateway-spec` (32 stories, 5 epics, traceability in
project.md). NOT pushed; awaiting user review.

## Outstanding (blocked or in flight)

1. First live LightReach run: blocked on credentials. `.env` exists at the repo
   root with TODO markers; once filled, run a known-record job, correct the
   assumed "NTP Date" label and login/search flow in `catalogue.ts` and
   `docs/lightreach-ntp-agent.md`, then walk the lifecycle
   (validate, record-test, enable) via the admin API.
2. Admin console (`admin-web/`, CON epic) per `admin-console-v2.html`.
3. Push the spec branch in product-ops-planning after user approval.
4. Definition-of-done items needing live creds: two-client live runs,
   restart-mid-job check.

## Folder state notes

- Authoritative planning artifacts live in `BrowserGateway/` (`-v2` files are
  current). Root duplicates were removed.
- `ipsilon-redesign-brief.md` at the root is unrelated; out of scope.
- `BrowserGateway/Dev/` holds only session memory (`.remember/`), no code.
- Postgres for dev/tests comes from `docker-compose.yml` (port 5433); tests
  create a throwaway database per file.

The two-phase process from `claude-code-instructions.md` (spec in
product-ops-planning, then build STAB -> MVP -> WL -> OPS -> CON here) has been
executed through OPS; CON and the live validation remain (see Outstanding above).

## House stack and hard rules

Node 20+, TypeScript stable 5.x, ESM. Fastify, zod (one source for input, extract,
and route validation), pino with redaction paths, PostgreSQL via Supabase, Vitest
with TDD and 80 percent coverage on gateway modules, ESLint + Prettier with
pre-commit hooks, React 19 + Vite for the console, Railway with a multi-stage Docker
build running compiled output as non-root with HEALTHCHECK and SIGTERM draining.

- Secrets never appear in code, logs, envelopes, error messages, or LLM prompts.
  Sanitize subprocess errors. The `op` child gets a minimal env.
- Customer PII (names, addresses) is redacted from structured logs.
- Read-only enforcement lives in code (method allowlist), not prompt text.
- Envelope semantics are inviolable: `failure` is a clean negative business answer
  (callers automate on it); `error` is a system problem (callers alert on it).
- Keep the envelope contract stable; additive changes only.
- Preserve the agent core; the only sanctioned changes are the five the review
  and the deterministic-replay design name: expose `browserbaseSessionID` from the
  adapter, wall-clock timeout, re-plan once on observe failure, method allowlist
  replacing the confirm gate for read-only, and `readText` plus `src/replay.ts`
  for deterministic replay (unit economics at thousands of runs per day).
- Prefer the smaller build; the YAGNI list in the review is binding (no Redis, no
  webhooks in v2, no write actions).
- Writing style everywhere (docs, comments, UI copy): no em dashes, no emojis, concise.
- Keep `AGENTS.md` and `GET /openapi.json` in sync with the shipped system in the
  same PR as any change; a stale `AGENTS.md` is a failing check.

## Verify

- `npm run typecheck` and `npm test` (Vitest). Coverage >= 80 percent on gateway
  modules.
- A live run needs `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`,
  `ANTHROPIC_API_KEY`, and either `OP_SERVICE_ACCOUNT_TOKEN` + `OP_PORTALS_VAULT`
  or `PORTAL_<KEY>_USERNAME` / `_PASSWORD` local fallbacks. See `.env.example`.
- Definition of done for v2 is in `claude-code-instructions.md`: a fresh agent given
  only `AGENTS.md` can locate any module, run the tests, and submit a job against a
  local instance without further guidance.
