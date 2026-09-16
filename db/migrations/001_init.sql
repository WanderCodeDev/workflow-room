-- Prospect room: all room state, ownership, work queue and audit trail.
-- Invariants that matter for correctness are enforced here, not only in app code:
--   * one prospect per Apollo person per room          (prospects unique)
--   * one enrichment per prospect                      (enrichments pk)
--   * one draft per prospect revision                  (drafts unique)
--   * one queued unit of work per logical step         (jobs.idempotency_key unique)
--   * one LinkedIn lookup per room                     (partial unique index)

create table rooms (
  id               uuid primary key default gen_random_uuid(),
  objective        text not null check (length(objective) > 0),
  icp              jsonb not null,
  target_count     int  not null default 10 check (target_count between 1 and 100),
  status           text not null default 'active' check (status in ('active', 'paused')),
  agent_member_id  uuid,
  version          int  not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table members (
  id            uuid primary key default gen_random_uuid(),
  room_id       uuid not null references rooms (id) on delete cascade,
  handle        text not null check (handle ~ '^[a-z0-9_-]{1,32}$'),
  display_name  text not null,
  kind          text not null check (kind in ('human', 'agent')),
  created_at    timestamptz not null default now(),
  unique (room_id, handle),
  unique (room_id, id)
);
create unique index members_one_agent_per_room on members (room_id) where kind = 'agent';

alter table rooms
  add constraint rooms_agent_member_fk
  foreign key (id, agent_member_id) references members (room_id, id)
  deferrable initially deferred;

-- One row per person the agent found. This row is "the task" humans act on.
create table prospects (
  id                uuid primary key default gen_random_uuid(),
  room_id           uuid not null references rooms (id) on delete cascade,
  position          int  not null,
  apollo_person_id  text not null,
  stage             text not null default 'new'
                    check (stage in ('new', 'enriched', 'awaiting_review', 'approved', 'skipped')),
  owner_member_id   uuid not null,
  display_name      text not null,
  title             text,
  company           text,
  search_result     jsonb not null,
  -- Revision of the draft the agent currently owes (1 = first draft; +1 per hand-back with feedback).
  draft_revision    int  not null default 1 check (draft_revision >= 1),
  handback_note     text,
  final_note        text,
  decided_by        uuid,
  decided_at        timestamptz,
  last_error        text,
  version           int  not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (room_id, apollo_person_id),
  unique (room_id, position),
  foreign key (room_id, owner_member_id) references members (room_id, id),
  foreign key (room_id, decided_by) references members (room_id, id),
  check ((stage in ('approved', 'skipped')) = (decided_at is not null)),
  check (stage <> 'approved' or final_note is not null)
);
create index prospects_by_room on prospects (room_id, position);

create table jobs (
  id                uuid primary key default gen_random_uuid(),
  room_id           uuid not null references rooms (id) on delete cascade,
  prospect_id       uuid references prospects (id) on delete cascade,
  kind              text not null check (kind in ('search', 'enrich', 'draft', 'linkedin')),
  idempotency_key   text not null unique,
  payload           jsonb not null default '{}',
  status            text not null default 'pending'
                    check (status in ('pending', 'running', 'succeeded', 'dead', 'cancelled')),
  run_after         timestamptz not null default now(),
  attempts          int not null default 0,  -- failed attempts (transient errors); drives backoff
  claims            int not null default 0,  -- times picked up; detects crash loops / poison jobs
  deferrals         int not null default 0,  -- rate-limit deferrals; never counted as failures
  locked_by         text,
  lease_expires_at  timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  finished_at       timestamptz,
  check ((kind = 'search') = (prospect_id is null)),
  check ((status = 'running') = (locked_by is not null and lease_expires_at is not null))
);
create index jobs_claimable on jobs (run_after) where status in ('pending', 'running');
create index jobs_by_prospect on jobs (prospect_id);
create index jobs_by_room on jobs (room_id);
create unique index jobs_one_linkedin_per_room on jobs (room_id) where kind = 'linkedin';

create table workers (
  id            text primary key,
  host          text not null,
  pid           int  not null,
  started_at    timestamptz not null default now(),
  heartbeat_at  timestamptz not null default now(),
  stopped_at    timestamptz
);

-- Ledger of every outbound call attempt. Written 'started' (committed) BEFORE the call,
-- finished in the same transaction that stores the result. A 'started' row found later
-- means the process died mid-call: the outcome is unknown ("in doubt").
create table external_calls (
  id            uuid primary key default gen_random_uuid(),
  provider      text not null check (provider in ('apollo', 'anthropic', 'linkedin')),
  operation     text not null,
  logical_key   text not null,
  room_id       uuid references rooms (id) on delete cascade,
  prospect_id   uuid references prospects (id) on delete cascade,
  job_id        uuid references jobs (id) on delete set null,
  worker_id     text,
  status        text not null default 'started'
                check (status in ('started', 'succeeded', 'failed', 'in_doubt')),
  http_status   int,
  request       jsonb,
  response      jsonb,
  rate_headers  jsonb,
  error         text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index external_calls_budget on external_calls (provider, started_at);
create index external_calls_logical on external_calls (logical_key);

-- Provider-wide backoff (e.g. after a 429). Shared by every worker, survives restarts.
create table provider_limits (
  provider       text primary key,
  blocked_until  timestamptz,
  reason         text,
  last_headers   jsonb,
  updated_at     timestamptz not null default now()
);
insert into provider_limits (provider) values ('apollo'), ('anthropic');

create table enrichments (
  prospect_id       uuid primary key references prospects (id) on delete cascade,
  room_id           uuid not null references rooms (id) on delete cascade,
  apollo_person_id  text not null,
  person            jsonb not null,
  organization      jsonb,
  external_call_id  uuid not null references external_calls (id),
  created_at        timestamptz not null default now()
);

create table drafts (
  id                uuid primary key default gen_random_uuid(),
  prospect_id       uuid not null references prospects (id) on delete cascade,
  revision          int  not null check (revision >= 1),
  body              text not null,
  generator         text not null,
  handback_note     text,
  external_call_id  uuid references external_calls (id),
  created_at        timestamptz not null default now(),
  unique (prospect_id, revision)
);

create table linkedin_lookups (
  prospect_id      uuid primary key references prospects (id) on delete cascade,
  room_id          uuid not null references rooms (id) on delete cascade,
  url              text not null,
  outcome          text not null check (outcome in ('ok', 'authwall', 'not_found', 'no_headline', 'error')),
  headline         text,
  source           text,
  final_url        text,
  screenshot_path  text,
  detail           jsonb not null default '{}',
  created_at       timestamptz not null default now()
);

-- Append-only audit log: every human action (including rejected ones) and every agent step.
create table events (
  id               bigserial primary key,
  room_id          uuid not null references rooms (id) on delete cascade,
  prospect_id      uuid references prospects (id) on delete cascade,
  job_id           uuid references jobs (id) on delete set null,
  actor_member_id  uuid references members (id) on delete set null,
  type             text not null,
  data             jsonb not null default '{}',
  created_at       timestamptz not null default now()
);
create index events_by_room on events (room_id, id);

create function notify_room_event() returns trigger language plpgsql as $$
begin
  perform pg_notify('room_events',
    json_build_object('roomId', new.room_id, 'eventId', new.id, 'type', new.type)::text);
  return new;
end;
$$;

create trigger events_notify after insert on events
  for each row execute function notify_room_event();
