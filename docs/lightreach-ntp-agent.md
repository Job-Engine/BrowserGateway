# LightReach NTP Date action

Reference notes for the `lightreach.ntpDate` catalogue entry. The action looks
up ONE LightReach / Palmetto account record (https://palmetto.finance/accounts),
verifies it by name and address, and reads its NTP Date. Read-only.

The procedure below is the source spec for the goal text in
`src/gateway/catalogue.ts` (`buildGoal`). If the procedure changes, update both
in the same PR. The hosted Browserbase Agent variant of this lookup was removed;
self-hosted Stagehand through the gateway is the only sanctioned path (locked
decision).

## Credentials (how the login works securely)

Do NOT install the 1Password browser extension in a Browserbase session; the
extension flow needs a persistent desktop 1Password app to authorize and does
not work in an ephemeral cloud browser. The gateway instead:

1. Resolves the login just in time from 1Password via a service account
   (`op://<vault>/lightreach/{username,password[,one-time password]}`), or
   `PORTAL_LIGHTREACH_*` env vars as a local fallback. See
   `src/gateway/secrets.ts`. The TOTP is never cached; username and password are
   cached for 60s to respect service-account rate limits.
2. Injects the values as Stagehand variables (`%username%`, `%password%`,
   `%otp%`) so they are typed into the page but never sent to the LLM. Redaction
   lives in `src/loop.ts`.
3. Mentions the one-time-code step in the goal only when the resolved credential
   actually has an OTP field.

A logged-in Browserbase Context per platform-and-client is the planned fast path
to skip login on warm runs (v2 OPS scope).

## Procedure (the spec behind buildGoal)

1. Go to https://palmetto.finance/accounts. If not logged in, complete the login
   using the provided credentials. If no credentials are available and login is
   required, stop and report an explicit AUTH_REQUIRED error.
2. Search for the customer using the name (and account/project ID if provided).
3. Open the matching record. Before trusting it, VERIFY the match: the record's
   customer name AND service address must both correspond to the input record.
   Minor formatting differences (case, abbreviations like St vs Street, unit
   spacing) are acceptable; a different person or a different street address is
   NOT a match.
4. If no confident name+address match is found, set matchVerified=false and
   report a MATCH_FAILED failure. Do not read fields from a record you could not
   verify.
5. On a verified record, locate the "NTP Date" field and read its value exactly
   as shown. If the field exists but is blank, return ntpDate=null and note it.
   If the field cannot be found on the page, report NTP_FIELD_NOT_FOUND.

Rules:

- Never modify, submit, save, delete, or change anything. Read-only.
- Never report success if the match was not verified or the NTP Date was not
  read. A legitimately blank value still counts as read.
- Every run reports the Browserbase session ID and replay URL in the envelope
  meta for troubleshooting.

## Extract shape

The locked extract schema lives in `src/gateway/catalogue.ts`:
`{ matchVerified, matchedName, matchedAddress, ntpDateFound, ntpDate }`.
Envelope mapping (`src/gateway/runner.ts`): `matchVerified=false` becomes a
`failure` with `MATCH_FAILED`; `ntpDateFound=false` becomes a `failure` with
`NTP_FIELD_NOT_FOUND`; system problems become `error`.

## Validation status

Validated live on 2026-07-14 against two known Spartan records (one with NTP
complete, one without). Observed portal reality, now encoded in the goal and
extract schema descriptions:

- Login is a plain email/username + password form; no 2FA on the Spartan item.
- Search is a single accounts search box; typing the customer name lists
  matching rows with a status column.
- There is no field literally labeled "NTP Date". The value is the date shown
  next to the "Notice to Proceed" milestone at the top of the record's
  Progress Tracker. When the NTP is not complete, no date is displayed:
  the correct envelope is success with `ntpDate: null` (callers read null as
  "NTP not done yet"). Status words like "Submitted" are never the value.
- A run takes 5 to 6 agent steps, roughly 80 to 100 seconds. The Browserbase
  session lease must outlive the run (`sessionTimeoutSeconds`, wired from the
  run's `timeoutMs`); their default ~300s lease kills slower runs mid-flight.
- Records list an "Ext. Reference" number usable for disambiguation when two
  customers share a name.
