# Lightreach NTP Passed — Browserbase Agent config

Config for the hosted Browserbase "Create agent" dialog. Purpose: look up ONE
LightReach / Palmetto account record, verify it by name + address, and report
its NTP Date. Read-only.

## Credentials (how to log in securely)

Do NOT install the 1Password browser extension in a Browserbase session; the
extension flow needs a persistent desktop 1Password app to authorize and does
not work in an ephemeral cloud browser. Use one of these instead:

1. Browserbase Context (recommended for the hosted agent). Log in once into a
   Context with `persist: true`, then reuse that `contextId` on every run so
   runs skip login. Re-auth only when the site forces a logout.
   Docs: https://docs.browserbase.com/features/contexts
2. 1Password Service Account + SDK (recommended once this moves into the repo).
   Fetch the credential at runtime via the 1Password SDK; never store it in code
   or env files; rotate in the vault without code changes.
   Docs: https://docs.browserbase.com/integrations/1password/introduction
3. Inject the secret as a Stagehand `variable` (`%password%`) so it is typed
   into the page but never sent to the LLM. The repo already does this via the
   `credentials` map + redaction in `src/loop.ts`.

## System prompt

You are an operations agent for the LightReach / Palmetto financing portal
(https://palmetto.finance/accounts). Your job each session is to look up ONE
customer record and report its NTP Date.

You will be given, in the session task, a customer record containing at minimum:

- name (customer full name)
- address (service/installation address)
  Optionally an account or project ID.

Procedure:

1. Go to https://palmetto.finance/accounts. If you are not logged in, complete
   the login using the provided credentials. If no credentials are available and
   login is required, stop and report an explicit AUTH_REQUIRED error.
2. Search for the customer using the name (and account/project ID if provided).
3. Open the matching record. Before trusting it, VERIFY the match: the record's
   customer name AND service address must both correspond to the input record.
   Minor formatting differences (case, abbreviations like St vs Street, unit
   spacing) are acceptable; a different person or a different street address is
   NOT a match.
4. If no confident name+address match is found, set matchVerified=false,
   recordFound/recordOpened accordingly, and report a MATCH_FAILED error. Do not
   read fields from a record you could not verify.
5. On a verified record, locate the "NTP Date" field and read its value exactly
   as shown. If the field exists but is blank, return ntpDate=null and note it.
   If the field cannot be found on the page, report an NTP_FIELD_NOT_FOUND error.

Rules:

- Do NOT modify, submit, save, delete, or change anything. This is read-only.
  Never click buttons that alter data.
- Make every failure explicit: populate the errors array with a code, a
  human-readable message, and the step where it occurred. Never return success
  if the match was not verified or the NTP Date was not read.
- Always report the Browserbase session ID and the timestamp when the run
  executed so failures can be troubleshooted.
- status is "success" ONLY when the record was found, the name+address match was
  verified, and the NTP Date was read (a legitimately blank value still counts
  as read). Otherwise status is "fail".

## Result schema (draft-07)

```json
{
  "$schema": "https://json-schema.org/draft-07/schema",
  "type": "object",
  "required": ["status", "sessionId", "ranAt", "recordFound", "matchVerified", "ntpDate", "errors"],
  "properties": {
    "status": {
      "type": "string",
      "enum": ["success", "fail"],
      "description": "success only if record found, name+address verified, and NTP Date read"
    },
    "sessionId": {
      "type": "string",
      "description": "Browserbase session ID for troubleshooting"
    },
    "sessionReplayUrl": {
      "type": ["string", "null"],
      "description": "Link to the session replay, if available"
    },
    "ranAt": {
      "type": "string",
      "format": "date-time",
      "description": "ISO 8601 timestamp of when the automation ran"
    },
    "recordFound": {
      "type": "boolean",
      "description": "Whether a candidate record was returned by search"
    },
    "recordOpened": {
      "type": "boolean",
      "description": "Whether the candidate record was opened"
    },
    "matchVerified": {
      "type": "boolean",
      "description": "True only if the opened record's name AND address match the input record"
    },
    "matchedName": {
      "type": ["string", "null"],
      "description": "Customer name as shown on the opened record"
    },
    "matchedAddress": {
      "type": ["string", "null"],
      "description": "Service address as shown on the opened record"
    },
    "ntpDate": {
      "type": ["string", "null"],
      "description": "NTP Date value exactly as shown; null if the field exists but is blank"
    },
    "ntpDateFound": {
      "type": "boolean",
      "description": "Whether the NTP Date field was located on the page"
    },
    "errors": {
      "type": "array",
      "description": "Explicit errors; empty when status is success",
      "items": {
        "type": "object",
        "required": ["code", "message"],
        "properties": {
          "code": {
            "type": "string",
            "enum": [
              "AUTH_REQUIRED",
              "LOGIN_FAILED",
              "SEARCH_FAILED",
              "RECORD_NOT_FOUND",
              "MATCH_FAILED",
              "NTP_FIELD_NOT_FOUND",
              "NAVIGATION_ERROR",
              "TIMEOUT",
              "UNKNOWN"
            ]
          },
          "message": { "type": "string" },
          "step": { "type": ["string", "null"] }
        },
        "additionalProperties": false
      }
    },
    "notes": {
      "type": ["string", "null"]
    }
  },
  "additionalProperties": false
}
```

## Expose as an API / run in the cloud

The hosted Agent already runs in Browserbase's cloud. There is nothing to
deploy. You "expose" it by calling the Agents REST API, and you call it from
your app through a thin backend so your API key never reaches a client.

Flow (runs are asynchronous):

1. POST https://api.browserbase.com/v1/agents/runs with `{ agentId, task, variables }`
   returns a `runId`.
2. GET https://api.browserbase.com/v1/agents/runs/{runId} until `status` is
   terminal (COMPLETED / FAILED / STOPPED / TIMED_OUT), then read `result`
   (shaped by the result schema above).

Get the real `agentId` from the dashboard: open the agent and click
"View Agent API" (the short `4ab3f2aa` in the Runs table is truncated).

Env vars:

- BROWSERBASE_API_KEY (Dashboard > Settings)
- BB_AGENT_ID (the agent's UUID)
- BB_CONTEXT_ID (optional: a logged-in Context to skip login)

Code in this repo:

- `src/lightreachAgent.ts` — `runLightreachNtpCheck(record)` plus `startNtpRun`
  / `pollRun` / `getRun`. Server-side only.
- `examples/lightreach-server.ts` — a `POST /ntp-check` endpoint (node:http, no
  framework) that your app calls.

Run the endpoint:

```bash
BROWSERBASE_API_KEY=... BB_AGENT_ID=... npx tsx examples/lightreach-server.ts
# then:
curl -X POST http://localhost:8787/ntp-check \
  -H 'Content-Type: application/json' \
  -d '{"name":"Jane Homeowner","address":"123 Solar Way, Austin TX 78701","projectId":"LR-123"}'
```

Call the REST API directly (no repo code):

```bash
# 1. start a run
curl -X POST https://api.browserbase.com/v1/agents/runs \
  -H "x-bb-api-key: $BROWSERBASE_API_KEY" -H "Content-Type: application/json" \
  -d '{"agentId":"'$BB_AGENT_ID'","task":"Look up account and report NTP Date","variables":{"name":{"value":"Jane Homeowner"},"address":{"value":"123 Solar Way, Austin TX 78701"}}}'
# 2. poll (from the returned runId)
curl https://api.browserbase.com/v1/agents/runs/$RUN_ID -H "x-bb-api-key: $BROWSERBASE_API_KEY"
```

Notes:

- Login: the hosted Agent has no 1Password SDK call, so give it a logged-in
  Context (BB_CONTEXT_ID) or store credentials in the agent. See the credentials
  section above.
- Webhooks are not available yet; integration is poll-based.
- If a run is slow or flaky, use the dashboard "Optimize" button to tighten the
  agent's prompt, then re-test.

## Per-session task template

Provide the record at run time, e.g.:

> Look up this account: name "Jane Q. Homeowner", address "123 Solar Way,
> Austin, TX 78701", project ID "LR-000123". Verify by name and address, then
> report the NTP Date.
