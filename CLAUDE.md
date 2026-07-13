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

## Where the code stands right now

Current (v1 prototype): `src/` is a working generic agent (BrowserAgent port,
ReAct loop, redaction, Stagehand adapter). `src/gateway/` is a single-tenant
prototype: one portal, no `client` dimension, in-memory job store, shared static
token, no queue, no gateway-layer tests. It runs via `npm run gateway` (node:http).

Target (v2): defined in the architecture review. Adds the client dimension,
Fastify, Postgres job store + skip-locked queue with caps and deadlines, per-caller
scoped tokens, pino, canaries, cost tracking, admin API, React 19 console.

Do not replicate these known v1 defects: OTP cached past its 30s life (C1);
unbounded fire-and-forget jobs with no wall-clock timeout (C2); unbounded in-memory
job map (C3); no ownership check on `GET /jobs/:id` (S1); OTP goal text gated on the
unrelated `projectId` field (M1); `op` subprocess inheriting the full env (M2).

## Folder state notes (observed this handoff)

- Authoritative planning artifacts live in `BrowserGateway/`. The `-v2` files are
  current; the non-v2 `architecture-explorer.html` / `admin-console-mockup.html`
  and `general-architecture-review.docx` are earlier versions.
- Duplicates of some artifacts also sit at the repo root
  (`admin-console-mockup.html`, `architecture-explorer.html`,
  `general-architecture-review.docx`). Treat `BrowserGateway/` as canonical; these
  root copies can be removed.
- `BrowserGateway/Dev/` is an almost-empty scaffold (just `.remember/`); no code yet.
- `ipsilon-redesign-brief.md` at the root appears unrelated to the gateway; treat as
  out of scope unless told otherwise.
- The hosted-agent path (`src/lightreachAgent.ts`, `examples/lightreach-server.ts`,
  the hosted half of `docs/lightreach-ntp-agent.md`) is scheduled for deletion. Do
  not extend it.

## Do this first (Phase 0, in THIS repo, before the big rebuild)

These de-risk everything and are independent of the planning repo:

1. Pin TypeScript to a stable 5.x line (the repo currently pins a preview 7.x that
   has never compiled here), then get `npm run typecheck` green.
2. Delete the hosted-agent path; fold its system-prompt procedure text into the
   LightReach catalogue entry's goal.
3. Fix C1 (never cache OTP), M1 (gate OTP goal text on the credential having an OTP
   field, not on `projectId`), and M2 (pass a minimal env to the `op` child process).
4. Do the first live LightReach run against a known record and correct the assumed
   field label ("NTP Date") and login/search flow in the catalogue. This is the
   cheapest de-risking available; do it before building the shell.

Then follow the two-phase process in `claude-code-instructions.md`: write the spec
in `product-ops-planning` (Phase 1, approval gate), then build epics STAB -> MVP ->
WL -> OPS -> CON here (Phase 2). If you do not have access to the product-ops-planning
repo, still do Phase 0 above and flag the missing access rather than skipping the spec.

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
- Preserve the agent core; the only sanctioned changes are the four the review
  names: expose `browserbaseSessionID` from the adapter, wall-clock timeout, re-plan
  once on observe failure, method allowlist replacing the confirm gate for read-only.
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
