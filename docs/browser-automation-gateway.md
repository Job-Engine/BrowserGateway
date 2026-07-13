# Browser Automation Gateway

One containerized internal service that other apps (intake, etc.) call to run
browser automations. Callers send a use case plus business data; the gateway
picks the right agent from a catalogue, resolves that portal's login from
1Password, runs the automation on Browserbase, and returns one normalized
result. Callers never touch credentials, agent IDs, or Browserbase.

Design decisions (locked): JIT `op read` credentials, self-hosted Stagehand,
async + poll API.

## Shape

```
apps ──POST /jobs {useCase,input}──▶  Gateway (container)
                                        ├─ catalogue.ts   useCase → portal + goal + schemas
                                        ├─ secrets.ts     op read → creds (JIT)
                                        ├─ runner.ts      runAgent (Stagehand → Browserbase)
                                        └─ server.ts      async jobs, normalized envelope
                                        │
                                        ├─▶ 1Password (service-account token, portals vault)
                                        └─▶ Browserbase (remote browsers)
```

Files: `src/gateway/{types,catalogue,secrets,runner,server}.ts`.

## Authentication (why devs never touch secrets)

The trust boundary is the gateway process. The container holds exactly one
portal secret: `OP_SERVICE_ACCOUNT_TOKEN`, a 1Password service account scoped to
a single vault of portal logins. Per run, `secrets.ts` does `op read` for that
portal's `username`/`password` (and TOTP if present), hands them to the browser
run as Stagehand variables (never sent to the LLM, redacted in logs), and lets
them fall out of memory. Callers send only business data, so they cannot see a
credential.

### 1Password setup (one time)

1. Create a vault for portal logins, e.g. `Portals`.
2. Add one Login item per portal, named by its `portalKey` (e.g. `lightreach`),
   with fields `username`, `password`, and `one-time password` if it uses 2FA.
   References resolve as `op://Portals/lightreach/username`, `/password`,
   `/one-time password?attribute=otp`.
3. Create a service account scoped to that vault only; put its token in
   `OP_SERVICE_ACCOUNT_TOKEN`. Docs: https://www.1password.dev/cli

Add portal #11 = one catalogue entry + one 1Password item. No core changes.

### Local testing without a service account

If `OP_SERVICE_ACCOUNT_TOKEN` is unset, `secrets.ts` falls back to env vars
`PORTAL_<KEY>_USERNAME` / `_PASSWORD` / `_OTP`, so you can test the full path
before wiring 1Password.

## API

| Method | Path          | Body / result                                    |
| ------ | ------------- | ------------------------------------------------ |
| GET    | /health       | `{ ok: true }`                                   |
| GET    | /catalogue    | `{ useCases: [...] }`                             |
| POST   | /jobs         | `{ useCase, input }` → `202 { jobId, state }`    |
| GET    | /jobs/:id     | `{ state, envelope? }`                            |

Set `GATEWAY_TOKEN` to require `authorization: Bearer <token>` from callers.

### Envelope

```json
{
  "jobId": "…",
  "useCase": "lightreach.ntpDate",
  "status": "success | failure | error",
  "data": { "ntpDate": "…", "matchVerified": true, "…": "…" },
  "error": { "code": "MATCH_FAILED", "message": "…", "fields": ["address"] },
  "meta": { "sessionId": "…", "sessionReplayUrl": "…", "ranAt": "…", "durationMs": 0, "attempts": 1 }
}
```

`success` = goal met, `failure` = ran cleanly but negative outcome (no match /
missing field), `error` = system/auth/nav problem. `sessionId` + replay URL come
back every time for troubleshooting.

## Run it

Local:

```bash
# 1Password path:
OP_SERVICE_ACCOUNT_TOKEN=ops_... OP_PORTALS_VAULT=Portals \
BROWSERBASE_API_KEY=... BROWSERBASE_PROJECT_ID=... ANTHROPIC_API_KEY=... \
npm run gateway

# or local-cred fallback:
PORTAL_LIGHTREACH_USERNAME=... PORTAL_LIGHTREACH_PASSWORD=... \
BROWSERBASE_API_KEY=... BROWSERBASE_PROJECT_ID=... ANTHROPIC_API_KEY=... \
npm run gateway
```

Call it:

```bash
JOB=$(curl -s -X POST localhost:8080/jobs -H 'content-type: application/json' \
  -d '{"useCase":"lightreach.ntpDate","input":{"name":"Jane Homeowner","address":"123 Solar Way, Austin TX 78701"}}' \
  | jq -r .jobId)

curl -s localhost:8080/jobs/$JOB | jq   # poll until state == DONE
```

Container:

```bash
docker build -t bb-gateway .
docker run --rm -p 8080:8080 \
  -e OP_SERVICE_ACCOUNT_TOKEN -e OP_PORTALS_VAULT=Portals \
  -e BROWSERBASE_API_KEY -e BROWSERBASE_PROJECT_ID -e ANTHROPIC_API_KEY \
  bb-gateway
```

## Notes / next steps

- Job store is in-memory; swap for Redis/DB when you need durability or multiple
  replicas.
- 1Password service accounts have rate limits; `secrets.ts` caches reads for 60s
  per portal.
- Browserbase caps concurrent sessions by plan; add a queue before scaling.
- `runner.ts` auto-approves risky steps (headless login submit). Goals are
  read-only after login; tighten `classifyRisk`/`onBeforeAction` per entry if a
  portal exposes destructive actions.
- Later: switch `op read` (CLI) to the 1Password SDK for a long-running service,
  and add pre-warmed Browserbase Contexts per portal to skip most logins.
