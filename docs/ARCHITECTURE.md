# Architecture & module contracts

One Node process (`npm start`) runs the HTTP server + web UI **and** the agent worker. Postgres is the only
source of truth: room state, ownership, the work queue, the external-call ledger and the audit log. The
process holds nothing that isn't recoverable from the database, so it can be killed at any instant.

```
 browser (alice) ─┐                     ┌─────────────── Postgres ───────────────┐
 browser (bob)   ─┼─ HTTP/SSE ─ server ─┤ rooms, members, prospects (tasks)       │
 CLI             ─┘      │              │ jobs (queue, leases), workers           │
                         │ LISTEN       │ external_calls (ledger), provider_limits│
                         └──────────────┤ enrichments, drafts, linkedin_lookups   │
 worker ─ claim (SKIP LOCKED) ─────────►│ events (append-only, NOTIFY on insert)  │
   ├─ Apollo  (search, people/match)    └─────────────────────────────────────────┘
   ├─ Claude  (draft) / template
   └─ Playwright → real Chrome → LinkedIn (one prospect per room)
```

## The task lifecycle

A **prospect** row is the task. `stage` records progress only; health lives on `jobs`.

```
new ──enrich job──► enriched ──draft job──► awaiting_review ──approve/edit──► approved
                        ▲                         │         └────skip───────► skipped
                        └── hand back w/ note ────┘   (draft_revision += 1, new draft job)
```

* `owner_member_id` is the room's agent member by default. A human **claim** sets it to the human.
* The worker only claims a prospect's jobs while the **agent** owns the prospect and the room is `active`.
* **Hand back** returns ownership to the agent. From `awaiting_review` with a note it also bumps
  `draft_revision`, moves the stage back to `enriched`, and enqueues `draft:<prospect>:<revision>`.
  Without a note it simply releases the claim.
* **Approve** (optionally with edited text) and **skip** are allowed for the owner, or for anyone on an
  unclaimed `awaiting_review` prospect (claim + decide atomically). A human owner may approve with their own
  text at any non-terminal stage. Deciding cancels the prospect's *pending* jobs.
* **Pause** freezes the whole room: the worker stops claiming its jobs and every task mutation returns
  `room_paused`. A job already mid-flight finishes and commits (its external call already cost money).

## Concurrency rules (why two humans can't both win)

Every task mutation is a single conditional `UPDATE … WHERE id = $1 AND version = $expected AND <precondition>`
followed by `version = version + 1`. Postgres row locks + READ COMMITTED re-evaluation mean the second
concurrent writer sees the new version and matches zero rows → `conflict`. Human mutations first take
`SELECT … FROM rooms WHERE id = $room FOR SHARE`, which serializes them against pause/resume
(`UPDATE rooms …` needs a conflicting lock). Rejected attempts are written to `events` as `action.rejected`.
Lock order is always rooms → prospects → jobs; the worker never locks `rooms`.

## Exactly-once-effective work (why nothing is enriched or drafted twice)

1. **Queue:** `jobs.idempotency_key` is unique (`search:<room>:p<page>`, `enrich:<prospect>`,
   `draft:<prospect>:<rev>`, `linkedin:<room>:<prospect>`, with a partial unique index keeping one live
   LinkedIn lookup per room). Enqueue is `INSERT … ON CONFLICT DO NOTHING`, always in the same transaction as
   the state change that makes the job necessary.
2. **Claim:** `FOR UPDATE SKIP LOCKED`, sets `locked_by = <worker id>` and a lease. A `running` job is
   reclaimable when its lease expired, or its worker row is stale/stopped. On startup a worker marks rows for
   dead PIDs on the same host as stopped, so a restart resumes immediately instead of waiting out the lease.
   Worker liveness is a correlated subquery and the final `UPDATE` re-asserts the status and holder the
   candidate saw: under READ COMMITTED a *joined* `workers` row is re-checked from the old snapshot, which
   made a live worker's freshly leased job look abandoned to a second worker (see `test/queue.test.ts`).
3. **Result short-circuit:** before calling out, a handler checks whether the result already exists
   (`enrichments` row / `drafts(prospect, revision)` row). If it does, it only finishes bookkeeping.
4. **Ledger:** the handler commits an `external_calls` row (`started`) *before* the HTTP call. If a later
   attempt finds `started` rows for the same `logical_key`, the previous attempt ended without learning the
   outcome — the process died mid-call, or the request timed out after Apollo may already have processed it.
   Those rows are marked `in_doubt` and an `enrich.in_doubt_retry` event is emitted. This is the only case
   where a provider can see the same logical call twice (unavoidable without provider-side idempotency keys)
   and it is always visible in the ledger.
5. **Fenced commit:** the result, the stage transition, the next job, the ledger update and job completion
   commit in ONE transaction that first does
   `UPDATE jobs SET status='succeeded' WHERE id=$1 AND locked_by=$me AND status='running'`. If that matches
   zero rows (lease lost), the transaction rolls back. Unique constraints on `enrichments` / `drafts` are the
   final backstop.

## Rate limits & failures

* **Local budget:** before each Apollo call the worker counts ledger rows in the last minute/hour/day under a
  transaction-scoped advisory lock (so concurrent workers can't both take the last slot). Over budget →
  the job is deferred (`deferrals += 1`, not a failure) until the window frees up.
* **429:** `retry-after` (seconds; default 60) is written to `provider_limits.blocked_until`, shared by all
  workers and restarts. The job is deferred to that time. Event `job.rate_limited`.
* **5xx / network / timeout:** exponential backoff with full jitter (`JOB_BACKOFF_BASE_MS * 2^attempt`,
  capped), up to `JOB_MAX_ATTEMPTS`. Event `job.retry_scheduled`.
* **Permanent (400/401/403/404/422) or attempts exhausted:** job `dead`, `prospects.last_error` set,
  event `job.dead`. Humans can **retry** a dead job from the UI (`job.retried_by_human`). The run is never
  lost; other prospects keep flowing.
* **Poison jobs:** a job claimed more than `JOB_MAX_CLAIMS` times (crash loop) goes `dead`.

## Apollo conformance (checked against docs.apollo.io, before any live call)

The client was written from, and then cross-checked against, Apollo's live documentation, because the first
run with a real key had to work rather than be debugged:

* **Transport.** `POST /mixed_people/api_search` and `POST /people/match`, parameters in the **query string**
  on a body-less POST with `x-api-key` — exactly the shape of Apollo's documented curl examples. Arrays are
  repeated `person_titles[]=…`; booleans serialize as `true`/`false`.
* **Search.** 0 credits. `per_page` ≤ 100 within a 50,000-record / 500-page display limit. The response is
  `{total_entries, people[]}` with obfuscated last names and no contact data — enrichment is a separate call.
* **Enrichment.** By Apollo person `id`, which is what search returns. 1 credit only when Apollo finds
  credit-consuming data. `reveal_phone_number=false` keeps the 8-credit mobile charge and Apollo's
  `webhook_url` requirement out of play. A miss is HTTP 200: `person: null` on a standard request, or
  `match_confidence: "none"` under waterfall enrichment (never enabled here) — both are treated as "no match",
  dead-lettered rather than stored as an enrichment.
* **Status codes.** 429 → block the provider for everyone until `retry-after` (seconds); 5xx/408/425 →
  exponential backoff; 401/403/404/422 → dead-letter immediately with an actionable message, since 403 is
  Apollo's `API_INACCESSIBLE` (plan or key scope) and retrying cannot fix it.
* **Quota.** Free plan is 50/minute, 200/hour, 600/day, counted per team **and per endpoint**. The local
  budget (45/190/580) is shared across endpoints, so it is conservative by construction.

`npm run apollo:check` exercises this against a real key for free (search only) before the agent runs.

## HTTP API (JSON; `actor` is a member handle — no auth by design)

| Method & path | Body | Result |
|---|---|---|
| `GET /api/rooms` | – | `RoomSummary[]` |
| `POST /api/rooms` | `{objective, icp:{description, filters}, targetCount?, humans:[{handle, displayName}]}` | `{roomId}` |
| `GET /api/rooms/:roomId` | – | `RoomSnapshot` |
| `GET /api/rooms/:roomId/stream` | – | SSE: `event: change` `data: {eventId, type}` on every room event |
| `POST /api/rooms/:roomId/pause` / `resume` | `{actor}` | `{room}` |
| `POST /api/prospects/:id/claim` | `{actor, expectedVersion}` | `{prospect}` |
| `POST /api/prospects/:id/handback` | `{actor, expectedVersion, note?}` | `{prospect}` |
| `POST /api/prospects/:id/approve` | `{actor, expectedVersion, text?}` | `{prospect}` |
| `POST /api/prospects/:id/skip` | `{actor, expectedVersion, reason?}` | `{prospect}` |
| `POST /api/jobs/:id/retry` | `{actor}` | `{job}` |

Action failures: `409 conflict`, `404 not_found`, `403 forbidden`, `423 room_paused`, `400 invalid`, body
`{error: code, message}`.

## Event types (`events.type`)

`room.created`, `room.paused`, `room.resumed`, `search.completed`, `prospect.discovered`, `enrich.completed`,
`enrich.in_doubt_retry`, `draft.created`, `draft.in_doubt_retry`, `linkedin.completed`, `task.claimed`,
`task.handed_back`, `task.approved`, `task.skipped`, `job.rate_limited`, `job.retry_scheduled`, `job.dead`,
`job.reclaimed`, `job.cancelled`, `job.retried_by_human`, `action.rejected`.
