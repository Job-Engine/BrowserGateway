# Session Handoff — Browserbase / Browser Automation Gateway

Purpose: pick up this work in a new session (on a stronger model) with full
context. Read this top to bottom, then open the files listed under "Files".

Date: 2026-07-11. Repo: `Browserbase` (web-action-agent). Owner: andy@gojobengine.com.

---

## 1. Goal

Build internal tooling so multiple apps (an intake app and others) can run
browser automations against 10+ external platform portals (starting with the
LightReach / Palmetto financing portal at https://palmetto.finance/accounts)
without each app handling credentials or Browserbase directly.

Concrete first use case ("Lightreach NTP Passed"): given a customer record
(name + address, optional project ID), log into the portal, search for the
record, open it, VERIFY the match by name AND address, read the **NTP Date**
field, and return: session id (for troubleshooting), success/failure, the NTP
Date value, the run timestamp, and explicit errors.

---

## 2. What exists now (starting point)

Before this session the repo already had a working generic agent (`web-action-agent`,
Tasks 1-8 complete): `runAgent()` drives a Browserbase cloud browser via
Stagehand v3, plans/observes/acts in a loop, gates risky actions, redacts
secrets, and returns a structured result. Entry points: `src/index.ts`
(`runAgent`), `src/cli.ts`. See `src/{types,browser,loop,planner,risk}.ts`.

This session added, on top of that, (a) a hosted Browserbase Agent config,
(b) a REST client for it, and (c) a containerized gateway. Details below.

---

## 3. Decisions locked this session

- Credential delivery: **JIT `op read`** (1Password CLI, per run) → injected as
  Stagehand variables. (Considered: pre-warmed Contexts, hybrid — deferred.)
- Runner behind the gateway: **self-hosted Stagehand** via existing `runAgent`.
  (Not the hosted Browserbase Agent, because hosted agents can't cleanly do
  op-CLI credential injection.)
- API style: **async + poll** (`POST /jobs` → `jobId`, `GET /jobs/:id`).
- 1Password: use it **generically** per https://www.1password.dev/cli. No
  pre-existing org conventions/vaults; a dedicated portals vault will be created.

---

## 4. Key facts learned (from Browserbase + Stagehand docs)

- **1Password on Browserbase**: do NOT install the 1Password browser extension in
  a session (no persistent desktop app to authorize it). Supported paths:
  (1) 1Password Service Account + SDK/CLI to fetch creds at runtime;
  (2) inject as Stagehand `variables` (never sent to the LLM);
  (3) Browserbase **Contexts** (`persist:true`) to reuse a logged-in session.
- **Stagehand `variables`**: `%name%` placeholders in act/observe instructions,
  values not shared with LLM providers — ideal for secrets. Repo already redacts
  secret values in logs (`src/loop.ts`).
- **Browserbase Contexts**: persist cookies/auth across sessions; log in once
  with `persist:true`, reuse `contextId`. Contexts live indefinitely but sites
  can force logout, so need a re-auth fallback.
- **Hosted Agents API** (for the dashboard agent): async.
  `POST https://api.browserbase.com/v1/agents/runs` with `{agentId, task, variables, browserSettings}` → `{runId}`.
  `GET /v1/agents/runs/{runId}` until status in COMPLETED/FAILED/STOPPED/TIMED_OUT,
  then read `result`. Header `x-bb-api-key`. Pass per-run values via `variables`
  (`%var%`), not inline. No webhooks yet (poll). Get real `agentId` from the
  dashboard "View Agent API".
- **Browserbase Functions** exist (deploy TS to their runtime, invoke as API),
  but we chose our own container for full control over 1Password + catalogue.
- **1Password CLI**: service account token (`OP_SERVICE_ACCOUNT_TOKEN`) for
  headless/containers (not biometric). Secret refs: `op://<vault>/<item>/<field>`,
  TOTP via `?attribute=otp`. `op read` for single values. Service accounts have
  rate limits (cache reads, pass IDs in hot loops).

---

## 5. Architecture (the gateway)

```
apps ──POST /jobs {useCase,input}──▶  Gateway (container)
                                        ├─ catalogue.ts   useCase → portal + goal + schemas
                                        ├─ secrets.ts     op read → creds (JIT), env fallback
                                        ├─ runner.ts      runAgent (Stagehand → Browserbase), normalize
                                        └─ server.ts      async jobs, in-memory store, envelope
                                        │
                                        ├─▶ 1Password (service-account token, portals vault only)
                                        └─▶ Browserbase (remote browsers)
```

Trust boundary = the gateway process. Container holds one portal secret
(`OP_SERVICE_ACCOUNT_TOKEN`, scoped to the portals vault). Callers send only
`{useCase, input}` and can never see a credential. Adding portal #11 = one
catalogue entry + one 1Password login item.

### Response envelope (stable across all portals)

```json
{
  "jobId": "…",
  "useCase": "lightreach.ntpDate",
  "status": "success | failure | error",
  "data": { "ntpDate": "…", "matchVerified": true },
  "error": { "code": "MATCH_FAILED", "message": "…", "fields": ["address"] },
  "meta": {
    "sessionId": "…",
    "sessionReplayUrl": "…",
    "ranAt": "…",
    "durationMs": 0,
    "attempts": 1
  }
}
```

`success` = goal met; `failure` = ran cleanly, negative outcome (no match /
missing field); `error` = system/auth/nav problem.

---

## 6. Files (all created/modified this session)

Gateway (new, the main deliverable):

- `src/gateway/types.ts` — JobEnvelope, JobStatus, JobRecord.
- `src/gateway/catalogue.ts` — useCase registry; `lightreach.ntpDate` entry;
  `getEntry()`. Each entry: portalKey, url, inputSchema (zod), extractSchema,
  buildGoal(input), requiresLogin.
- `src/gateway/secrets.ts` — `resolvePortalCredentials(portalKey)` via `op read`
  (service account token), 60s per-portal cache, local env fallback
  (`PORTAL_<KEY>_USERNAME/_PASSWORD/_OTP`).
- `src/gateway/runner.ts` — `runJob()` validates input, resolves creds, calls
  `runAgent`, maps to envelope. Auto-approves risky steps (headless login).
- `src/gateway/server.ts` — node:http; GET /health, GET /catalogue,
  POST /jobs (202 + jobId), GET /jobs/:id. Optional `GATEWAY_TOKEN` bearer auth.
- `Dockerfile` — node:20-slim + 1Password CLI (`op`); runs the gateway. No local
  Chromium (uses Browserbase remote browsers).

Hosted-agent path (alternative/earlier work, still valid):

- `src/lightreachAgent.ts` — REST client for the dashboard "Lightreach NTP Passed"
  agent (`startNtpRun`, `pollRun`, `getRun`, `runLightreachNtpCheck`).
- `examples/lightreach-server.ts` — minimal backend endpoint wrapping that client.

Config/docs:

- `.env.example` — added PORT, GATEWAY_TOKEN, OP_SERVICE_ACCOUNT_TOKEN,
  OP_PORTALS_VAULT, PORTAL_* fallback.
- `package.json` — added `"gateway": "tsx src/gateway/server.ts"`.
- `docs/browser-automation-gateway.md` — full gateway reference.
- `docs/lightreach-ntp-agent.md` — hosted agent system prompt, result schema,
  credential notes, REST usage.
- `docs/SESSION-HANDOFF.md` — this file.

Pre-existing (unchanged core): `src/{index,browser,loop,planner,risk,types,cli}.ts`.

---

## 7. How to run / test

Local (env-cred fallback, no 1Password needed yet):

```bash
PORTAL_LIGHTREACH_USERNAME=... PORTAL_LIGHTREACH_PASSWORD=... \
BROWSERBASE_API_KEY=... BROWSERBASE_PROJECT_ID=... ANTHROPIC_API_KEY=... \
npm run gateway

JOB=$(curl -s -X POST localhost:8080/jobs -H 'content-type: application/json' \
  -d '{"useCase":"lightreach.ntpDate","input":{"name":"Jane Homeowner","address":"123 Solar Way, Austin TX 78701"}}' | jq -r .jobId)
curl -s localhost:8080/jobs/$JOB | jq   # poll until state == DONE
```

1Password path: create vault `Portals`, add login item `lightreach`
(username/password[/one-time password]), create a service account scoped to that
vault, set `OP_SERVICE_ACCOUNT_TOKEN` + `OP_PORTALS_VAULT=Portals`, drop the
PORTAL_* vars. Same code path.

Container: `docker build -t bb-gateway . && docker run --rm -p 8080:8080 -e OP_SERVICE_ACCOUNT_TOKEN -e OP_PORTALS_VAULT -e BROWSERBASE_API_KEY -e BROWSERBASE_PROJECT_ID -e ANTHROPIC_API_KEY bb-gateway`.

---

## 8. Verification status / known gaps

- All new `.ts` files pass `node --experimental-strip-types --check` (syntax).
- Full `tsc` NOT run this session: the sandbox `node_modules` are macOS-built
  (native TS/esbuild binaries missing for Linux). **Run `npm run typecheck` on a
  real machine** before trusting types. Watch: `input` cast to
  `Record<string,string>` in runner (projectId optional); zod v4 `.issues` shape.
- No live browser run executed (needs real BROWSERBASE/ANTHROPIC keys).
- The exact portal field label "NTP Date" and the search/login UI are ASSUMED.
  First live run should be against a known record to confirm labels; adjust
  `catalogue.ts` buildGoal / extractSchema accordingly.
- Hosted agent already had runs in the dashboard (1 Complete, 1 Failed) under
  project "Gojobengine / Production project"; agentId shown truncated as 4ab3f2aa.

---

## 9. Next steps (recommended order)

1. `npm run typecheck` + fix any type issues; then a live LightReach run to
   confirm field labels and login flow.
2. Add a 2nd portal to `catalogue.ts` as the template for the other nine
   (entry + 1Password item). Consider per-entry `evaluate()` for success rules.
3. Add per-portal Browserbase **Contexts** (pre-warmed login) as a fast path,
   with a "logged out?" detector falling back to JIT `op read`.
4. Harden: durable job store (Redis/DB) instead of in-memory; a queue for
   Browserbase concurrency limits; per-entry risk config; structured logging with
   caller correlation IDs; switch `op` CLI → 1Password SDK for the long-running
   service.
5. Auth callers to the gateway (GATEWAY_TOKEN / mTLS / internal-only network).

---

## 10. Prefs / constraints to carry forward

- No em dashes. Be concise. No emojis unless asked.
- Never expose internal secrets or credentials in logs or responses.
- Save deliverables to the `Browserbase` workspace folder.
