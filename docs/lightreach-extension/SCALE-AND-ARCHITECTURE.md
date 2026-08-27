# LightReach Extension — Scale & Architecture (sketch, 2026-08-27)

Design sketch for the SpartanX LightReach integration at scale. Follows the
investigation (`INVESTIGATION-2026-08-27.md`) and a scale discussion with Andy.
Decisions marked **[decided]**; open items marked **[open]**. This is a sketch —
it captures direction and open questions, not final interfaces.

Guiding constraint, stated first because it shapes everything: **be an extremely
light, polite guest on Palmetto's systems.** Minimize requests, minimize logins,
back off instantly, never hammer. Our footprint should be near-invisible.

---

## 1. Execution model — a pure-code action class (no Stagehand for LightReach) [decided]

The gateway has one execution model today: LLM discovers a flow (Stagehand),
saves a trace, replays it deterministically. That's for portals whose flow is
*unknown*. **LightReach's flow is fully known** (recon mapped the exact API), so
it needs neither discovery nor the LLM.

**Three layers, separated:**
- **Stagehand / LLM — dropped for LightReach.** No learn/replay/heal. The flow
  is hand-written code.
- **Browserbase (real browser) — kept, for the login step only.** auth.palmetto.com
  is Auth0 with JS/anti-bot; a real browser clears it reliably. The login is
  scripted with plain Playwright (`page.fill`/`keyboard`), NOT Stagehand.
- **Pure HTTP — for all data reads.** Once logged in, the session cookies drive
  plain JSON GETs (sub-second). No browser, no LLM.

**Proof this works:** the phase-0 recon already ran exactly this — `playwright-core`
`connectOverCDP` to a Browserbase session, `page.fill` login, then
`context.request.get(...)` for the JSON endpoints. Zero Stagehand, zero LLM.

This introduces a **second action class** in the gateway alongside the LLM/replay
class: a "code action" whose handler is a hand-written function. Any future portal
that has an API behind its UI gets this fast, deterministic path.

**[open] Can login itself go pure-HTTP (drop Browserbase too)?** Auth0 sometimes
allows a Resource-Owner-Password-Grant or a scripted token exchange with no
browser. If it works for Palmetto, Browserbase falls away for LightReach entirely.
Worth exactly one test. Until then: **Browserbase stays for login** (Andy's call),
because a real browser login is the robust default.

## 2. Batch action — one login, N reads [decided]

The gateway's job model is one-job-one-login-one-record, and per-credential
serialization runs same-client jobs strictly sequentially. A 50-record refresh as
50 jobs = 50 logins run one-at-a-time ≈ 25 min. Unacceptable and impolite to
Palmetto (50 logins to read 50 records).

**Design:** a batch code-action — one job logs in once, then loops N account-ids
through sub-second reads, returns N per-record results. Same 50 records ≈ one
login + 50 sub-second reads ≈ under a minute, one job, one login. This is the
review's unbuilt "batch jobs (one login, N lookups)" backlog item; the code-action
model makes it natural.

- **Creation path:** one job per create *run* (all that run's new LightReach jobs
  in one batch). Non-blocking — creation never waits.
- **Refresh path:** one batch job per sweep tier per run, over the due pool.

## 3. Session / context reuse [decided — design it in]

Even with batching, each *run* re-logs-in. Browserbase **Contexts** persist cookies
across sessions; the review lists a "Contexts fast path" as backlog. Target: keep a
**warm authenticated session per client**, so most runs skip login entirely and go
straight to reads. Re-auth only on cookie expiry (self-heal).

**[open]** Cookie/session lifetime on Palmetto — recon did not measure it. Needed to
size the warm-session TTL. Also: does one warm session safely serve both the
creation batch and the refresh batch (they'd share the client)? Per-credential
serialization already prevents them running at once, so likely yes.

## 4. Politeness to Palmetto — first-class, not an afterthought [decided]

Compounding measures so our footprint is minimal:
- **Batch** — collapse N reads into one login.
- **Session reuse** — collapse N logins into ~one per TTL.
- **Conservative rate limit** — a low ceiling on reads/minute with backoff + jitter,
  well under anything that looks abusive. Tune from observed behavior, start low.
- **Instant 429/anti-bot respect** — on any throttle signal, back off exponentially
  and stop the batch; never retry into a wall.
- **Global request budget** — a hard cap on portal requests per hour, so a runaway
  loop can't hammer them.
- **Off-peak bias** — schedule heavy refresh sweeps when Ops isn't in the portal
  (also avoids any session contention).

**[open]** Palmetto's actual limits / ToS position on automated access — we don't
know them. Until we do, err far on the side of caution.

## 5. Partial-batch failure semantics [decided]

One bad record must not fail the other 49. The current envelope is per-job; a batch
needs **per-record status**. Sketch: the batch returns `{results: [{accountId,
status, data|error}]}`, each record independently success/failure/error. The job as
a whole succeeds if it ran; per-record outcomes drive the consumer's snapshot writes.

## 6. Idempotency & dedup [open — questions for Andy]

The gateway has idempotency keys; we must define what "the same request" means.
Open questions (answers shape the key design):
1. **Creation re-read:** on a create-poll retry/restart for the same job — re-read
   the portal (fresh) or return the cached first result?
2. **Refresh dedup window:** what stops two sweeps double-reading a record in one
   cycle — the sweep interval, or a fixed time bucket (what size)?
3. **Forced fresh read:** do we want an Ops "refresh now" that bypasses idempotency?
4. **Dedup meaning for the consumer:** when the gateway returns a deduped job, does
   the consumer treat it as "no new data" (no snapshot row, no Asana write)?
5. **Cross-path timing:** if creation just read a record, and a refresh sweep fires
   an hour later — re-read or skip? Relationship between create-read and refresh-read.

## 7. Drift detection [decided]

Option B trades DOM fragility for JSON-shape fragility: if Palmetto changes an
endpoint, reads break silently. The gateway's canary mechanism exists but is inert
by default. **Enable a canary** on the LightReach code-action (a known account,
expected shape) to catch API drift early.

## 8. Observability & security [decided]

- Per-request tracing + session-replay URLs already exist.
- **Redaction hole (from the investigation):** extracted `data` is customer PII with
  no redact path — **never `log.info({envelope})`; add every new PII field to
  `REDACT_PATHS` in lockstep.**
- Alert on failure-rate and on canary drift.

## 9. Multi-tenant future [decided — noted]

Scoped `bgw_` tokens handle auth for other JobEngine apps calling the gateway. But
per-credential serialization means apps sharing a client contend; capacity planning
becomes cross-app. Not a launch concern; flagged for when a second consumer appears.

## 10. Railway topology [decided]

Deploy the gateway as **its own service in the `job-intake-automation` project**,
with **its own Postgres**, **no public domain** (private networking only). The
consumer calls it over `railway.internal` with a scoped token.
- **Benefits:** private networking (gateway holds credentials — keep it off the
  public internet), simple ops, negligible latency, no egress cost.
- **Drawbacks:** shared blast radius / resource contention (browser automation is
  heavier and spikier than the intake API); another Postgres in the project.
- **Rationale:** benefits win at this volume; it's a separate repo, so promoting it
  to its own project later is low-friction if it gets heavy.

## 11. Cost model [decided — to project]

Under the code-action model, LLM cost is ~zero (JSON reads need no LLM; only a
future fallback would). Dominant cost is Browserbase minutes per login; batching +
session reuse collapse login count. **[open]** project: records × frequency →
logins/day → Browserbase minutes → plan sizing.

---

## Near-term calibration

The refresh pool is **post-08-26 jobs only — it starts empty and grows slowly.** So
near-term volume is tens of records: the sequential-login pain is deferred, and we
can ship a simple per-record shape first *as long as the action interface is
batch-capable from day one* so we don't rebuild it. Design for scale; ship simple.

## Open items summary (need Andy)
- §1 pure-HTTP login test (drop Browserbase?) — one test.
- §3 cookie/session lifetime — measure.
- §4 Palmetto rate limits / ToS — determine; err cautious.
- §6 idempotency — five questions above.
- §11 volume projection for cost.
