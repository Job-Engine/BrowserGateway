# Claude Code Kickoff: Browser Automation Gateway v2

You are building JobEngine's Browser Automation Gateway v2: spec first, then the full application in one continuous effort. Work in two phases with one approval gate between them. Do not skip the planning phase and do not start writing application code until the spec is approved.

## Repos and inputs

| What | Where | Role |
|---|---|---|
| Planning repo | `product-ops-planning` (github.com/Job-Engine/product-ops-planning) | Where the spec lives; defines the planning conventions you must follow |
| Code repo | `Browserbase` (web-action-agent) | The prototype you are evolving into v2 |
| Architecture Review 2.0 | `BrowserGateway/architecture-review-2.0.docx` | The authoritative findings, target architecture, and build order |
| Console visual contract | `BrowserGateway/admin-console-v2.html` | The redesigned mockup; the React console must match it |
| Gateway reference docs | `Browserbase/docs/browser-automation-gateway.md`, `docs/SESSION-HANDOFF.md` | Current-state documentation (one version ahead of the code in places; the review flags the drift) |
| Agent context | `Browserbase/AGENTS.md` | Canonical machine-and-agent-facing system context; you maintain it |
| System explainer | `BrowserGateway/architecture-explorer-v2.html` | Interactive explainer of the v2 architecture for humans and agents |

Read all seven before writing anything.

## What the system is

An internal containerized service that gives JobEngine apps API access to web portals that have no API. Callers POST `{useCase, client, input}`; the gateway resolves the action from a catalogue, pulls that portal-and-client's login just in time from 1Password, drives a remote browser on Browserbase via Stagehand v3, and returns one normalized envelope (`status: success | failure | error`, `data`, `error{code}`, `meta{sessionId, sessionReplayUrl, ...}`). Target scale: 10+ platforms, each with 5 to 7 whitelabel client logins. First platform: LightReach/Palmetto (read NTP Date for a customer record).

Locked decisions (do not reopen): JIT `op read` credentials injected as Stagehand variables, self-hosted Stagehand (never hosted Browserbase agents), async + poll API, trust boundary is the gateway process, extract schemas are locked per action and never overridden per client.

## Phase 1: Spec (in product-ops-planning)

Follow the repo's own conventions exactly:

1. Read `docs/planning-artifact-model.md`, `templates/project.md`, `templates/epic.md`, `templates/story.md`, and one existing project (`projects/solarapp-permit-submission/`) as the quality bar. Note especially: stories carry a testable Outcome, Business Logic with operating rules and non-goals, and Acceptance Criteria checkable by looking at the result. Docs hold durable thinking; Asana holds execution state. Respect `AGENTS.md` (no secrets, no PII, confirm before mutating Asana).
2. Create `projects/browser-automation-gateway/` with `project.md`, `epics/`, and `stories/`, and add it to the README project list.
3. Derive the stories from Architecture Review 2.0. Suggested epic structure (adjust if you find a better cut, but justify it):
   - **Epic: stabilize** (STAB): delete the hosted-agent path; fix OTP caching, OTP goal gating, child process env; typecheck on stable TypeScript 5.x; first live LightReach run against a known record to validate assumed labels and login flow.
   - **Epic: mvp shell** (MVP): Fastify API with body limits; Postgres job store and skip-locked queue with global and per-platform concurrency caps and per-run deadlines; per-caller hashed tokens with useCase-by-client scopes and job ownership; pino with redaction and correlation IDs; single-flight secrets resolution; graceful shutdown; retries with idempotency keys; the envelope contract preserved byte-for-byte for existing fields.
   - **Epic: whitelabel** (WL): client dimension end to end (request field, `op://vault/platform.client` resolution, per-client navigation overrides merged over base actions with the extract schema excluded, client echoed in envelope, serialization per credential); second LightReach client onboarded as proof.
   - **Epic: operations** (OPS): canary runs per platform.client with drift detection and Slack alerts; metrics and per-job cost accounting; DB-backed catalogue seeded from code; the action lifecycle state machine (draft, validated, tested, live per client, versioned; see the dedicated section below); Browserbase resource registry (Contexts, sessions, replays referenced by ID and reconciled from their API); admin API (jobs ops, catalogue CRUD, token management, canary control, audit log, danger zone).
   - **Epic: console** (CON): React 19 + Vite admin console implementing `admin-console-v2.html` view by view (Home/Triage, Jobs with drawer and step timeline, Catalogue with action editor and override diff, Secrets, Access, Canaries and Alerts, Audit, Settings, Docs), read-only surfaces first, then editing.
4. Every finding in Review 2.0 Sections 3 and 4 (C1-C3, S1-S6, M1-M5, and the six simplifications) must be traceable to a story's acceptance criteria. Build a short traceability note in `project.md`.
5. STOP. Present the spec (project, epics, story list with one-line outcomes) for approval before Phase 2.

## Phase 2: Build (in the Browserbase repo)

Execute epics in the order above. House standards are mandatory:

- Node 20+, TypeScript stable 5.x (replace the preview 7.x pin), ESM.
- Fastify, zod (single source for input and extract schemas, reused for route validation), pino with redaction paths, PostgreSQL via Supabase, Vitest with TDD and 80 percent coverage, ESLint + Prettier with pre-commit hooks, React 19 + Vite for the console, Railway deployment, multi-stage Docker build running compiled output as non-root with HEALTHCHECK.
- TDD is not optional: write the failing test first for the override merge, the secrets cache (OTP never cached, single-flight), envelope mapping, queue caps and deadlines, auth scopes, and the job state machine (state advances to DONE only after the envelope is written, including under retries).
- Preserve the agent core (`src/{types,browser,loop,planner,risk,index}.ts`) with only the four changes the review names: expose `browserbaseSessionID` from the adapter, wall-clock timeout, re-plan once on observe failure, method allowlist replacing the confirm gate for read-only entries.
- Delete: `src/lightreachAgent.ts`, `examples/lightreach-server.ts`, committed `dist/`, and the hosted-agent half of `docs/lightreach-ntp-agent.md` (fold its procedure text into the catalogue entry's goal).
- Migrations: timestamped SQL files, RLS enabled, created_at/updated_at triggers.
- Keep docs in sync: update `docs/browser-automation-gateway.md` as the surface changes; the README should describe v2, not the prototype.

## AI-agent friendliness (a first-class requirement)

The system must be comprehensible and operable by AI agents, not just people. Concretely:

- `AGENTS.md` at the repo root is the canonical agent context: what the system is, the domain model, locked decisions, invariants, current-vs-target state, file map, and verification commands. Update it in the same PR as any change it describes; treat a stale AGENTS.md as a failing check. Keep its embedded JSON manifest in sync with the real API and error codes.
- The API must be self-describing: `GET /catalogue` returns platforms, actions, input schemas, variants, and clients in machine-readable form; generate an OpenAPI document from the same zod schemas used for validation and serve it at `GET /openapi.json`.
- Error codes are a closed, documented enum; envelopes are strictly typed; nothing meaningful is communicated only in prose strings.
- Every module starts with a short header comment stating its single responsibility and its place in the request flow, so an agent reading one file in isolation can orient itself.
- The spec in product-ops-planning, this file, `AGENTS.md`, and the two explorers must never contradict each other; when they would, fix the source of truth (AGENTS.md for system facts, the spec for intent) and propagate.

## Catalogue data ownership (Browserbase vs ours)

We own definitions; Browserbase owns runtime resources. Never blur this line.

- Source of truth in our Postgres: platforms, actions and their versions, goal templates, input and extract schemas, overrides, client rosters, jobs, tokens, canaries, audit, cost.
- Source of truth on Browserbase: sessions, session replays, Contexts (persisted logins), projects, usage and limits.
- The catalogue stores references to their resources: `contextId` per platform.client, `projectId`, `sessionId` per job. A reconciler syncs resource status (context warmth and age, live session count against the cap, replay availability) from the Browserbase API on a schedule and on demand; the console reads our cached copy.
- Hosted Browserbase Agents remain excluded for anything credentialed (locked decision). The only sanctioned integration is an authoring aid: "import from Browserbase agent" copies a dashboard-built agent's task prompt into a new action draft in our catalogue, where it then lives under our versioning and gates.

## The action lifecycle (adding a new action)

Actions move through an enforced state machine, not a convention. Model it in the DB, expose it in the admin API, and implement the console's new-action wizard against it.

1. **Draft**: created from a blank template, from an imported Browserbase agent prompt, or by an AI agent proposing goal template and schemas from a description plus a dry-run exploration. Drafts can never serve caller traffic.
2. **Validated**: automatic lint gate; every `{field}` placeholder in the goal template exists in the input schema, both schemas parse, no credential placeholders outside the login step, extract schema present and locked.
3. **Tested**: the built-in test runner (excluded from caller stats) must record at least one successful, match-verified run against a known record for each client the action will be enabled for. This is the first-live-run rule enforced in code: an action-client pair without a passing test physically cannot be enabled.
4. **Live per client**: enablement is per client, progressive by design. The passing test record automatically becomes that pair's canary configuration.
5. **Versioned**: editing a live action creates a new draft version that walks gates 2 to 4 again; rollback is repointing to the previous version. Every transition lands in the audit log with actor and diff.

Drafts authored by AI agents pass exactly the same gates as human drafts; capability can grow itself, safety cannot be skipped.

## Caller distribution (how other teams consume this)

- Publish a typed client SDK as `@job-engine/gateway-client` (npm): `submitJob({useCase, client, input, idempotencyKey})`, `waitForResult(jobId)` with backoff polling, envelope types and the error-code enum generated from the same zod schemas the server validates with. Semver, additive envelope changes only.
- Discovery: `GET /catalogue` and `GET /openapi.json`; README quickstart with one curl example and one SDK example.
- Optional but aligned with agent-friendliness: a thin MCP server package wrapping the SDK (`submit_job`, `get_job`, `list_catalogue`) so colleagues' AI agents call the gateway as native tools.
- Public repo hygiene: the code is public, the catalogue is strategy. Commit exactly one sanitized example action; real platform entries, goal templates, and client rosters live only in the database and private seeds. Caller tokens are issued via the admin console and live in each team's env or 1Password, never in code.

## Hard rules

- Credentials and secrets never appear in code, logs, envelopes, error messages, or prompts. Sanitize subprocess errors. The `op` child process gets a minimal env.
- Customer PII (names, addresses) is redacted from structured logs.
- Read-only enforcement lives in code (method allowlist), not in prompt text.
- The three-outcome envelope semantics are inviolable: `failure` is a clean negative business answer, `error` is a system problem. Callers automate on failure and alert on error.
- No em dashes in any document, comment, or UI copy. No emojis. Concise prose.
- Anything ambiguous: prefer the smaller build (YAGNI list in Review 2.0 Section 6 is binding; no Redis, no webhooks in v2, no write actions).

## Definition of done

- `npm run typecheck`, lint, and the full Vitest suite pass; coverage at or above 80 percent on the gateway modules.
- A live LightReach run for two different clients returns correct envelopes, and a restart mid-job does not lose the job.
- Every console view in `admin-console-v2.html` exists in the React app and is wired to the admin API.
- The spec's acceptance criteria are checked off story by story, and the project docs link to the PRs that closed them.
- `AGENTS.md` and `GET /openapi.json` accurately describe the shipped system; a fresh agent given only AGENTS.md can locate any module, run the tests, and submit a job against a local instance without further guidance.
