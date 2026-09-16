import { config } from '../config.ts';
import { pool, withTx, type Queryable, type Tx } from '../db.ts';
import { appendEvent } from '../domain/events.ts';
import {
  TERMINAL_STAGES,
  type ApolloPerson,
  type JobKind,
  type ProspectRow,
  type RoomRow,
} from '../domain/types.ts';
import { DeferError, PermanentError, RateLimitedError, RetryableError } from '../queue/errors.ts';
import { ReleaseJob } from '../queue/errors.ts';
import { enqueue, markCancelled, markSucceeded, type ClaimedJob } from '../queue/queue.ts';
import { ApolloClient, ApolloError, exhaustedWindowSeconds, type ApolloResult } from './apollo.ts';
import { DraftError, draftOutreach, templateDraft, type DraftInput, type DraftOutput } from './drafter.ts';
import { scrubDeep } from '../scrub.ts';
import { beginExternalCall, blockProvider, finishExternalCall, recordProviderHeaders, type BeginCallInput } from './ledger.ts';
import { BrowserUnavailableError, fetchLinkedInHeadline, type LinkedInResult } from './linkedin.ts';

export interface JobContext {
  job: ClaimedJob;
  workerId: string;
  signal: AbortSignal;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

const apollo = new ApolloClient(config.apollo);
const APOLLO_BUDGET = {
  perMinute: config.apollo.limitPerMinute,
  perHour: config.apollo.limitPerHour,
  perDay: config.apollo.limitPerDay,
};
const MAX_SEARCH_PAGES = 5;
/** How long a draft waits for the room's LinkedIn lookup on the same prospect before drafting without it. */
const LINKEDIN_WAIT_DEFERRALS = 40;
const LINKEDIN_WAIT_MS = 3_000;
const LINKEDIN_GRACE_MS = 15_000;
const ENRICHMENT_WAIT_DEFERRALS = 60;
const LINKEDIN_AUTHWALL_ATTEMPTS = 3;

export const handlers: Record<JobKind, JobHandler> = {
  search: handleSearch,
  enrich: handleEnrich,
  draft: handleDraft,
  linkedin: handleLinkedIn,
};

// ---------------------------------------------------------------------------------------------- search

async function handleSearch(ctx: JobContext): Promise<void> {
  const { job, workerId } = ctx;
  const room = await loadRoom(job.room_id);
  const page = Number(job.payload.page ?? 1);
  const perPage = Math.min(100, room.target_count);

  if ((await countProspects(pool, room.id)) >= room.target_count) {
    await withTx((tx) => markSucceeded(tx, job.id, workerId));
    return;
  }

  const { callId, result } = await callApollo(
    ctx,
    {
      operation: 'people_search',
      logicalKey: `apollo.people_search:${room.id}:p${page}`,
      roomId: room.id,
      prospectId: null,
      request: { filters: room.icp.filters, page, per_page: perPage },
    },
    'search.in_doubt_retry',
    (signal) => apollo.searchPeople(room.icp.filters, page, perPage, signal),
  );
  const people = Array.isArray(result.data.people) ? result.data.people : [];

  await withTx(async (tx) => {
    await markSucceeded(tx, job.id, workerId);
    await finishExternalCall(tx, callId, {
      status: 'succeeded',
      httpStatus: result.status,
      rateHeaders: result.rateHeaders,
      response: { total_entries: result.data.total_entries ?? null, people },
    });
    await noteApolloHeaders(tx, result.rateHeaders);

    let position = await countProspects(tx, room.id);
    let added = 0;
    for (const person of people) {
      if (position >= room.target_count) break;
      if (!person?.id) continue;
      const displayName = [person.first_name, person.last_name_obfuscated].filter(Boolean).join(' ') || person.id;
      const inserted = await tx.query<{ id: string }>(
        `insert into prospects (room_id, position, apollo_person_id, owner_member_id, display_name, title, company, search_result)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (room_id, apollo_person_id) do nothing
         returning id`,
        [
          room.id,
          position + 1,
          person.id,
          room.agent_member_id,
          displayName,
          person.title ?? null,
          person.organization?.name ?? null,
          JSON.stringify(person),
        ],
      );
      const prospectId = inserted.rows[0]?.id;
      if (!prospectId) continue;
      position += 1;
      added += 1;
      await enqueue(tx, { roomId: room.id, prospectId, kind: 'enrich', key: `enrich:${prospectId}` });
      await appendEvent(tx, {
        roomId: room.id,
        prospectId,
        jobId: job.id,
        type: 'prospect.discovered',
        data: { position, name: displayName, title: person.title ?? null, company: person.organization?.name ?? null },
      });
    }

    const morePages = position < room.target_count && people.length >= perPage && page < MAX_SEARCH_PAGES;
    if (morePages) {
      await enqueue(tx, {
        roomId: room.id,
        prospectId: null,
        kind: 'search',
        key: `search:${room.id}:p${page + 1}`,
        payload: { page: page + 1 },
      });
    }
    await appendEvent(tx, {
      roomId: room.id,
      jobId: job.id,
      type: 'search.completed',
      data: { page, returned: people.length, added, totalProspects: position, totalEntries: result.data.total_entries ?? null, morePages },
    });
  });
}

// ---------------------------------------------------------------------------------------------- enrich

async function handleEnrich(ctx: JobContext): Promise<void> {
  const { job, workerId } = ctx;
  const room = await loadRoom(job.room_id);
  const prospect = await gateProspect(ctx, room);
  if (!prospect) return;

  // Result already committed by an earlier attempt: finish the bookkeeping, never call Apollo again.
  const existing = await pool.query<{ person: ApolloPerson }>('select person from enrichments where prospect_id = $1', [prospect.id]);
  if (existing.rows[0]) {
    const { person } = existing.rows[0];
    await withTx(async (tx) => {
      await markSucceeded(tx, job.id, workerId);
      await advanceAfterEnrichment(tx, room, prospect.id, job.id, person);
    });
    return;
  }

  const { callId, result } = await callApollo(
    ctx,
    {
      operation: 'people_match',
      logicalKey: `apollo.people_match:${prospect.id}`,
      roomId: room.id,
      prospectId: prospect.id,
      request: { id: prospect.apollo_person_id },
    },
    'enrich.in_doubt_retry',
    (signal) => apollo.matchPerson(prospect.apollo_person_id, signal),
  );

  // Apollo answers 200 for a miss: either no person object at all, or one carrying match_confidence "none".
  const person = result.data.person;
  if (!person || person.match_confidence === 'none') {
    await finishExternalCall(pool, callId, {
      status: 'succeeded',
      httpStatus: result.status,
      rateHeaders: result.rateHeaders,
      response: result.data,
    });
    // A no-match is a normal 200 and still reports the remaining quota, which the shared block needs.
    await noteApolloHeaders(pool, result.rateHeaders);
    throw new PermanentError(
      `Apollo returned no match (match_confidence: ${person?.match_confidence ?? 'absent'}) for person ${prospect.apollo_person_id}`,
    );
  }

  await withTx(async (tx) => {
    await markSucceeded(tx, job.id, workerId);
    await finishExternalCall(tx, callId, {
      status: 'succeeded',
      httpStatus: result.status,
      rateHeaders: result.rateHeaders,
      response: result.data,
    });
    await noteApolloHeaders(tx, result.rateHeaders);
    await tx.query(
      `insert into enrichments (prospect_id, room_id, apollo_person_id, person, organization, external_call_id)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (prospect_id) do nothing`,
      [prospect.id, room.id, prospect.apollo_person_id, JSON.stringify(person), JSON.stringify(person.organization ?? null), callId],
    );
    await advanceAfterEnrichment(tx, room, prospect.id, job.id, person);
  });
}

async function advanceAfterEnrichment(tx: Tx, room: RoomRow, prospectId: string, jobId: string, person: ApolloPerson) {
  const { rows } = await tx.query<ProspectRow>(
    `update prospects
        set stage = 'enriched',
            display_name = coalesce($2, display_name),
            title = coalesce($3, title),
            company = coalesce($4, company),
            last_error = null, version = version + 1, updated_at = now()
      where id = $1 and stage = 'new'
      returning *`,
    [prospectId, person.name ?? null, person.title ?? null, person.organization?.name ?? null],
  );
  const prospect = rows[0];
  if (!prospect) return; // already advanced, or a human decided it meanwhile

  const linkedinUrl = config.linkedin.urlOverride ?? person.linkedin_url ?? null;
  const awaitLinkedIn =
    config.linkedin.enabled && linkedinUrl
      ? await enqueue(tx, {
          roomId: room.id,
          prospectId,
          kind: 'linkedin',
          // Keyed per prospect so a cancelled lookup can be re-targeted; the partial unique index on
          // jobs(room_id) still keeps one live lookup per room.
          key: `linkedin:${room.id}:${prospectId}`,
          payload: { url: linkedinUrl },
        })
      : false;
  await enqueue(tx, {
    roomId: room.id,
    prospectId,
    kind: 'draft',
    key: `draft:${prospectId}:${prospect.draft_revision}`,
    payload: { revision: prospect.draft_revision, awaitLinkedIn },
  });
  await appendEvent(tx, {
    roomId: room.id,
    prospectId,
    jobId,
    type: 'enrich.completed',
    data: {
      name: prospect.display_name,
      title: prospect.title,
      company: prospect.company,
      emailStatus: person.email_status ?? null,
      hasLinkedIn: Boolean(person.linkedin_url),
      linkedinLookup: awaitLinkedIn,
    },
  });
}

// ---------------------------------------------------------------------------------------------- draft

async function handleDraft(ctx: JobContext): Promise<void> {
  const { job, workerId } = ctx;
  const room = await loadRoom(job.room_id);
  const prospect = await gateProspect(ctx, room);
  if (!prospect) return;
  const revision = Number(job.payload.revision ?? 1);

  if (prospect.draft_revision !== revision) {
    await cancelJob(job, workerId, `superseded by draft revision ${prospect.draft_revision}`);
    return;
  }

  const existing = await pool.query<{ generator: string }>(
    'select generator from drafts where prospect_id = $1 and revision = $2',
    [prospect.id, revision],
  );
  if (existing.rows[0]) {
    await withTx(async (tx) => {
      await markSucceeded(tx, job.id, workerId);
      await advanceToReview(tx, prospect.id, revision);
    });
    return;
  }

  if (job.payload.awaitLinkedIn && job.deferrals < LINKEDIN_WAIT_DEFERRALS) {
    const lookup = await pool.query<{ status: string }>(
      `select status from jobs where kind = 'linkedin' and prospect_id = $1`,
      [prospect.id],
    );
    const status = lookup.rows[0]?.status;
    if (status === 'pending' || status === 'running') {
      throw new DeferError('waiting for the LinkedIn headline', { delayMs: LINKEDIN_WAIT_MS }, true);
    }
  }

  const input = await buildDraftInput(room, prospect, revision, job.deferrals);
  const { draft, callId, fallbackReason } = await produceDraft(ctx, room, prospect, revision, input);

  await withTx(async (tx) => {
    await markSucceeded(tx, job.id, workerId);
    if (callId) {
      await finishExternalCall(tx, callId, {
        status: 'succeeded',
        httpStatus: 200,
        response: { body: draft.body, generator: draft.generator, usage: draft.usage ?? null },
      });
    }
    const inserted = await tx.query(
      `insert into drafts (prospect_id, revision, body, generator, handback_note, external_call_id)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (prospect_id, revision) do nothing`,
      [prospect.id, revision, draft.body, draft.generator, input.handbackNote ?? null, callId],
    );
    if (inserted.rowCount === 1) {
      await appendEvent(tx, {
        roomId: room.id,
        prospectId: prospect.id,
        jobId: job.id,
        type: 'draft.created',
        data: { revision, generator: draft.generator, fallbackReason, usedLinkedInHeadline: Boolean(input.linkedinHeadline) },
      });
    }
    await advanceToReview(tx, prospect.id, revision);
  });
}

async function buildDraftInput(room: RoomRow, prospect: ProspectRow, revision: number, deferrals: number): Promise<DraftInput> {
  const enrichment = await pool.query<{ person: ApolloPerson }>('select person from enrichments where prospect_id = $1', [prospect.id]);
  if (!enrichment.rows[0]) {
    // A hand-back with feedback can queue the next revision before enrichment has landed. Bounded, because
    // deferrals are not failures: if enrichment never arrives (its job died), this must not poll forever.
    if (prospect.stage === 'new' && deferrals < ENRICHMENT_WAIT_DEFERRALS) {
      throw new DeferError('waiting for enrichment', { delayMs: 2_000 }, true);
    }
    throw new PermanentError('draft requested before the prospect was enriched');
  }
  const lookup = await pool.query<{ headline: string | null }>(
    `select headline from linkedin_lookups where prospect_id = $1 and outcome = 'ok'`,
    [prospect.id],
  );
  const previous = await pool.query<{ body: string }>(
    'select body from drafts where prospect_id = $1 and revision < $2 order by revision desc limit 1',
    [prospect.id, revision],
  );
  return {
    objective: room.objective,
    icpDescription: room.icp.description,
    pitch: room.icp.pitch ?? null,
    person: enrichment.rows[0].person,
    linkedinHeadline: lookup.rows[0]?.headline ?? null,
    revision,
    handbackNote: prospect.handback_note,
    previousDraft: previous.rows[0]?.body ?? null,
  };
}

interface ProducedDraft {
  draft: DraftOutput;
  callId: string | null;
  fallbackReason: string | null;
}

async function produceDraft(
  ctx: JobContext,
  room: RoomRow,
  prospect: ProspectRow,
  revision: number,
  input: DraftInput,
): Promise<ProducedDraft> {
  if (config.drafter.mode !== 'claude') {
    return { draft: templateDraft(input), callId: null, fallbackReason: null };
  }
  const begin = await beginExternalCall({
    provider: 'anthropic',
    operation: 'draft',
    logicalKey: `anthropic.draft:${prospect.id}:r${revision}`,
    roomId: room.id,
    prospectId: prospect.id,
    jobId: ctx.job.id,
    workerId: ctx.workerId,
    request: { model: config.drafter.model, revision },
  });
  if (begin.kind === 'defer') throw new DeferError(begin.reason, begin.until);
  if (begin.inDoubt > 0) {
    await appendEvent(pool, {
      roomId: room.id,
      prospectId: prospect.id,
      jobId: ctx.job.id,
      type: 'draft.in_doubt_retry',
      data: { revision, previousAttempts: begin.inDoubt },
    });
  }

  try {
    return { draft: await draftOutreach(input, ctx.signal), callId: begin.callId, fallbackReason: null };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    const message = errorMessage(err);
    await finishExternalCall(pool, begin.callId, {
      status: 'failed',
      httpStatus: err instanceof DraftError ? err.status : null,
      error: message,
    });
    if (err instanceof DraftError && err.kind === 'rate_limited') {
      throw new RateLimitedError(message, 'anthropic', err.retryAfterSeconds ?? 30, {});
    }
    if (err instanceof DraftError && err.kind === 'permanent') {
      // Misconfiguration or refusal: keep the room moving with the template, and say so in the event log.
      return { draft: templateDraft(input), callId: null, fallbackReason: message };
    }
    throw new RetryableError(message);
  }
}

async function advanceToReview(tx: Tx, prospectId: string, revision: number): Promise<void> {
  await tx.query(
    `update prospects
        set stage = 'awaiting_review', last_error = null, version = version + 1, updated_at = now()
      where id = $1 and stage = 'enriched' and draft_revision = $2`,
    [prospectId, revision],
  );
}

// ---------------------------------------------------------------------------------------------- linkedin

async function handleLinkedIn(ctx: JobContext): Promise<void> {
  const { job, workerId } = ctx;
  const prospectId = job.prospect_id!;
  const prospect = await loadProspect(prospectId);
  if (!prospect || TERMINAL_STAGES.includes(prospect.stage)) {
    await cancelJob(job, workerId, prospect ? `prospect already ${prospect.stage}` : 'prospect no longer exists');
    return;
  }
  const done = await pool.query('select 1 from linkedin_lookups where prospect_id = $1', [prospectId]);
  if (done.rowCount) {
    await withTx((tx) => markSucceeded(tx, job.id, workerId));
    return;
  }

  const url = String(job.payload.url ?? '');
  const begin = await beginExternalCall({
    provider: 'linkedin',
    operation: 'profile_headline',
    logicalKey: `linkedin.headline:${prospectId}`,
    roomId: job.room_id,
    prospectId,
    jobId: job.id,
    workerId,
    request: { url },
  });
  if (begin.kind === 'defer') throw new DeferError(begin.reason, begin.until);

  let result: LinkedInResult;
  try {
    result = await fetchLinkedInHeadline(url, {
      headless: config.linkedin.headless,
      channel: config.linkedin.channel,
      storageStatePath: config.linkedin.storageStatePath,
      artifactsDir: config.artifactsDir,
      timeoutMs: config.linkedin.timeoutMs,
      // Hard ceiling for the whole browser session, on top of the per-step timeouts inside the lookup.
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(config.linkedin.timeoutMs + LINKEDIN_GRACE_MS)]),
    });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    await finishExternalCall(pool, begin.callId, { status: 'failed', error: errorMessage(err) });
    if (err instanceof BrowserUnavailableError) throw new RetryableError(err.message);
    throw new RetryableError(`LinkedIn lookup failed: ${errorMessage(err)}`);
  }

  // LinkedIn blocks guest traffic intermittently, so an auth wall is retried before it is accepted as the answer.
  if (result.outcome === 'authwall' && job.attempts + 1 < LINKEDIN_AUTHWALL_ATTEMPTS) {
    await finishExternalCall(pool, begin.callId, { status: 'failed', response: result, error: 'auth wall' });
    throw new RetryableError('LinkedIn served an auth wall; retrying');
  }

  const safe = scrubDeep(result);
  await withTx(async (tx) => {
    await markSucceeded(tx, job.id, workerId);
    await finishExternalCall(tx, begin.callId, { status: 'succeeded', response: safe });
    await tx.query(
      `insert into linkedin_lookups (prospect_id, room_id, url, outcome, headline, source, final_url, screenshot_path, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (prospect_id) do nothing`,
      [
        prospectId,
        job.room_id,
        url,
        safe.outcome,
        safe.headline,
        safe.source,
        safe.finalUrl,
        safe.screenshotPath,
        JSON.stringify(safe.detail ?? {}),
      ],
    );
    await appendEvent(tx, {
      roomId: job.room_id,
      prospectId,
      jobId: job.id,
      type: 'linkedin.completed',
      data: { url, outcome: safe.outcome, headline: safe.headline, source: safe.source },
    });
  });
}

// ---------------------------------------------------------------------------------------------- shared

async function callApollo<T>(
  ctx: JobContext,
  call: Pick<BeginCallInput, 'operation' | 'logicalKey' | 'roomId' | 'prospectId' | 'request'>,
  inDoubtEventType: string,
  send: (signal: AbortSignal) => Promise<ApolloResult<T>>,
): Promise<{ callId: string; result: ApolloResult<T> }> {
  const begin = await beginExternalCall({
    ...call,
    provider: 'apollo',
    jobId: ctx.job.id,
    workerId: ctx.workerId,
    budget: APOLLO_BUDGET,
  });
  if (begin.kind === 'defer') throw new DeferError(begin.reason, begin.until);
  if (begin.inDoubt > 0) {
    await appendEvent(pool, {
      roomId: call.roomId,
      prospectId: call.prospectId,
      jobId: ctx.job.id,
      type: inDoubtEventType,
      data: { logicalKey: call.logicalKey, previousAttempts: begin.inDoubt },
    });
  }

  try {
    return { callId: begin.callId, result: await send(ctx.signal) };
  } catch (err) {
    if (ctx.signal.aborted) throw err; // shutdown mid-call: the ledger row stays 'started' (genuinely in doubt)
    const apolloError = err instanceof ApolloError ? err : null;
    // If the request may have reached Apollo, leave the row 'started': the next attempt then records it as
    // in-doubt rather than pretending the call never happened.
    if (!apolloError?.maybeDelivered) {
      await finishExternalCall(pool, begin.callId, {
        status: 'failed',
        httpStatus: apolloError?.status ?? null,
        rateHeaders: apolloError?.rateHeaders ?? null,
        error: errorMessage(err),
      });
    }
    if (!apolloError) throw err;
    switch (apolloError.kind) {
      case 'rate_limited': {
        // Honour Apollo's own retry-after, but never a zero-length hold, and back off longer when a whole
        // window (hour/day) is exhausted.
        const hold = Math.max(apolloError.retryAfterSeconds ?? 60, exhaustedWindowSeconds(apolloError.rateHeaders) ?? 0, 1);
        throw new RateLimitedError(apolloError.message, 'apollo', hold, apolloError.rateHeaders);
      }
      case 'transient':
        throw new RetryableError(apolloError.message);
      case 'permanent':
        throw new PermanentError(apolloError.message);
    }
  }
}

async function noteApolloHeaders(db: Queryable, headers: Record<string, string>): Promise<void> {
  await recordProviderHeaders(db, 'apollo', headers);
  const holdSeconds = exhaustedWindowSeconds(headers);
  if (holdSeconds) await blockProvider(db, 'apollo', holdSeconds, 'Apollo reported an exhausted rate window', headers);
}

/** Returns the prospect if the agent should work on it; closes or releases the job otherwise. */
async function gateProspect(ctx: JobContext, room: RoomRow): Promise<ProspectRow | null> {
  const { job, workerId } = ctx;
  const prospect = await loadProspect(job.prospect_id!);
  if (!prospect || TERMINAL_STAGES.includes(prospect.stage)) {
    await cancelJob(job, workerId, prospect ? `prospect already ${prospect.stage}` : 'prospect no longer exists');
    return null;
  }
  if (prospect.owner_member_id !== room.agent_member_id) {
    throw new ReleaseJob('a human owns this prospect');
  }
  return prospect;
}

async function cancelJob(job: ClaimedJob, workerId: string, reason: string): Promise<void> {
  await withTx(async (tx) => {
    await markCancelled(tx, job.id, workerId, reason);
    await appendEvent(tx, {
      roomId: job.room_id,
      prospectId: job.prospect_id,
      jobId: job.id,
      type: 'job.cancelled',
      data: { kind: job.kind, reason },
    });
  });
}

async function loadRoom(roomId: string): Promise<RoomRow> {
  const { rows } = await pool.query<RoomRow>('select * from rooms where id = $1', [roomId]);
  if (!rows[0]) throw new PermanentError(`room ${roomId} not found`);
  return rows[0];
}

async function loadProspect(prospectId: string): Promise<ProspectRow | null> {
  const { rows } = await pool.query<ProspectRow>('select * from prospects where id = $1', [prospectId]);
  return rows[0] ?? null;
}

async function countProspects(db: Tx | typeof pool, roomId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>('select count(*)::int as n from prospects where room_id = $1', [roomId]);
  return rows[0]?.n ?? 0;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
