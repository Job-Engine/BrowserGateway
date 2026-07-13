# Browser Automation Gateway

JobEngine's internal service that gives applications API access to web portals
that have no API. Callers POST `{useCase, client, input}`; the gateway resolves
the action from a catalogue, pulls that platform-and-client's login just in
time from 1Password, drives a remote browser on Browserbase via Stagehand v3,
and returns one normalized envelope. Callers never touch credentials, prompts,
or browser infrastructure.

Read `AGENTS.md` first: domain model, locked decisions, invariants, file map,
verification commands. `GET /openapi.json` on a running instance describes the
API. `docs/browser-automation-gateway.md` is the operator reference.

## Quickstart

```bash
npm install
docker compose up -d           # local Postgres for the job store and queue
cp .env.example .env           # fill DATABASE_URL (preset for compose) and GATEWAY_DEV_TOKEN
npm run gateway                # boots, migrates, seeds the catalogue registry
```

Submit a job with curl:

```bash
curl -X POST http://localhost:8080/jobs \
  -H "authorization: Bearer $GATEWAY_DEV_TOKEN" -H "content-type: application/json" \
  -d '{"useCase":"lightreach.ntpDate","input":{"name":"Jane Homeowner","address":"123 Solar Way, Austin TX 78701"}}'
# -> 202 {"jobId":"...","state":"QUEUED"}; poll until DONE:
curl -H "authorization: Bearer $GATEWAY_DEV_TOKEN" http://localhost:8080/jobs/<jobId>
```

Or with the typed client (`packages/gateway-client`):

```ts
import { GatewayClient } from "@job-engine/gateway-client";

const gateway = new GatewayClient({
  baseUrl: "http://localhost:8080",
  token: process.env.GATEWAY_TOKEN!,
});
const envelope = await gateway.run({
  useCase: "lightreach.ntpDate",
  client: "lgcyco",
  input: { name: "Jane Homeowner", address: "123 Solar Way, Austin TX 78701" },
  idempotencyKey: "order-4711-ntp-check",
});
// envelope.status: "success" (automate), "failure" (clean negative answer,
// automate), or "error" (system problem, alert).
```

## Envelope semantics (inviolable)

`failure` is a clean negative business answer (no matching record, field
missing); callers automate on it. `error` is a system, auth, or navigation
problem; callers alert on it. Error codes are a closed enum served in
`/openapi.json`.

## Repository layout

- `src/` agent core: BrowserAgent port, plan-observe-act loop with redaction,
  Stagehand adapter. Read-only enforcement is a code-level method allowlist.
- `src/gateway/` the service: Fastify API, Postgres job store and skip-locked
  queue, per-caller scoped tokens, JIT 1Password secrets, catalogue with
  per-client navigation overrides, lifecycle registry, canaries, admin API.
- `admin-web/` React 19 + Vite admin console.
- `packages/gateway-client/` the typed caller SDK.
- `migrations/` timestamped SQL, applied automatically on boot.
- `BrowserGateway/` planning artifacts (architecture review, visual contracts).

## Verify

```bash
npm run typecheck
npm test                     # unit + integration (needs docker compose Postgres)
npx vitest run --coverage    # 80 percent gate on src/gateway
npm run lint
```

Live runs additionally need `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`,
`ANTHROPIC_API_KEY`, and either a 1Password service account
(`OP_SERVICE_ACCOUNT_TOKEN` + `OP_PORTALS_VAULT`) or `PORTAL_<KEY>_*` local
fallbacks. See `.env.example`. New action-client pairs cannot serve caller
traffic until a passing match-verified test run is recorded and the pair is
enabled (enforced in code; see the admin API).
