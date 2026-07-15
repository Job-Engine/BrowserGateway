# Deterministic replay with learned traces

Date: 2026-07-14
Status: implemented 2026-07-15
Owner: gateway v2

## Problem and goal

Every gateway run today drives the browser with an LLM loop: two Sonnet calls
per step (plan, observe) plus a final extract, each carrying page context. A
clean LightReach run costs roughly $0.40 to $0.80 in tokens; a pathological run
(the 16-step scroll hunt on 2026-07-14) cost several dollars alone. The gateway
is meant to run thousands of jobs per day, which puts the current path at
$800+ per day. The goal: zero LLM calls on the recurring path. The model runs
only when a portal is first learned and when a portal changes (heal). Learned
knowledge persists on our side, in Postgres, per catalogue action.

## Non-goals

- No write actions, no new caller-facing API surface beyond additive envelope
  metadata.
- No change to envelope semantics, extract schemas, or the JIT credential
  model.
- Catalogue authoring via Claude/MCP is a separate backlog item (see the
  planning repo, Backlog section), not part of this feature.
- Reducing Browserbase browser-minute cost is out of scope; this feature
  removes token cost only.

## Reopened decision (recorded, not drift)

The v2 "core freeze" (only four sanctioned agent-core changes) is consciously
reopened for this feature as a fifth sanctioned change, justified by unit
economics at thousands of runs per day. Scope of the reopening:

1. The browser adapter (`src/browser.ts`) gains one read-only primitive,
   `readText(selector)`, plus its `BrowserAgent` interface entry.
2. A new sibling module `src/replay.ts` is added beside `loop.ts`. `loop.ts`,
   `planner.ts`, and `index.ts` are otherwise untouched.

`CLAUDE.md` and `AGENTS.md` are updated in the same PR.

## Architecture

Three paths, chosen by the gateway runner per job:

1. Replay (hot path, default once a trace exists): goto, execute each stored
   step via `agent.act({selector, method, arguments}, variables)` (no
   inference; Stagehand executes resolved actions directly), read result
   fields via stored read selectors with `readText`, verify the record match
   in code, return success. Zero LLM calls.
2. Learn (first run per useCase and client, or on demand): the existing
   Sonnet `runLoop` answers the job. On success the runner records a trace
   from the run's `actionsLog` plus one `observe()` call per extract field to
   ground read selectors, then stores it.
3. Heal (replay anomaly): any replay failure (navigation error, act failure,
   missing read selector, verification mismatch) falls through to the learn
   path within the same job when the wall-clock budget allows, re-records the
   trace, retires the old version, and flags the heal in the audit log.

The mechanism is generic: every current and future catalogue entry gets memory
automatically. Nothing is hand-written per portal.

## Data model

New table `action_traces`:

| column               | type        | notes                                           |
| -------------------- | ----------- | ----------------------------------------------- |
| id                   | uuid pk     |                                                 |
| use_case             | text        | with client, the lookup key                     |
| client               | text        | traces are per skin; skins differ               |
| version              | int         | monotonically increasing per key                |
| state                | text        | `active`, `retired`; at most one active per key |
| steps                | jsonb       | ordered array, see shape below                  |
| read_selectors       | jsonb       | extract field name to selector                  |
| recorded_from_job_id | uuid        | provenance                                      |
| heal_count           | int         | lifetime heals for this key                     |
| last_success_at      | timestamptz | updated on each successful replay               |
| created_at           | timestamptz |                                                 |

Step shape (derived from `ActionRecord.action`):

```json
{
  "selector": "xpath=...",
  "method": "fill",
  "arguments": ["%username%"],
  "description": "redacted description",
  "paramTemplate": null
}
```

`paramTemplate` is set on input-dependent steps (see Parameterization). Old
versions are retired, never deleted, for debugging and rollback.

## Recording

Runs on the learn path after a successful `runLoop`:

1. Take the executed steps from `actionsLog` (skip failed and re-planned
   steps).
2. Ground read selectors: for each DOM-read field in the action's extract
   schema, one `observe()` call ("the element displaying <field description>
   on this record") and store the returned selector. Derived boolean fields
   (for LightReach: `matchVerified`, `ntpDateFound`) are not grounded; replay
   computes them in code from the reads. If grounding fails for a field the
   schema requires, the trace is stored `retired` and not activated (a trace
   that escalates on every replay is worse than none); the next learn run
   retries grounding.
3. Parameterize input-dependent steps (below).
4. Secret scrub: reject the trace if any step or selector contains a literal
   credential value. Arguments must reference credentials only as
   `%placeholder%` tokens (they already do; this check makes it an invariant).
5. Insert as `active`, retiring the previous version.

Recording failures never fail the job: the job already has its answer from the
learn run; the trace is best-effort and can be recorded on the next learn run.

## Parameterization of input-dependent steps

A recorded step may embed an input value literally (the planner writes what it
sees, e.g. click the "Jason Marshall" link). At record time, any step whose
description, arguments, or selector contains a current input value gets a
`paramTemplate`: the literal value is replaced with its `%inputKey%` token.
Matching is whole-token and case-insensitive, so short values (a two-digit
`projectId`) cannot false-positive inside unrelated selectors. At replay time
the template is resolved with the current job's input and executed as a
text-based locator (Playwright `getByText`/`getByRole` style, first match).
Credentials never appear literally, so this applies to input fields (`name`,
`address`, `projectId`) only.

## Replay execution (`src/replay.ts`)

- Uses only `BrowserAgent` primitives: `goto`, `act`, `readText`, `close`.
  No planner, no observe, no extract.
- Read-only enforcement is preserved: each stored step's method is checked
  against the same `allowedMethods` allowlist before acting, fail closed. A
  stored trace cannot execute a method the LLM path could not.
- Credentials are resolved JIT exactly as today and passed as variables to
  `act`; the trust boundary is unchanged.
- Per-step timeout and the run wall-clock budget apply as in the LLM loop.

## Verification and escalation policy

After replaying the navigation steps, the replay path reads the record's
identity fields (for LightReach: customer name, service address) and the data
fields (NTP date) via read selectors, then verifies in code:

- Name and address fuzzy match against the input: normalized casing,
  punctuation, common abbreviation pairs (St/Street, Ave/Avenue, NE/Northeast,
  Ct/Court, unit spacing). Conservative thresholds.
- Data fields are returned exactly as read (the envelope contract already
  promises "exactly as shown").

Policy: the deterministic path returns only `success` with verified data, or
escalates internally to the learn path. It never emits `failure` on its own,
because a code-side mismatch cannot distinguish "portal changed" from
"customer not found". Only an LLM-verified run issues the clean business
negative. This trades a rare extra Sonnet run for never returning the wrong
customer's data and never issuing a false negative.

Envelope changes are additive only: `meta.mode: "replay" | "learned" |
"healed"`, and `meta.traceVersion` on replay/healed runs.

## Model configuration

- Learn and heal paths stay on the existing default
  `anthropic/claude-sonnet-4-6`. No hot-path model exists to downgrade.
- No Haiku usage in this feature (the deterministic option removed the
  hot-path extract call).

## Ops and admin

- Admin API and console: per action and client, show active trace version,
  age, heal count, last success; a manual invalidate action (retire the active
  trace, forcing a learn run on the next job).
- Heals write an audit log entry.
- Optional follow-up (not in this build): canaries execute replay traces on
  schedule so portal drift is caught before caller jobs hit it.

## Code touch points

| where                            | change                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `src/browser.ts`, `src/types.ts` | add `readText(selector)` to the adapter and `BrowserAgent` (sanctioned change 5) |
| `src/replay.ts`                  | new: deterministic executor, parameter resolution, fuzzy matcher, verification   |
| `src/gateway/runner.ts`          | trace lookup, path selection, record-on-learn, heal-on-replay-failure            |
| `src/gateway/traces.ts`          | new: `action_traces` store (CRUD, versioning, secret scrub)                      |
| `src/gateway/db.ts`              | migration for `action_traces`                                                    |
| `src/gateway/api/admin.ts`       | trace visibility + invalidate endpoints; OpenAPI updated                         |
| `admin-web/`                     | trace panel on the action detail view                                            |
| `AGENTS.md`, `CLAUDE.md`         | record sanctioned change 5 and the new module map                                |

## Testing and acceptance

- Unit: parameterization (literal to template and back), fuzzy matcher
  (positive, negative, abbreviation cases), secret scrub, allowlist
  enforcement on stored steps.
- Integration (fake `BrowserAgent`): record from a simulated learn run, replay
  hit, replay failure escalating to learn, heal re-record, verification
  mismatch escalating.
- Coverage: the 80 percent gate on `src/gateway` continues to apply; `replay.ts`
  is held to the same bar.
- Live acceptance (needs credentials): one learn run on lightreach.ntpDate
  spartan records a trace; the next run replays with zero LLM calls (assert
  via cost/step accounting) and returns the same envelope data; manually
  invalidating the trace forces a learn run.

## Cost expectation

At about 2,000 runs per day steady state: token cost approximately zero
(heals only), versus $800 to $1,600 per day on the current path. Browserbase
browser-minutes become the dominant per-run cost and are unchanged by this
feature.
