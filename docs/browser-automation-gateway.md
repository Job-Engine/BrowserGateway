# Browser Automation Gateway v2 reference

Operator and integrator reference for the shipped v2 system. `AGENTS.md` holds
the canonical domain model and invariants; `GET /openapi.json` is generated
from the same zod schemas the routes validate with.

## Request flow

1. Caller POSTs `{useCase, client, input, idempotencyKey?}` with a per-caller
   bearer token. The API validates the token (sha256 hash lookup, fail
   closed), the scope (`useCase:client` with wildcards), the client roster,
   the lifecycle gate (pair must be live), and the input (zod).
2. The job lands in Postgres as QUEUED. 202 returns `{jobId, state}`.
   Duplicate idempotency keys return the existing job.
3. The queue worker claims the oldest eligible job with
   `FOR UPDATE SKIP LOCKED` under a global cap, per-platform caps, and
   per-`platform.client` credential serialization, stamps a deadline, and
   increments attempts.
4. The runner resolves the pair's credentials just in time
   (`op://<vault>/<platform>.<client>`; TOTP never cached; single-flight;
   minimal env to the `op` child), builds the goal from the catalogue entry
   plus the client's navigation overrides, and drives the agent core with the
   read-only method allowlist and a wall-clock timeout.
5. The envelope is written in the same statement that advances the job to
   DONE. Transient system errors retry once. A reaper sweeps RUNNING jobs
   past their deadline into TIMEOUT envelopes (covers crashed workers).
6. Caller polls `GET /jobs/:id` (ownership enforced) until state DONE.

## Job states and envelope

States: `QUEUED -> RUNNING -> DONE`. A DONE job always carries an envelope
(database constraint). Envelope: `status` success | failure | error, `data`
shaped by the action's locked extract schema, `error {code, message,
fields?}`, `meta {sessionId, sessionReplayUrl, ranAt, durationMs, attempts,
stepsUsed}`, plus `useCase`, `client`, `jobId`.

Closed error-code enum: `INVALID_INPUT, AUTH_UNAVAILABLE, RUN_ERROR,
ACTION_BLOCKED, TIMEOUT, MATCH_FAILED, NTP_FIELD_NOT_FOUND,
GOAL_NOT_COMPLETED, GATEWAY_ERROR`. `MATCH_FAILED` and `NTP_FIELD_NOT_FOUND`
ride on `failure`; everything else on `error`.

## Public API

| Route               | Notes                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------- |
| `GET /health`       | no auth                                                                               |
| `GET /openapi.json` | no auth, self-description                                                             |
| `GET /catalogue`    | v1-compatible `useCases` plus `actions` with JSON schemas and client rosters          |
| `POST /jobs`        | 202 async; 400 unknown useCase/client or invalid input; 403 unscoped or pair not live |
| `GET /jobs/:id`     | only the submitting caller (admins see all)                                           |

## Admin API (isAdmin tokens, under /admin)

`GET /admin/stats`, `GET /admin/jobs?state=&limit=`, `GET /admin/jobs/:id`,
`POST /admin/tokens` (plaintext returned exactly once), `GET /admin/tokens`,
`POST /admin/tokens/:id/disable`, `GET /admin/catalogue`,
`POST /admin/catalogue/:useCase/validate`,
`POST /admin/catalogue/:useCase/clients/:client/record-test {jobId}`,
`.../enable`, `.../disable`, `POST /admin/canaries/run`, `GET /admin/audit`.

## Action lifecycle (enforced in code)

Actions seed from `src/gateway/catalogue.ts` as draft. `validate` runs the
lint gate (every goal placeholder exists in the input schema or is a
credential variable). `record-test` requires a DONE, success, match-verified
job for that exact pair and stores its input as the canary config. `enable`
refuses without a recorded passing test (the first-live-run rule). Only live
pairs accept caller traffic; admin callers may submit test runs to any pair.

## Canaries and cost

With `GATEWAY_CANARY_INTERVAL_MS` set, every live pair reruns its recorded
known-record input on the interval; failures alert to `SLACK_WEBHOOK_URL` or
the log, and land on the pair (`lastCanaryStatus`, `lastCanaryAt`). Cost per
job = `stepsUsed x GATEWAY_COST_PER_STEP_USD`, stored on the job row.

## Operations

- Boot: migrations apply automatically; the registry seeds from code.
- Shutdown: SIGTERM stops claiming, drains in-flight runs, closes the pool.
- Concurrency: `GATEWAY_GLOBAL_CAP` (default 3), `GATEWAY_PLATFORM_CAP`
  (default 2), plus one-run-per-credential serialization.
- Local dev: `docker compose up -d`, `GATEWAY_DEV_TOKEN` seeds one admin
  caller. Production issues scoped tokens via the admin API and never sets it.
- Logs: pino JSON with redaction (customer PII in inputs, credentials,
  authorization headers). Correlation: reqId per request, jobId on queue logs.

## Onboarding a new client on an existing action

1. Add the client to the action's roster in `catalogue.ts` (overrides are
   navigation-only; the extract schema cannot be overridden).
2. Create the 1Password login item `platform.client` in the portals vault.
3. Deploy; the registry seeds the pair as disabled.
4. Submit a test run as admin against a known record; `record-test` with the
   job id; `enable` the pair. The test input becomes the canary.

## Not in v2 (binding YAGNI)

No Redis or queue infrastructure beyond Postgres, no webhooks, no write
actions, no rules DSL for overrides, no GraphQL or gRPC, no plugin system.
