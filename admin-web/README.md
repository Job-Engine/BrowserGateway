# Gateway Admin Console

The React 19 + Vite admin console for the Browser Automation Gateway (CON epic).
It implements the visual contract in `BrowserGateway/admin-console-v2.html` and is
built against the gateway admin API in `src/gateway/api/admin.ts`.

## Views

- Home / Triage: what is wrong now (red canaries, error-heavy pairs, backlog,
  long-running jobs), headline stats, recent runs-by-outcome, running strip.
- Jobs: filterable table plus a detail drawer with the full envelope, session
  replay link, input, and per-step progress.
- Catalogue: actions and per-client lifecycle chips with the transitions
  validate, record test, enable, disable (first-live-run rule enforced server-side).
- Access: caller tokens, issue a scoped token with a one-time reveal, disable.
- Canaries & Alerts: per-pair canary status and a run-all trigger.
- Audit: the append-only admin action log.
- Settings: gateway base URL and admin token.
- Docs: how to call the gateway, status semantics, error-code taxonomy, a curl example.

## Run against a local gateway

1. Start the gateway (from the repo root): `docker compose up -d` then `npm run gateway`.
   It listens on `http://localhost:8080` by default.
2. Install and start the console:

   ```sh
   cd admin-web
   npm install
   npm run dev
   ```

   Or from the repo root: `npm run console:dev`.

3. Open the printed URL (default `http://localhost:5173`). On first load, enter the
   gateway base URL and an admin bearer token. The token is kept in `sessionStorage`
   for this tab only; it is never written to code or `localStorage`.

### Dev proxy and CORS

In dev, Vite proxies the gateway paths (`/admin`, `/jobs`, `/health`, `/catalogue`,
`/openapi.json`) to the gateway so the browser makes same-origin requests and never
trips CORS. The default target is `http://localhost:8080`; override it with the
`GATEWAY_ORIGIN` environment variable when the gateway runs elsewhere. The client
automatically sends requests for a `localhost`/`127.0.0.1` base URL through the proxy
in dev; a remote base URL is called directly (and would need CORS on the gateway).

## Build

```sh
npm run build   # tsc -b && vite build, output in dist/
```

From the repo root: `npm run console:build`. `dist/` and `node_modules/` are
git-ignored.

## Getting an admin token

Admin routes require a caller whose token has `isAdmin: true`. Seed one against a
running gateway, for example:

```sh
curl -sS -X POST http://localhost:8080/admin/tokens \
  -H "authorization: Bearer $EXISTING_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{ "name": "console", "scopes": ["*:*"], "isAdmin": true }'
```

The plaintext token is returned once. Paste it into the console on first load.
