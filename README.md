# Prospect Room

A shared room where **two humans and one agent prospect together**. The agent searches Apollo for ~10 people
matching an ICP, then for each person: **enrich → draft a 2-line outreach note → wait for a human** to approve,
edit, or skip. Either human can claim a task, hand it back to the agent, or pause the whole room. Every piece of
state, every ownership change and every action lives in Postgres.

The agent also opens one prospect's LinkedIn profile in a **real Chrome via Playwright** and pulls their headline
(it feeds that prospect's draft).

| Requirement | Where it's enforced | Proof |
|---|---|---|
| Kill mid-run → restart resumes, nothing enriched/drafted twice | Postgres job queue with leases + fenced commits, idempotency keys, unique constraints, call ledger | `npm run test:crash` |
| Two humans on the same task can't both win | Row lock + version check in one transaction; pause serialized via room lock | `npm run test:race` |
| Apollo rate limits / failures don't lose the run | Shared provider block from `retry-after`, local request budget, backoff, dead-letter + human retry | `npm run test:ratelimit` |
| Playwright pulls one LinkedIn headline | `src/agent/linkedin.ts`, one lookup per room (unique index) | `npm run test:linkedin`, `npm run linkedin:check -- <url>` |

## Quick start

Prerequisites: Node 22+, Docker (or a local PostgreSQL), Google Chrome (for the LinkedIn step), and an Apollo API key.

**The Apollo key.** Create it in Apollo under *Settings → Integrations → API keys*. Either tick "set as master
key", or scope the key to the two endpoints this app calls: `api/v1/mixed_people/api_search` and
`api/v1/people/match` — a key without those scopes returns `403`. The free plan works and needs an account
registered with a work email address. Costs: **search 0 credits**, **enrichment 1 credit** when Apollo finds
data (0 when it doesn't). Phone numbers cost 8 credits, so this app never asks for them
(`reveal_phone_number=false`, which also avoids Apollo's webhook requirement). Free-plan rate limits are
50/minute, 200/hour and 600/day, counted per team and per endpoint; the defaults in `.env.example` sit just
under them.

Check the key before starting the agent:

```bash
npm run apollo:check              # People Search only — 0 credits. Prints the live rate-limit headers.
npm run apollo:check -- --enrich  # also verifies people/match (costs 1 credit)
```

**First run with a real key**, in order:

1. `npm run apollo:check` — proves the key and the search scope, and costs nothing. A `403` here means the
   key's scope or the plan doesn't cover the endpoint; a `401` means the key itself is wrong or inactive.
2. `npm run apollo:check -- --enrich` — the only way to prove the `people/match` scope, since scopes are
   granted per endpoint. Costs 1 credit.
3. `npm start`, then create a room from a preset. With `targetCount: 10` that is 1 search call (0 credits)
   and up to 10 enrichments (1 credit each).
4. Watch the room header: it shows live Apollo quota from the response headers, and any rate-limit block.

```bash
npm install
cp .env.example .env          # add APOLLO_API_KEY (and ANTHROPIC_API_KEY for Claude-written drafts)
npm run db:up                 # Postgres 18 on localhost:5433 via docker compose
                              # (Windows without Docker, using an installed PostgreSQL: npm run db:local)
npm start                     # migrates, then serves http://localhost:3000 and runs the agent
```

Open **http://localhost:3000**, create a room from a preset (or your own ICP), then open the room in two windows:
`…?room=<id>&as=alice` and `…?room=<id>&as=bob`. Each window is one human.

**No Apollo key?** Run the bundled fake Apollo (same wire format, optional fault injection):

```bash
npm run fake-apollo                                   # prints FAKE_APOLLO_READY http://127.0.0.1:4010/api/v1
APOLLO_BASE_URL=http://127.0.0.1:4010/api/v1 APOLLO_API_KEY=fake-key npm start
# add FAKE_APOLLO_429_RATE=0.3 FAKE_APOLLO_500_RATE=0.1 to the fake to watch the agent ride out failures
```

The fake's people are fictional. Set `LINKEDIN_URL_OVERRIDE=https://www.linkedin.com/in/<a public profile>/` to
point the one LinkedIn lookup at a real profile.

**From the terminal** (the same actions as the UI, straight against the domain layer — no server needed):

```bash
npm run cli -- presets
npm run cli -- create --preset saas-revenue-leaders      # prints the room id
npm run cli -- status <roomId>                            # tasks, Apollo status, dead job ids
npm run cli -- claim <roomId>#1 --as alice                # tasks can be addressed as <roomId>#<position>
npm run cli -- approve <roomId>#1 --as alice --text "Your two-line note"
npm run cli -- handback <roomId>#2 --as bob --note "Mention their hiring push"
npm run cli -- pause <roomId> --as bob
npm run cli -- events <roomId> --follow
```

**Drafts:** with `ANTHROPIC_API_KEY` set, notes are written by Claude (`claude-opus-5`, structured output, server-side
refusal fallback). Without it, a deterministic template is used, so the whole flow runs offline.

**LinkedIn:** guest access to public profiles works intermittently (LinkedIn serves an auth wall to some automated
traffic). Auth walls are retried, then recorded as `authwall` with a screenshot. For reliable headlines, save a
session once with `npm run linkedin:login` (opens Chrome, you log in, the session is stored in
`.linkedin-state.json`).

## Demo: the three must-haves by hand

1. **Crash and resume.** Start a room, and while prospects are being enriched, hard-kill the process
   (`kill -9 <pid>`, or `taskkill /F /PID <pid>` on Windows; Ctrl+C is a graceful stop). Run `npm start` again. The
   activity feed shows `job reclaimed`, and work continues from where it stopped. The run completes with one
   enrichment and one draft per prospect.
2. **Race.** In the alice and bob windows, click **Claim** on the same task at the same moment: one wins, the other
   gets "Already claimed by …". The rejected attempt is in the activity feed too (`action.rejected`).
3. **Rate limits.** Run the fake with `FAKE_APOLLO_429_RATE=0.4`. The header shows "Apollo blocked until …", jobs
   show "deferred", and the run still completes.

## How it works

One Node process serves the HTTP API/UI and runs the agent worker. Postgres is the only source of truth, so the
process can be killed at any instant. Full detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

- **Tasks.** Each prospect row is a task with `stage` (`new → enriched → awaiting_review → approved | skipped`),
  `owner_member_id` (the agent by default; a human after a claim) and a `version`.
- **Queue.** A `jobs` table (search / enrich / draft / linkedin) claimed with `FOR UPDATE SKIP LOCKED` and a lease.
  The worker only takes jobs for active rooms and agent-owned prospects, so a claim or a pause stops the agent
  immediately.
- **No double work.** Every job has a unique idempotency key. Before calling out, a handler checks whether the
  result already exists. The result, stage change, next job and job completion commit in one transaction that
  first proves the worker still holds the lease. `enrichments(prospect_id)` and `drafts(prospect_id, revision)` are
  unique as a final backstop.
- **In-doubt calls.** Every outbound call is recorded in `external_calls` *before* it is made. If a process dies
  after sending a request but before committing the result, the next attempt marks that call `in_doubt` and says so
  in the activity feed. That window is the only way Apollo can see the same enrichment twice. It can't be closed
  without provider-side idempotency keys, but it is always visible (and the crash test measures it).
- **Restart speed.** A restarted worker marks rows for dead PIDs on the same host as stopped and reclaims their
  jobs immediately instead of waiting out the lease.
- **Humans.** Actions lock the task row, check stage/owner/`expectedVersion`, and write in the same transaction.
  The loser of a race gets a precise `409` ("Already claimed by bob", "changed since you loaded it"). Actions take a
  shared lock on the room row; pause takes an exclusive one, so an approval can never land after a pause.
- **Rate limits.** A `429` blocks the provider for all workers until `retry-after` (stored in `provider_limits`, so
  it survives restarts). A local budget (45/min, 190/h, 580/day by default, under the free plan's 50/200/600) defers
  work before Apollo has to refuse it. `5xx`/timeouts back off exponentially. Permanent errors dead-letter that one
  job; humans can retry it, and the rest of the room keeps going.
- **Live UI.** Every state change appends to `events`. A trigger issues `NOTIFY`, and the server fans that out over
  SSE. Browsers refetch a consistent snapshot, so the UI never has to trust notification delivery.

## Tests

The tests need the Postgres from `npm run db:up` / `db:local`. They use the `prospect_room_test` database and the
in-repo fake Apollo, so no keys are needed.

```bash
npm test                 # typecheck + all suites
npm run test:queue       # job claiming: concurrent workers, live leases, reclaim from a dead worker
npm run test:race        # concurrent human actions: exactly one winner, verified in the DB
npm run test:ratelimit   # scripted 429/500/timeouts, local budget, dead-letter isolation + human retry
npm run test:crash       # repeatedly SIGKILLs the app mid-run, restarts, asserts no duplicate enrich/draft
npm run test:linkedin    # real headless Chrome against local LinkedIn fixtures
```

A full run is 25 tests across the five suites (~80s). What the last run measured:

- **crash:** 8 SIGKILLs, all landing while jobs were running; 18 orphaned jobs, 18 reclaimed; 10 enrichments and
  10 revision-1 drafts, one `enrich.completed` and one `draft.created` per prospect; every repeated provider
  call accounted for by an `in_doubt` ledger row; restarts resumed in tens of milliseconds against a 30s lease.
- **race:** 40 concurrent rounds per scenario, with winners splitting both ways every time (so no scenario
  passes vacuously), including a stale-`expectedVersion` case that the same call with a current version passes.
- **rate-limit:** 24 Apollo requests through 7 injected 429s, 5 500s and a timeout, zero dead jobs, and no
  request sent inside an open `retry-after` window — checked against both the fake's ledger and the app's own
  call records.

## Project layout

```
db/migrations/001_init.sql   schema + invariants (unique keys, checks, NOTIFY trigger)
src/main.ts                  process entry: migrate, HTTP server, worker, graceful shutdown
src/domain/                  human actions (actions.ts), room snapshot, events, presets, types
src/queue/                   job queue (claim/lease/fencing), worker loop, error taxonomy
src/agent/                   Apollo client, call ledger + rate budget, drafter, job handlers, LinkedIn (Playwright)
src/server/                  HTTP API, SSE, static web UI
src/cli.ts                   the same actions from a terminal
test/                        fake Apollo, race / rate-limit / crash / LinkedIn suites
```

## Known limitations

These are deliberate, not oversights:

- **The in-doubt window.** If the process dies after a request reaches Apollo but before the result commits —
  or a request times out after Apollo processed it — that one call can be repeated. Apollo has no idempotency
  keys, so this cannot be closed from the client side. It is recorded (`external_calls.status = 'in_doubt'`,
  `enrich.in_doubt_retry` events) and the crash test reports how often it happened.
- **LinkedIn blocks guests intermittently.** The same public profile can return a headline on one attempt and
  an auth wall on the next. Auth walls are retried, then recorded with a screenshot. A saved login
  (`npm run linkedin:login`) makes it reliable. Check LinkedIn's terms before using this in production.
- **No authentication.** The actor is a handle in the request, per the brief. Anyone with the URL can act as
  either human.
- **Claims never expire.** If someone claims a task and walks away, another human must hand it back.
- **Single process by default.** Multiple workers are safe (that is what the leases and fencing are for), but
  there is no supervisor or autoscaling here.
- **The local Apollo budget approximates Apollo's own windows.** It is a courtesy limiter; the `429` handler
  is the real backstop.
- **Rate-limit state is per provider, not per endpoint.** Apollo counts limits per team *and per endpoint*,
  while this app keeps one shared budget and one shared block for Apollo. That errs on the safe side — it
  never over-calls — but an exhausted window on search also holds back enrichment for a while. Per-endpoint
  counters (keyed on `provider_limits(provider, operation)`) are the production refinement.

## What I'd change for production

**Identity & access.** Real authentication (SSO) and per-room roles; take the actor from the session, not the
request body. Claims should expire, so an abandoned claim returns to the agent.

**Durable execution.** The Postgres queue is deliberately simple and correct. At scale I would either adopt a
workflow engine (Temporal) with activities keyed by the same idempotency keys, or harden the queue: separate worker
deployments from the web tier, fair scheduling across rooms/tenants, partitioned `jobs`/`events` with retention,
and alerts on queue age, dead letters and in-doubt calls.

**Closing the in-doubt window.** Apollo has no idempotency keys. Before re-enriching an in-doubt person, check
whether Apollo already saved them as a contact (a zero-credit lookup) and reuse that. Or move enrichment to Apollo's
bulk/webhook flow and reconcile by request id.

**Rate limits & cost.** Budget Apollo *credits* per room and tenant (not just requests), with approval gates.
Share the limiter across services and adapt it from Apollo's `x-*-requests-left` headers.

**LinkedIn.** Get a legal/ToS review before any production use. Prefer licensed data: Apollo already returns a
`headline`. If browsing stays, run browsers in an isolated pool (e.g. containerized Playwright), use a small number
of health-checked sessions with strict per-session caps, and never crawl.

**Drafting quality.** Version the prompts and store the version on each draft. Keep an eval set built from
human-approved and human-edited notes, feed edits back, and add claim/fact checks against enrichment data. Track
cost per draft.

**Data & compliance.** Minimise stored vendor payloads, encrypt PII, set retention and deletion (GDPR/CCPA), make
the audit log append-only at the permission level, and keep secrets in a manager.

**Operations.** Structured logs and OpenTelemetry traces per job; CI running the crash and race suites against real
Postgres; a real migration tool; a load test of concurrent rooms. For the UI, a proper frontend with presence
("bob is looking at #3") and optimistic updates. Sending should go through an outbox with idempotency keys to the
ESP.
#   w o r k f l o w - r o o m  
 