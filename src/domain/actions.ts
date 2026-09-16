import { pool, withTx, type Tx } from '../db.ts';
import { enqueue } from '../queue/queue.ts';
import { appendEvent } from './events.ts';
import {
  TERMINAL_STAGES,
  type ActionErrorCode,
  type ActionResult,
  type Icp,
  type JobRow,
  type MemberKind,
  type MemberRow,
  type ProspectRow,
  type RoomRow,
} from './types.ts';

const HANDLE = /^[a-z0-9_-]{1,32}$/;
const MAX_NOTE_LENGTH = 1_000;

/** A human action that was refused. Thrown inside the transaction so nothing it did is committed. */
class Rejection extends Error {
  constructor(
    readonly code: ActionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: ActionErrorCode, message: string): never {
  throw new Rejection(code, message);
}

// ------------------------------------------------------------------------------------------- rooms

export interface CreateRoomInput {
  objective: string;
  icp: Icp;
  targetCount?: number;
  humans: { handle: string; displayName: string }[];
}

export async function createRoom(input: CreateRoomInput): Promise<ActionResult<{ roomId: string }>> {
  const objective = input.objective?.trim();
  const targetCount = input.targetCount ?? 10;
  const humans = input.humans ?? [];
  const handles = humans.map((h) => h.handle);
  const invalid = (message: string): ActionResult<never> => ({ ok: false, code: 'invalid', message });

  if (!objective) return invalid('objective is required');
  if (!input.icp?.description?.trim()) return invalid('icp.description is required');
  if (typeof input.icp.filters !== 'object' || input.icp.filters === null) return invalid('icp.filters must be an object');
  if (!Number.isInteger(targetCount) || targetCount < 1 || targetCount > 100) return invalid('targetCount must be 1-100');
  if (humans.length < 1) return invalid('at least one human is required');
  if (handles.some((h) => !HANDLE.test(h) || h === 'agent')) return invalid('handles must match [a-z0-9_-] and not be "agent"');
  if (new Set(handles).size !== handles.length) return invalid('handles must be unique');

  const roomId = await withTx(async (tx) => {
    const room = await tx.query<{ id: string }>(
      'insert into rooms (objective, icp, target_count) values ($1, $2, $3) returning id',
      [objective, JSON.stringify(input.icp), targetCount],
    );
    const id = room.rows[0]!.id;
    for (const human of humans) {
      await tx.query(`insert into members (room_id, handle, display_name, kind) values ($1, $2, $3, 'human')`, [
        id,
        human.handle,
        human.displayName?.trim() || human.handle,
      ]);
    }
    const agent = await tx.query<{ id: string }>(
      `insert into members (room_id, handle, display_name, kind) values ($1, 'agent', 'Prospecting agent', 'agent') returning id`,
      [id],
    );
    await tx.query('update rooms set agent_member_id = $2 where id = $1', [id, agent.rows[0]!.id]);
    await enqueue(tx, { roomId: id, prospectId: null, kind: 'search', key: `search:${id}:p1`, payload: { page: 1 } });
    await appendEvent(tx, {
      roomId: id,
      type: 'room.created',
      data: { objective, icp: input.icp, targetCount, humans: handles },
    });
    return id;
  });
  return { ok: true, value: { roomId } };
}

export function pauseRoom(roomId: string, actorHandle: string) {
  return setRoomStatus('pause', roomId, actorHandle, 'active', 'paused');
}

export function resumeRoom(roomId: string, actorHandle: string) {
  return setRoomStatus('resume', roomId, actorHandle, 'paused', 'active');
}

function setRoomStatus(action: string, roomId: string, actorHandle: string, from: RoomRow['status'], to: RoomRow['status']) {
  return humanAction(
    action,
    { roomId },
    actorHandle,
    async (tx, { room, actor }) => {
      if (room.status !== from) reject('conflict', `The room is already ${room.status}`);
      const { rows } = await tx.query<RoomRow>(
        'update rooms set status = $2, version = version + 1, updated_at = now() where id = $1 returning *',
        [roomId, to],
      );
      await appendEvent(tx, { roomId, actorMemberId: actor.id, type: to === 'paused' ? 'room.paused' : 'room.resumed' });
      return rows[0]!;
    },
    { roomLock: 'update', allowPaused: true },
  );
}

// ------------------------------------------------------------------------------------------- tasks

export function claimProspect(prospectId: string, actorHandle: string, expectedVersion: number) {
  return humanAction('claim', { prospectId }, actorHandle, async (tx, { room, actor }) => {
    const p = await lockProspect(tx, prospectId);
    ensureOpen(p);
    if (p.owner_member_id === actor.id) reject('conflict', 'You already own this task');
    ensureNotOwnedByOther(p, actor);
    ensureFresh(p, expectedVersion);
    const updated = await updateProspect(tx, p, 'owner_member_id = $3', [actor.id]);
    await appendEvent(tx, {
      roomId: room.id,
      prospectId,
      actorMemberId: actor.id,
      type: 'task.claimed',
      data: { stage: p.stage, from: p.owner_handle },
    });
    return updated;
  });
}

export function handBackProspect(prospectId: string, actorHandle: string, expectedVersion: number, note?: string | null) {
  return humanAction('handback', { prospectId }, actorHandle, async (tx, { room, actor }) => {
    const p = await lockProspect(tx, prospectId);
    ensureOpen(p);
    if (p.owner_kind === 'agent') reject('conflict', 'The agent already owns this task');
    if (p.owner_member_id !== actor.id) reject('conflict', `Claimed by ${p.owner_handle}; only they can hand it back`);
    ensureFresh(p, expectedVersion);
    const feedback = cleanText(note, 'note');

    // Feedback means "try again": a new revision, which is a new, distinct draft job. This also covers a note
    // that arrives while the draft job is still running — that job's revision is then superseded, so the
    // feedback can't be silently lost.
    const redraft = Boolean(feedback) && (p.stage === 'awaiting_review' || !(await currentDraft(tx, p)));
    const updated = redraft
      ? await updateProspect(
          tx,
          p,
          `owner_member_id = $3, stage = 'enriched', draft_revision = draft_revision + 1, handback_note = $4`,
          [room.agent_member_id, feedback],
        )
      : await updateProspect(tx, p, 'owner_member_id = $3, handback_note = coalesce($4, handback_note)', [
          room.agent_member_id,
          feedback,
        ]);
    if (redraft) {
      await enqueue(tx, {
        roomId: room.id,
        prospectId,
        kind: 'draft',
        key: `draft:${prospectId}:${updated.draft_revision}`,
        payload: { revision: updated.draft_revision, awaitLinkedIn: false },
      });
    }
    await appendEvent(tx, {
      roomId: room.id,
      prospectId,
      actorMemberId: actor.id,
      type: 'task.handed_back',
      data: { note: feedback, redraft, revision: updated.draft_revision, stage: updated.stage },
    });
    return updated;
  });
}

export function approveProspect(prospectId: string, actorHandle: string, expectedVersion: number, text?: string | null) {
  return humanAction('approve', { prospectId }, actorHandle, async (tx, { room, actor }) => {
    const p = await lockProspect(tx, prospectId);
    ensureOpen(p);
    ensureNotOwnedByOther(p, actor);
    ensureFresh(p, expectedVersion);
    if (p.owner_kind === 'agent' && p.stage !== 'awaiting_review') {
      reject('conflict', 'The agent is still working on this task; claim it to write the note yourself');
    }
    const draft = await currentDraft(tx, p);
    const edited = cleanText(text, 'text');
    const finalNote = edited ?? (p.stage === 'awaiting_review' ? draft?.body : undefined);
    if (!finalNote) reject('invalid', 'There is no draft yet; provide the note text to approve');

    const updated = await updateProspect(
      tx,
      p,
      `stage = 'approved', final_note = $3, decided_by = $4, decided_at = now(), owner_member_id = $4`,
      [finalNote, actor.id],
    );
    const cancelledJobs = await cancelPendingJobs(tx, prospectId);
    await appendEvent(tx, {
      roomId: room.id,
      prospectId,
      actorMemberId: actor.id,
      type: 'task.approved',
      data: {
        edited: edited !== null && edited !== draft?.body,
        revision: draft?.revision ?? null,
        generator: draft?.generator ?? null,
        finalNote,
        cancelledJobs,
      },
    });
    return updated;
  });
}

export function skipProspect(prospectId: string, actorHandle: string, expectedVersion: number, reason?: string | null) {
  return humanAction('skip', { prospectId }, actorHandle, async (tx, { room, actor }) => {
    const p = await lockProspect(tx, prospectId);
    ensureOpen(p);
    ensureNotOwnedByOther(p, actor);
    ensureFresh(p, expectedVersion);
    if (p.owner_kind === 'agent' && p.stage !== 'awaiting_review') {
      reject('conflict', 'The agent is still working on this task; claim it first');
    }
    const why = cleanText(reason, 'reason');
    const updated = await updateProspect(
      tx,
      p,
      `stage = 'skipped', final_note = null, decided_by = $3, decided_at = now(), owner_member_id = $3`,
      [actor.id],
    );
    const cancelledJobs = await cancelPendingJobs(tx, prospectId);
    await appendEvent(tx, {
      roomId: room.id,
      prospectId,
      actorMemberId: actor.id,
      type: 'task.skipped',
      data: { reason: why, cancelledJobs },
    });
    return updated;
  });
}

export function retryJob(jobId: string, actorHandle: string) {
  return humanAction('retry_job', { jobId }, actorHandle, async (tx, { room, actor }) => {
    // Lock the prospect before the job, matching the order every other action uses.
    const preview = (await tx.query<JobRow>('select * from jobs where id = $1', [jobId])).rows[0];
    if (!preview) reject('not_found', 'Job not found');
    // A job on a decided task can never run again (the deciding human owns it), so retrying would strand it.
    if (preview.prospect_id) ensureOpen(await lockProspect(tx, preview.prospect_id));
    const { rows } = await tx.query<JobRow>('select * from jobs where id = $1 for update', [jobId]);
    const job = rows[0] ?? reject('not_found', 'Job not found');
    if (job.status !== 'dead') reject('conflict', `The job is ${job.status}; only failed (dead) jobs can be retried`);
    const updated = await tx.query<JobRow>(
      `update jobs
          set status = 'pending', attempts = 0, claims = 0, deferrals = 0, run_after = now(),
              last_error = null, finished_at = null, updated_at = now()
        where id = $1
        returning *`,
      [jobId],
    );
    if (job.prospect_id) {
      await tx.query('update prospects set last_error = null, updated_at = now() where id = $1', [job.prospect_id]);
    }
    await appendEvent(tx, {
      roomId: room.id,
      prospectId: job.prospect_id,
      jobId,
      actorMemberId: actor.id,
      type: 'job.retried_by_human',
      data: { kind: job.kind, previousError: job.last_error },
    });
    return updated.rows[0]!;
  });
}

// ------------------------------------------------------------------------------------------- plumbing

interface ActorContext {
  room: RoomRow;
  actor: MemberRow;
}

interface Target {
  roomId?: string;
  prospectId?: string;
  jobId?: string;
}

interface ActionOptions {
  /** Pause/resume need an exclusive room lock; everything else shares it, which serializes them against pause. */
  roomLock?: 'share' | 'update';
  allowPaused?: boolean;
}

const RETRYABLE_PG_CODES = new Set(['40001', '40P01']); // serialization failure, deadlock detected

async function humanAction<T>(
  action: string,
  target: Target,
  actorHandle: string,
  body: (tx: Tx, ctx: ActorContext) => Promise<T>,
  opts: ActionOptions = {},
): Promise<ActionResult<T>> {
  for (let attempt = 1; ; attempt++) {
    const seen: { roomId?: string; actorId?: string } = {};
    try {
      const value = await withTx(async (tx) => {
        const roomId = target.roomId ?? (await roomIdOf(tx, target));
        if (!roomId) reject('not_found', target.jobId ? 'Job not found' : 'Task not found');
        const lock = opts.roomLock === 'update' ? 'for update' : 'for share';
        const room = (await tx.query<RoomRow>(`select * from rooms where id = $1 ${lock}`, [roomId])).rows[0];
        if (!room) reject('not_found', 'Room not found');
        seen.roomId = room.id;
        const actor = (
          await tx.query<MemberRow>('select * from members where room_id = $1 and handle = $2', [room.id, actorHandle])
        ).rows[0];
        if (!actor || actor.kind !== 'human') reject('forbidden', `"${actorHandle}" is not a human member of this room`);
        seen.actorId = actor.id;
        if (room.status !== 'active' && !opts.allowPaused) reject('room_paused', 'The room is paused');
        return body(tx, { room, actor });
      });
      return { ok: true, value };
    } catch (err) {
      if (err instanceof Rejection) {
        if (seen.roomId) {
          await appendEvent(pool, {
            roomId: seen.roomId,
            prospectId: target.prospectId ?? null,
            jobId: target.jobId ?? null,
            actorMemberId: seen.actorId ?? null,
            type: 'action.rejected',
            data: { action, actor: actorHandle, code: err.code, message: err.message },
          }).catch(() => {});
        }
        return { ok: false, code: err.code, message: err.message };
      }
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE_PG_CODES.has(code) && attempt < 3) continue;
      throw err;
    }
  }
}

async function roomIdOf(tx: Tx, target: Target): Promise<string | undefined> {
  const [table, id] = target.prospectId ? ['prospects', target.prospectId] : ['jobs', target.jobId];
  if (!id || !isUuid(id)) return undefined;
  const { rows } = await tx.query<{ room_id: string }>(`select room_id from ${table} where id = $1`, [id]);
  return rows[0]?.room_id;
}

interface LockedProspect extends ProspectRow {
  owner_handle: string;
  owner_kind: MemberKind;
  decided_by_handle: string | null;
}

async function lockProspect(tx: Tx, prospectId: string): Promise<LockedProspect> {
  // Lock the row on its own. With a join, READ COMMITTED re-checks a concurrently updated row against the
  // originally joined member row, so a row whose owner just changed would vanish ("not found") instead of
  // conflicting.
  const locked = await tx.query<ProspectRow>('select * from prospects where id = $1 for update', [prospectId]);
  const prospect = locked.rows[0] ?? reject('not_found', 'Task not found');
  const { rows } = await tx.query<{ owner_handle: string; owner_kind: MemberKind; decided_by_handle: string | null }>(
    `select o.handle as owner_handle, o.kind as owner_kind, d.handle as decided_by_handle
       from members o
       left join members d on d.id = $2
      where o.id = $1`,
    [prospect.owner_member_id, prospect.decided_by],
  );
  return { ...prospect, ...rows[0]! };
}

/** Writes with a version guard as a second line of defence behind the row lock taken by lockProspect. */
async function updateProspect(tx: Tx, p: ProspectRow, set: string, params: unknown[]): Promise<ProspectRow> {
  const { rows } = await tx.query<ProspectRow>(
    `update prospects set ${set}, version = version + 1, updated_at = now()
      where id = $1 and version = $2
      returning *`,
    [p.id, p.version, ...params],
  );
  return rows[0] ?? reject('conflict', 'This task changed while you were acting on it');
}

function ensureOpen(p: LockedProspect): void {
  if (TERMINAL_STAGES.includes(p.stage)) {
    reject('conflict', `Already ${p.stage}${p.decided_by_handle ? ` by ${p.decided_by_handle}` : ''}`);
  }
}

function ensureNotOwnedByOther(p: LockedProspect, actor: MemberRow): void {
  if (p.owner_kind === 'human' && p.owner_member_id !== actor.id) reject('conflict', `Already claimed by ${p.owner_handle}`);
}

function ensureFresh(p: ProspectRow, expectedVersion: number): void {
  if (!Number.isInteger(expectedVersion)) reject('invalid', 'expectedVersion (integer) is required');
  if (p.version !== expectedVersion) {
    reject('conflict', `This task changed since you loaded it (version ${expectedVersion} → ${p.version}); refresh and retry`);
  }
}

async function currentDraft(tx: Tx, p: ProspectRow) {
  const { rows } = await tx.query<{ body: string; revision: number; generator: string }>(
    'select body, revision, generator from drafts where prospect_id = $1 and revision = $2',
    [p.id, p.draft_revision],
  );
  return rows[0];
}

async function cancelPendingJobs(tx: Tx, prospectId: string): Promise<number> {
  const { rowCount } = await tx.query(
    `update jobs
        set status = 'cancelled', last_error = 'task decided by a human', finished_at = now(), updated_at = now()
      where prospect_id = $1 and status = 'pending'`,
    [prospectId],
  );
  return rowCount ?? 0;
}

function cleanText(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') reject('invalid', `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > MAX_NOTE_LENGTH) reject('invalid', `${field} must be at most ${MAX_NOTE_LENGTH} characters`);
  return trimmed || null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
