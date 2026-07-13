# Browser Automation Gateway — Architecture Review 2.0

July 11, 2026 | JobEngine | Repo: Browserbase (web-action-agent) | Supersedes Review 1.0

Text mirror of `architecture-review-2.0.docx` so agents can read it without Word.
The .docx remains the formatted original; if they diverge, the .docx is authoritative
for prose and this file is the working copy for agents. Companion artifacts:
`admin-console-v2.html`, `architecture-explorer-v2.html`, `claude-code-instructions.md`,
`browser-gateway-features.docx`.

## 1. Executive summary

The architecture is sound and deliberately small; the trust boundary, the
three-outcome envelope, and the platform/action/client domain model are the right
decisions. The harder truth: the documentation is about one version ahead of the
code. The whitelabel client dimension, the centerpiece of the domain model, does
not exist in the code at all. The gateway today is a single-tenant prototype: one
portal, one credential path, an in-memory job store, a shared static token, no
concurrency control.

Three things next, in order: (1) delete the parallel hosted-agent path (it
contradicts a locked decision and duplicates the one use case); (2) fix three
critical defects before any real traffic (OTP caching, unbounded job spawning,
unbounded in-memory store); (3) rebuild the gateway shell (not the agent core) on
the house stack (Fastify, Postgres, pino, Vitest) with the client dimension,
per-caller scoped tokens, a queue, and the admin API. The agent core (BrowserAgent
port, loop, redaction, Stagehand adapter) is good and carries over almost unchanged.

## 2. Docs vs code (the drift)

| Claim in docs / Review 1.0 | Reality in code | Consequence |
|---|---|---|
| Callers POST {useCase, client, input} | server.ts reads only useCase and input; no client field | Whitelabel model exists only in mockups; biggest single build item |
| Credentials at op://vault/platform.client | secrets.ts resolves op://vault/<portalKey> only; cache keyed by portal | Credential model must be reworked before a second client onboards |
| Per-client navigation overrides merge over base actions | No override concept in catalogue.ts | Override merging must be built and unit tested |
| Credentials "fall out of memory" per run | Module-global cache holds plaintext creds 60s | Docs overstate the guarantee; OTP caching is a real bug (C1) |
| Envelope reports attempts and duration | attempts hardcoded to 1; durationMs 0 on error path | Misleading meta; retries documented but not implemented |
| Risky actions are gated | Gateway passes autoApprove; every risky action approved | Read-only safety rests on prompt text, not code (S3) |
| Self-hosted Stagehand is the locked runner | A competing hosted-agent path still ships | Two ways to do the same job; guaranteed drift; delete it |

The domain model survives the audit; the code just has not caught up.

## 3. Simplify first: delete and collapse (ranked by payoff)

1. Delete the hosted-agent path. `src/lightreachAgent.ts` (193 lines),
   `examples/lightreach-server.ts`, and the hosted half of
   `docs/lightreach-ntp-agent.md` implement the LightReach lookup a second way,
   against the locked self-hosted decision. Keep only the system-prompt text (the
   best written spec of the LightReach procedure) and fold it into the catalogue
   entry's goal.
2. Collapse the double LLM call per step. Every loop step runs plan (via extract)
   then observe: ~20-40 LLM round trips per job. Stagehand observe is goal-capable;
   a single "observe the next action toward the goal" call serves most steps.
   Biggest cost and latency lever.
3. Replace the decorative risk gate with a method allowlist. classifyRisk uses
   substring matching ("sign" matches "design"/"assign") and the gateway
   auto-approves anyway. For read-only actions, allow only safe methods (click,
   fill, select, press) and block submission/destructive verbs in code.
4. One build story. package.json points at dist/, the Dockerfile runs tsx against
   src/, and a committed dist/ sits in the repo. Use compiled output in the
   container; stop committing dist/.
5. Surface the session ID from the adapter. runner.ts regex-scrapes it from the
   replay URL; Stagehand exposes browserbaseSessionID directly. Return it from the
   BrowserAgent port.
6. Rename the package to the browser gateway (not "web-action-agent, per-action
   human confirmation").

## 4. Correctness and security findings (fix before production traffic)

| ID | Finding | Fix | Severity |
|---|---|---|---|
| C1 | TOTP cached 60s but rotates every 30s; a second 2FA job in-window reuses an expired code, causing flaky login failures | Never cache OTP; resolve fresh per run; cache username/password only | Critical |
| C2 | POST /jobs spawns unbounded fire-and-forget runs with no wall-clock timeout; stuck runs pin every Browserbase session and wedge the gateway | Bounded worker pool, global + per-platform caps, per-run deadline, guaranteed session teardown | Critical |
| C3 | In-memory job store: jobs lost on restart, callers poll into 404s after deploy, map grows unbounded | Postgres-backed job store with eviction/retention | Critical |
| S1 | GET /jobs/:id has no ownership check; one shared token lets any caller read another's envelope (contains PII) | Per-caller tokens; scope job reads to submitter | High |
| S2 | Single shared static bearer token, timing-unsafe compare, fail-open when GATEWAY_TOKEN unset | Hashed per-caller keys, constant-time compare, fail-closed | High |
| S3 | Gateway disables the confirm gate via autoApprove; read-only enforced only by prompt text | Method allowlist per entry | High |
| S4 | Customer PII in input (name, address) not redacted from logs/events; only creds are | Extend redaction to configured input fields at the logger | High |
| S5 | Unbounded request body buffering in readJson: trivial memory exhaustion | Body size limit + content-type check (free with Fastify) | High |
| S6 | No single-flight on credential resolution: concurrent jobs stampede op read and burn 1Password rate budget | Dedupe in-flight reads by credential reference | High |
| M1 | OTP inclusion in the goal gated on projectId (an unrelated field); 2FA portals invoked without projectId never told to enter the code | Gate OTP text on the credential having an OTP field | Medium |
| M2 | op subprocess inherits full process env (Browserbase + Anthropic keys) | Pass a minimal env to the child | Medium |
| M3 | Raw error messages (incl. subprocess stderr) flow into envelopes and logs | Sanitize and code-map errors at the boundary | Medium |
| M4 | No SIGTERM handling: deploys drop in-flight runs and leak sessions | Graceful drain on shutdown | Medium |
| M5 | Zero tests on the gateway layer (catalogue, secrets, runner, server) | TDD the rebuild; priority units in Section 7 | Medium |

Pattern: the agent core is careful (fail-closed gates, redaction, guaranteed
session close); the gateway shell was built fast as a prototype. That is the right
place for the debt, because Section 6 replaces that shell anyway.

## 5. Missing features

Needed for production (two or more apps depending on it): client (whitelabel)
dimension; durable Postgres job store; queue + concurrency caps; per-run timeout
budget; retries with idempotency keys; per-caller auth and scopes; structured
logging + correlation IDs; metrics + cost tracking; canary runs per
platform.client; Browserbase Contexts fast path; admin API; DB-backed catalogue
(extract schema stays locked; seed from code at launch).

Worth having (ranked): webhooks on completion (M); live job progress SSE feeding
the console timeline (M); dry-run mode returning planned steps (S); per-entry model
and step-budget config (S); golden-record regression fixtures per portal (M); batch
jobs (one login, N lookups) (M); 1Password SDK instead of op CLI (M); portal health
status page from canaries (S).

## 6. Target architecture v2

Keep the good bones: BrowserAgent port and owned loop, JIT credentials, Stagehand
on Browserbase, async + poll, the stable three-outcome envelope. Add only the shell
that makes it multi-tenant, durable, observable. One service, one database.

| Module | Responsibility |
|---|---|
| core/ | Existing agent, nearly unchanged: expose sessionId on the port, add a wall-clock timeout, re-plan once on observe failure, method allowlist instead of the confirm gate for read-only entries |
| catalogue/ | DB-backed registry: Platform, Action (goal template + locked extract schema), Client (credentialRef + navigation overrides); resolver merges base + override; seeded from code at launch |
| secrets/ | resolveCredentials(platform, client) via op://vault/platform.client; single-flight; 60s cache excluding OTP; env fallback for local dev |
| jobs/ | Postgres store: state machine QUEUED -> RUNNING -> DONE, envelope JSONB, callerId, unique idempotencyKey |
| queue/ | Postgres worker loop (FOR UPDATE SKIP LOCKED), global + per-platform caps, per-run deadline, backpressure |
| api/ | Fastify: public surface (health, catalogue, jobs) + admin surface (jobs ops, catalogue CRUD, tokens, canaries, flags, audit, danger zone) under separate auth |
| auth/ | Hashed per-caller API keys with useCase-by-client scopes; admin role separate; constant-time compare; fail closed |
| observability/ | pino with redaction serializers and correlation IDs; metrics; per-job cost accounting |
| canary/ | Scheduled per-platform.client known-record runs; health table; drift detection; Slack alerts |
| admin-web/ | React 19 + Vite console implementing admin-console-v2.html |

Explicitly not yet (YAGNI, binding): no Redis/Kafka/dedicated queue infra (Postgres
skip-locked is enough); no multi-region or autoscaling (one Railway service +
Postgres); no write actions (stay read-only; the gate machinery stays dormant); no
rules DSL for overrides, no GraphQL, no gRPC, no plugin system (plain JSON overrides
and REST suffice).

## 7. Tech stack for the rebuild

Node 20+ with TypeScript pinned to a stable 5.x line (the repo currently pins a
preview TypeScript 7 and tsc has never actually been run; resolve first). Fastify
with schema validation from the same zod definitions, plus rate limiting and body
limits. pino with redaction paths. PostgreSQL (Supabase) for jobs, catalogue,
tokens, canaries, audit, cost; credentials remain exclusively in 1Password. Vitest
with TDD and the 80 percent coverage gate; priority units: override merge, secrets
cache (OTP exclusion + single-flight), envelope mapping, queue concurrency caps.
React 19 + Vite for the console. Railway hosting with a multi-stage Docker build,
non-root user, compiled output, HEALTHCHECK, SIGTERM draining. ESLint + Prettier
with pre-commit hooks.

## 8. Admin console: verdict and redesign

Feature set is right; the original presentation was not. Three structural problems
the redesign fixes: every entity was a dead end (no navigation between a job and its
action/client/credential/caller); health signals scattered across four views with
no single triage surface; status colors overloaded one palette (running, failed, and
draft all rendered amber). `admin-console-v2.html` resolves all three: a Home/Triage
view ranks what is wrong now and deep-links to the fix; every entity cross-links;
outcome pills and lifecycle chips are separate visual families. It adds the missing
views (live step timeline, effective-config override diff, canary drift and history,
alert inbox, new-platform wizard, one-time token reveal) and a design token system
that transfers to the React build. It is the visual contract: build what it shows.

## 9. Roadmap (build order, optimized to de-risk)

1. Typecheck on a real machine; delete the hosted-agent path; fix C1 (OTP), M1 (OTP
   gating), M2 (child env). Small, immediate.
2. First live LightReach run against a known record; correct the assumed field
   labels and login flow in the catalogue. Cheapest de-risking; do it before
   building anything else.
3. Rebuild the shell: Fastify API, Postgres jobs and queue with caps and deadlines
   (C2, C3), per-caller scoped tokens (S1, S2), pino (S4), body limits (S5),
   single-flight secrets (S6). TDD throughout.
4. Add the client dimension end to end; onboard a second LightReach client to prove
   the override model.
5. Onboard a second platform to prove the platform template; write the
   entry-authoring checklist.
6. Canaries per platform.client with drift alerts to Slack; cost accounting.
7. Browserbase Contexts fast path; 1Password SDK swap.
8. Admin console in React 19 + Vite against the admin API, implementing
   admin-console-v2.html; read-only first, then catalogue editing.

Bottom line: nothing structural changes. The prototype proved the design; the
rebuild gives it the shell (durability, multi-tenancy, observability, an operable
console) that lets two or more applications depend on it.
