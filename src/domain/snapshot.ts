import path from 'node:path';
import { pool, withTx } from '../db.ts';
import { STAGES, type ApolloPerson, type Icp, type JobKind, type JobRow, type JobStatus, type MemberKind, type RoomStatus, type Stage } from './types.ts';

export interface JobView {
  id: string;
  prospectId: string | null;
  kind: JobKind;
  status: JobStatus;
  attempts: number;
  deferrals: number;
  claims: number;
  runAfter: string;
  lockedBy: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface ProspectView {
  id: string;
  position: number;
  stage: Stage;
  version: number;
  apolloPersonId: string;
  ownerHandle: string;
  ownerKind: MemberKind;
  displayName: string;
  title: string | null;
  company: string | null;
  draftRevision: number;
  handbackNote: string | null;
  finalNote: string | null;
  decidedByHandle: string | null;
  decidedAt: string | null;
  lastError: string | null;
  updatedAt: string;
  enrichment: null | {
    name: string | null;
    title: string | null;
    headline: string | null;
    email: string | null;
    emailStatus: string | null;
    linkedinUrl: string | null;
    location: string | null;
    organization: { name: string | null; industry: string | null; website: string | null; employees: number | null } | null;
  };
  draft: null | { revision: number; body: string; generator: string; createdAt: string };
  linkedin: null | {
    url: string;
    outcome: string;
    headline: string | null;
    source: string | null;
    finalUrl: string | null;
    /** Served by the HTTP server under /artifacts/. */
    screenshotUrl: string | null;
    createdAt: string;
  };
  jobs: JobView[];
}

export interface EventView {
  id: number;
  type: string;
  actorHandle: string | null;
  prospectId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface RoomSnapshot {
  room: { id: string; objective: string; icp: Icp; targetCount: number; status: RoomStatus; version: number; createdAt: string };
  members: { id: string; handle: string; displayName: string; kind: MemberKind }[];
  prospects: ProspectView[];
  /** Jobs not tied to a prospect (Apollo search pages). */
  roomJobs: JobView[];
  stageCounts: Record<Stage, number>;
  providers: { provider: string; blockedUntil: string | null; reason: string | null; lastHeaders: Record<string, string> | null }[];
  calls: { provider: string; status: string; count: number }[];
  events: EventView[];
  serverTime: string;
}

export interface RoomSummary {
  id: string;
  objective: string;
  status: RoomStatus;
  targetCount: number;
  createdAt: string;
  humans: string[];
  stageCounts: Record<Stage, number>;
}

interface ProspectQueryRow {
  id: string;
  position: number;
  stage: Stage;
  version: number;
  apollo_person_id: string;
  owner_handle: string;
  owner_kind: MemberKind;
  display_name: string;
  title: string | null;
  company: string | null;
  draft_revision: number;
  handback_note: string | null;
  final_note: string | null;
  decided_by_handle: string | null;
  decided_at: Date | null;
  last_error: string | null;
  updated_at: Date;
  person: ApolloPerson | null;
  draft_revision_found: number | null;
  draft_body: string | null;
  draft_generator: string | null;
  draft_created_at: Date | null;
  li_url: string | null;
  li_outcome: string | null;
  li_headline: string | null;
  li_source: string | null;
  li_final_url: string | null;
  li_screenshot: string | null;
  li_created_at: Date | null;
}

export async function getRoomSnapshot(roomId: string): Promise<RoomSnapshot | null> {
  return withTx(async (tx) => {
    // One consistent read of the whole room.
    await tx.query('set transaction isolation level repeatable read read only');
    const room = (
      await tx.query<{ id: string; objective: string; icp: Icp; target_count: number; status: RoomStatus; version: number; created_at: Date }>(
        'select id, objective, icp, target_count, status, version, created_at from rooms where id = $1',
        [roomId],
      )
    ).rows[0];
    if (!room) return null;

    const members = await tx.query<{ id: string; handle: string; display_name: string; kind: MemberKind }>(
      'select id, handle, display_name, kind from members where room_id = $1 order by kind desc, created_at',
      [roomId],
    );
    const prospects = await tx.query<ProspectQueryRow>(
      `select p.id, p.position, p.stage, p.version, p.apollo_person_id, o.handle as owner_handle, o.kind as owner_kind,
              p.display_name, p.title, p.company, p.draft_revision, p.handback_note, p.final_note,
              d.handle as decided_by_handle, p.decided_at, p.last_error, p.updated_at,
              e.person,
              dr.revision as draft_revision_found, dr.body as draft_body, dr.generator as draft_generator, dr.created_at as draft_created_at,
              l.url as li_url, l.outcome as li_outcome, l.headline as li_headline, l.source as li_source,
              l.final_url as li_final_url, l.screenshot_path as li_screenshot, l.created_at as li_created_at
         from prospects p
         join members o on o.id = p.owner_member_id
         left join members d on d.id = p.decided_by
         left join enrichments e on e.prospect_id = p.id
         left join lateral (
           select revision, body, generator, created_at from drafts where prospect_id = p.id order by revision desc limit 1
         ) dr on true
         left join linkedin_lookups l on l.prospect_id = p.id
        where p.room_id = $1
        order by p.position`,
      [roomId],
    );
    const jobs = await tx.query<JobRow>('select * from jobs where room_id = $1 order by created_at', [roomId]);
    const events = await tx.query<{ id: string; type: string; actor_handle: string | null; prospect_id: string | null; data: Record<string, unknown>; created_at: Date }>(
      `select e.id, e.type, m.handle as actor_handle, e.prospect_id, e.data, e.created_at
         from events e
         left join members m on m.id = e.actor_member_id
        where e.room_id = $1
        order by e.id desc
        limit 200`,
      [roomId],
    );
    const providers = await tx.query<{ provider: string; blocked_until: Date | null; reason: string | null; last_headers: Record<string, string> | null }>(
      'select provider, blocked_until, reason, last_headers from provider_limits order by provider',
    );
    const calls = await tx.query<{ provider: string; status: string; count: number }>(
      `select provider, status, count(*)::int as count from external_calls where room_id = $1 group by provider, status order by provider, status`,
      [roomId],
    );
    const now = await tx.query<{ now: Date }>('select now()');

    const jobViews = jobs.rows.map(toJobView);
    const stageCounts = emptyStageCounts();
    for (const p of prospects.rows) stageCounts[p.stage] += 1;

    return {
      room: {
        id: room.id,
        objective: room.objective,
        icp: room.icp,
        targetCount: room.target_count,
        status: room.status,
        version: room.version,
        createdAt: iso(room.created_at),
      },
      members: members.rows.map((m) => ({ id: m.id, handle: m.handle, displayName: m.display_name, kind: m.kind })),
      prospects: prospects.rows.map((row) => toProspectView(row, jobViews.filter((j) => j.prospectId === row.id))),
      roomJobs: jobViews.filter((j) => j.prospectId === null),
      stageCounts,
      providers: providers.rows.map((p) => ({
        provider: p.provider,
        blockedUntil: p.blocked_until ? iso(p.blocked_until) : null,
        reason: p.reason,
        lastHeaders: p.last_headers,
      })),
      calls: calls.rows,
      events: events.rows.map((e) => ({
        id: Number(e.id),
        type: e.type,
        actorHandle: e.actor_handle,
        prospectId: e.prospect_id,
        data: e.data,
        createdAt: iso(e.created_at),
      })),
      serverTime: iso(now.rows[0]!.now),
    };
  });
}

export async function listRooms(): Promise<RoomSummary[]> {
  const { rows } = await pool.query<{
    id: string;
    objective: string;
    status: RoomStatus;
    target_count: number;
    created_at: Date;
    humans: string[] | null;
    stages: Record<string, number> | null;
  }>(
    `select r.id, r.objective, r.status, r.target_count, r.created_at,
            (select array_agg(handle order by created_at) from members where room_id = r.id and kind = 'human') as humans,
            (select jsonb_object_agg(stage, n) from (select stage, count(*)::int as n from prospects where room_id = r.id group by stage) s) as stages
       from rooms r
      order by r.created_at desc`,
  );
  return rows.map((r) => ({
    id: r.id,
    objective: r.objective,
    status: r.status,
    targetCount: r.target_count,
    createdAt: iso(r.created_at),
    humans: r.humans ?? [],
    stageCounts: { ...emptyStageCounts(), ...(r.stages ?? {}) },
  }));
}

function toProspectView(row: ProspectQueryRow, jobs: JobView[]): ProspectView {
  const person = row.person;
  const org = person?.organization ?? null;
  return {
    id: row.id,
    position: row.position,
    stage: row.stage,
    version: row.version,
    apolloPersonId: row.apollo_person_id,
    ownerHandle: row.owner_handle,
    ownerKind: row.owner_kind,
    displayName: row.display_name,
    title: row.title,
    company: row.company,
    draftRevision: row.draft_revision,
    handbackNote: row.handback_note,
    finalNote: row.final_note,
    decidedByHandle: row.decided_by_handle,
    decidedAt: row.decided_at ? iso(row.decided_at) : null,
    lastError: row.last_error,
    updatedAt: iso(row.updated_at),
    enrichment: person
      ? {
          name: person.name ?? null,
          title: person.title ?? null,
          headline: person.headline ?? null,
          email: person.email ?? null,
          emailStatus: person.email_status ?? null,
          linkedinUrl: person.linkedin_url ?? null,
          location: [person.city, person.state, person.country].filter(Boolean).join(', ') || null,
          organization: org
            ? {
                name: org.name ?? null,
                industry: org.industry ?? null,
                website: org.website_url ?? null,
                employees: org.estimated_num_employees ?? null,
              }
            : null,
        }
      : null,
    draft:
      row.draft_revision_found !== null && row.draft_body !== null
        ? {
            revision: row.draft_revision_found,
            body: row.draft_body,
            generator: row.draft_generator ?? 'unknown',
            createdAt: iso(row.draft_created_at!),
          }
        : null,
    linkedin:
      row.li_url && row.li_outcome
        ? {
            url: row.li_url,
            outcome: row.li_outcome,
            headline: row.li_headline,
            source: row.li_source,
            finalUrl: row.li_final_url,
            screenshotUrl: row.li_screenshot ? `/artifacts/${path.basename(row.li_screenshot)}` : null,
            createdAt: iso(row.li_created_at!),
          }
        : null,
    jobs,
  };
}

function toJobView(j: JobRow): JobView {
  return {
    id: j.id,
    prospectId: j.prospect_id,
    kind: j.kind,
    status: j.status,
    attempts: j.attempts,
    deferrals: j.deferrals,
    claims: j.claims,
    runAfter: iso(j.run_after),
    lockedBy: j.locked_by,
    lastError: j.last_error,
    updatedAt: iso(j.updated_at),
  };
}

function emptyStageCounts(): Record<Stage, number> {
  return Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
}

function iso(d: Date): string {
  return d.toISOString();
}
