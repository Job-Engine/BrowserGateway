# LightReach Extension — Investigation & Design (2026-08-27)

Synthesis of four read-only Fable investigations of this repo, commissioned to plan
extending the gateway's LightReach action for a **SpartanX consumer** (job-automation,
issue #467). The consumer needs three fields per record — **NTP Approved Date, NTP
Blockers (stipulations), Credit Expiration Date** — looked up by **palmetto account id**
(deterministic), falling back to name+address only if the id lookup fails.

Companion (consumer side): job-automation `docs/specs/lightreach-integration/`
(spec v1.2 + PHASE-0-RECON.md). Live tracker artifact:
https://claude.ai/code/artifact/18b67cee-4a75-4ade-b1f9-652f3071c0ee

The pivot that led here: the consumer was about to build portal acquisition itself, then
found this gateway already runs `lightreach.ntpDate:spartan` live (since 2026-07-14). The
gateway owns everything portal-side; job-automation becomes a thin caller.

---

## 0. THE decision — DOM read vs. HTTP action class

**This is the fork that gates the whole extension, and it's a genuine architecture call.**

- **Phase-0 recon (consumer side) found a clean cookie-auth JSON API behind the Palmetto
  SPA** — endpoints keyed by account id give all three fields exactly:
  `api/v2/accounts/{id}` (milestones → Notice to Proceed → completedAt = NTP date),
  `api/accounts/{id}/stipulations`, `api/accounts/{id}/applications[].creditExpiryDate`.
- **But this gateway reads the DOM only.** Its primitives are Stagehand `observe`/`act`/
  `readText`; `READ_ONLY_METHODS` has no `goto`/`fetch`. **There is no HTTP action class**,
  so the recon's JSON API is *unusable by current gateway primitives.* (gw-lightreach)

So delivering stips + credit-expiry requires one of:

**Option A — stay DOM-native.** Read the three fields from the *rendered* SPA. Fits the
gateway's grain and the replay/learn/heal machinery. **Blocking unknown:** are stips and
creditExpiryDate actually *rendered in the DOM* (and on which tab)? NTP date is (Progress
Tracker). The other two were only observed in JSON during recon — if they never render,
the DOM gateway cannot deliver them, full stop. **Resolve with one manual portal look**
before locking the extract schema.

**Option B — add an authenticated-HTTP action class to the gateway.** After the existing
browser login, reuse the session cookies to call the JSON endpoints directly. Leverages the
recon: deterministic, exact by-id, all three fields guaranteed, **no fuzzy matching, no
replay/heal needed** (a JSON GET doesn't drift). Cost: a real new capability in a gateway
whose thesis is "portals with *no* API" — LightReach is the exception that *has* one. This
is more upfront gateway work but structurally the most robust, and it makes the by-id
lookup trivially exact.

**Recommendation to weigh:** Option B is technically superior for *this* platform precisely
because Palmetto has an API — it sidesteps DOM drift, name-matching, and the replay engine
entirely. Option A is less new-code but carries the rendering unknown and keeps the
fuzzy-match fragility. **Do the one manual portal look first** (does credit/stips render?):
if they don't render, the decision is made for us (B, or the fields can't ship). Andy's call.

---

## 1. How `lightreach.ntpDate` works today (gw-lightreach)

- **Input** `{name, address, projectId?}`; **extract** `{matchVerified, matchedName,
  matchedAddress, ntpDateFound, ntpDate}` (`catalogue.ts:123-146`). Matches by customer
  **name + service address** (fuzzy, "when in doubt reject").
- **Credentials** JIT `op read op://<vault>/<credentialItem>/{username,password,otp}`;
  Spartan uses explicit `credentialItem: "Lightreach - Spartan"` (`catalogue.ts:187`),
  plain email+password, no 2FA, 5-6 steps / 80-100s, needs `timeoutMs: 600_000`.
- **Run paths** replay (zero-LLM trace) → learn (LLM ReAct, records trace) → heal (replay
  fail falls through to learn same session). Trace bookkeeping gates on the final *success*
  envelope (Fix B).
- **Catalogue is code-defined** (`CATALOGUE` map), DB owns only lifecycle/enablement.
  Extract schema is locked *per-client-override* (a client can't change the shape), but
  **nothing prevents editing the base schema** — and **action versioning is aspirational,
  not implemented** (`actions.version` exists, nothing bumps it). So an in-place extract
  edit silently changes a live action on next deploy.

## 2. Recommended extension design (gw-lightreach) — assumes Option A (DOM)

**Two new actions, do NOT extend `ntpDate` in place:**
1. `lightreach.accountSnapshot` — primary, **by account id**, all three fields, WITH a
   replay plan. Input `{palmettoAccountId, name, address}` (name+address kept for verify).
   `url: "https://palmetto.finance/accounts/%palmettoAccountId%"` (URL template, resolved
   in the runner — lintable, Fix-A-protected; not a function hook).
2. `lightreach.accountSnapshotByIdentity` — fallback, name+address, **no replay plan** (so
   it never thrashes the by-id trace; takes the LLM path every time; rare).

**Extract (both share the const):** `{matchVerified, matchedName, matchedAddress, ntpDate,
creditExpiryDate, stipulationsText}` — all **nullable-text reads + `matchVerified`
assertTrue**, **no found-flags**. This means **zero runner/error-enum changes**
(`matchVerified===false → MATCH_FAILED` still fires; a null field = success-with-null per
statusSemantics). Load-bearing replay rule: *every* extract field must be a nullable-text
read or an assertTrue constant, or replay heals every run.

**Stips mapping stays in the consumer:** the gateway returns raw `stipulationsText`;
job-automation derives "Stips"/"N-A". (readText yields one string, can't compute a boolean;
and portal stip vocab is a superset of SubHub's — mapping is consumer policy.)

**Why one combined snapshot action, not three single-field:** one login/session per record;
per-credential queue serialization makes 3 actions strictly sequential anyway. One session,
three reads = the unit-economics the replay feature exists for.

**By-id bypasses the search, not the verify** — keep name+address verify (the id may live
only in the URL, which readText can't read). Add `verify: {matchedAccountId}` only if the id
renders on the page.

> Note: under **Option B (HTTP)** this design simplifies further — no fuzzy verify, no
> replay plan, extract becomes exact structured fields. The two-action split (by-id primary
> / by-identity fallback) still holds.

## 3. Empirical unknowns to resolve before locking the schema

1. **Do stips + creditExpiryDate render in the SPA DOM?** (Decides Option A viability.)
2. **Does `palmetto.finance/accounts/<id>` survive the login redirect?** Neither replay nor
   learn can `goto` mid-run. If the redirect drops the deep link, the id flow degrades to
   typing the id into search.

Both resolve with **one manual portal look or one live learn run** against a known account.

## 4. Gateway quality findings (gw-core, gw-shell) — not blockers, but ours to respect

- **Replay-vs-learn failure-taxonomy divergence** (gw-core): an absent NTP field returns
  success-with-null on replay but `NTP_FIELD_NOT_FOUND` on learn. The recommended
  no-found-flags extract **sidesteps this** (null everywhere). Good.
- **Redaction hole** (gw-shell): extracted `data` holds customer PII (matchedName/address)
  with no redact path. Adding fields keeps this true. **Never `log.info({envelope})`; add
  new PII fields to `REDACT_PATHS` in lockstep.**
- **No retention path** (gw-shell): jobs/audit rows grow forever. Worth a retention job
  before high-volume sweep traffic.
- **Runner leaks lightreach field names** (`matchVerified`/`ntpDateFound` hardcoded,
  `NTP_FIELD_NOT_FOUND` in the enum). Harmless under the no-found-flags design; generalizing
  to per-entry `failureSignals` is optional cleanup.
- **"No form submission enforced by allowlist" is overstated** (gw-core): the allowlist
  constrains verbs, not targets — `click`/`press`/`fill` can submit a form. Real mitigation
  is goal text + verify. Doc fix.

## 5. Declutter plan (gw-declutter) — proposed, NOT executed (Andy approves)

**The architecture-review-2.0.md is EXECUTED HISTORY**, not the current map: it audited the
v1 prototype (July 11); the July 13-15 rebuild executed its roadmap. Every C/S/M finding is
**RESOLVED** in code except **M3 partial** (error CODES mapped + secret values redacted, but
no stderr sanitizer — `runner.ts:124`/`worker.ts:56` pass raw `e.message`; AGENTS.md:103
"sanitize subprocess errors" overstates). The code is in far better shape than the repo's
smell suggests: **zero TODO/FIXME**, findings genuinely fixed, 171 test blocks.

The rot is documentation + planning-artifact clutter:

1. **DONE tonight (secret exposure):** `.env.bak-pre-rotation-20260827` deleted;
   `.gitignore` now covers `.env.bak*`/`*.bak`/`.claude/skills/`.
   ⚠ **Separate question for Andy:** the Browserbase + Anthropic keys were NOT part of the
   OP-token rotation — are they owed one? (They sat in the deleted backup, but the values
   live on in `.env`.)
2. **Fix CLAUDE.md** (:44-45 omits CON epic; :64-74 "Outstanding" lists finished work as
   blocked; :78-83 references nonexistent files; :21 mislabels the v2 operator doc as v1).
   It currently misdirects any agent that reads it. Add a header line to
   architecture-review-2.0.md: "Executed July 13-15; historical. AGENTS.md is current."
3. **Update `docs/browser-automation-gateway.md`** — predates replay/traces/heal entirely.
4. **Delete tracked cruft:** `BrowserGateway/admin-console-mockup.html`,
   `BrowserGateway/architecture-explorer.html` (superseded v1), `general-architecture-review.docx`
   (Review 1.0), `src/.gitkeep`, `test/.gitkeep`. Consider archiving all `BrowserGateway/` +
   `docs/superpowers/` to `docs/archive/`.
5. **Small:** add `scripts/` to AGENTS.md file map; fix `secrets.ts:14-18` docstring; fix
   README client example (`lgcyco` → `spartan`); remove unused `pino-pretty` dep.
6. **Structural (Andy's call):** the entire v2 is on unmerged `feat/gateway-v2`; `main` is
   only the v1 prototype. And **there is no deployment target in-repo** (no Railway config) —
   "LIVE" means whatever local Postgres last ran. Deploying as its own Railway service is a
   net-new step (see the consumer spec's topology section).

## 6. Next steps (sequenced)

1. **Resolve the §0 fork** — one manual portal look (do stips/credit render?), then Andy
   picks Option A (DOM) or B (HTTP action class).
2. **Lock the extract schema** for `lightreach.accountSnapshot` per the chosen option.
3. **Build + validate** the new action(s): catalogue entry, walk validate → record-test →
   enable for the `spartan` client.
4. **Consumer side** (job-automation): gateway HTTP client + create-poll/refresh worker
   doing the merge-write Asana updates (spec v1.2 rules).
5. **Deploy** the gateway as its own Railway service (private, own Postgres); wire the
   consumer with a scoped `bgw_` token.
6. **Declutter** per §5 as its own reviewed pass.

Investigation provenance: gw-shell (Fastify/API/queue/DB), gw-core (agent core + replay),
gw-lightreach (the action + extension design), gw-declutter (hygiene + drift). All read-only,
Fable, against HEAD `a651030` on feat/gateway-v2.
