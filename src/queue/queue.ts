import { pool, type Queryable, type Tx } from '../db.ts';
import { config } from '../config.ts';
import type { JobKind, JobRow, JobStatus } from '../domain/types.ts';
import { LeaseLostError } from './errors.ts';

export interface EnqueueInput {
  roomId: string;
  prospectId: string | null;
  kind: JobKind;
  key: string;
  payload?: Record<string, unknown>;
}

/**
 * Idempotent enqueue. Returns false when the job already exists (same idempotency key, or the room's
 * single LinkedIn job). Always call inside the transaction that makes the job necessary.
 */
export async function enqueue(db: Queryable, input: EnqueueInput): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into jobs (room_id, prospect_id, kind, idempotency_key, payload)
     values ($1, $2, $3, $4, $5)
     on conflict do nothing`,
    [input.roomId, input.prospectId, input.kind, input.key, JSON.stringify(input.payload ?? {})],
  );
  return rowCount === 1;
}

export interface ClaimedJob extends JobRow {
  prev_status: JobStatus;
  prev_locked_by: string | null;
}

/**
 * Claims the next runnable job. Runnable means: room active, prospect (if any) owned by the agent, and either
 * pending and due, or "running" under a worker that is dead (stopped/stale heartbeat) or whose lease expired.
 */
export async function claimNext(workerId: string): Promise<ClaimedJob | null> {
  const { rows } = await pool.query<ClaimedJob>(
    `with candidate as (
       select j.id, j.status as prev_status, j.locked_by as prev_locked_by
         from jobs j
         join rooms r on r.id = j.room_id
         left join prospects p on p.id = j.prospect_id
        where r.status = 'active'
          -- Decided prospects are included so their leftover jobs get claimed once and cancelled.
          and (p.id is null or p.owner_member_id = r.agent_member_id or p.stage in ('approved', 'skipped'))
          and (
            (j.status = 'pending' and j.run_after <= now())
            -- Worker liveness must be a correlated subquery, not a join: Postgres re-checks a concurrently
            -- updated row against the originally joined rows, and a stale NULL workers row would make a live
            -- worker's job look abandoned.
            or (j.status = 'running' and (
                  j.lease_expires_at < now()
                  or not exists (
                    select 1
                      from workers w
                     where w.id = j.locked_by
                       and w.stopped_at is null
                       and w.heartbeat_at >= now() - make_interval(secs => $3::float8))))
          )
        order by j.run_after, j.created_at
        limit 1
        for update of j skip locked
     )
     update jobs j
        set status = 'running',
            locked_by = $1,
            lease_expires_at = now() + make_interval(secs => $2::float8),
            claims = j.claims + 1,
            updated_at = now()
       from candidate c
      -- Re-assert what the candidate saw. Without this, READ COMMITTED re-checks a concurrently claimed row
      -- against the stale joined workers row (NULL), and a live worker's job looks reclaimable to a second
      -- worker. Zero rows here simply means someone else won the race and we poll again.
      where j.id = c.id
        and j.status = c.prev_status
        and j.locked_by is not distinct from c.prev_locked_by
     returning j.*, c.prev_status, c.prev_locked_by`,
    [workerId, config.worker.leaseSeconds, config.worker.staleWorkerSeconds],
  );
  return rows[0] ?? null;
}

/**
 * Fences the final transaction: must be the FIRST statement of the transaction that commits a job's result.
 * It locks the job row and proves we still hold the lease; otherwise the whole transaction is abandoned.
 */
export async function markSucceeded(tx: Tx, jobId: string, workerId: string): Promise<void> {
  await finish(tx, jobId, workerId, 'succeeded', null);
}

export async function markCancelled(tx: Tx, jobId: string, workerId: string, reason: string): Promise<void> {
  await finish(tx, jobId, workerId, 'cancelled', reason);
}

async function finish(tx: Tx, jobId: string, workerId: string, status: JobStatus, note: string | null) {
  const { rowCount } = await tx.query(
    `update jobs
        set status = $3, locked_by = null, lease_expires_at = null, last_error = $4,
            finished_at = now(), updated_at = now()
      where id = $1 and locked_by = $2 and status = 'running'`,
    [jobId, workerId, status, note],
  );
  if (rowCount !== 1) throw new LeaseLostError(jobId);
}

export type RunAt = Date | { delayMs: number };

export interface RescheduleOptions {
  countAttempt?: boolean;
  countDeferral?: boolean;
  error?: string | null;
}

/** Puts a running job back to pending for a later run. Throws LeaseLostError if we no longer hold it. */
export async function reschedule(
  db: Queryable,
  jobId: string,
  workerId: string,
  runAt: RunAt,
  opts: RescheduleOptions = {},
): Promise<JobRow> {
  const at = runAt instanceof Date ? runAt : null;
  const delaySeconds = runAt instanceof Date ? 0 : Math.max(0, runAt.delayMs) / 1000;
  const { rows } = await db.query<JobRow>(
    `update jobs
        set status = 'pending', locked_by = null, lease_expires_at = null,
            run_after = case when $3::timestamptz is null
                             then now() + make_interval(secs => $4::float8)
                             else greatest(now(), $3::timestamptz) end,
            attempts = attempts + $5, deferrals = deferrals + $6,
            last_error = coalesce($7, last_error), updated_at = now()
      where id = $1 and locked_by = $2 and status = 'running'
      returning *`,
    [jobId, workerId, at, delaySeconds, opts.countAttempt ? 1 : 0, opts.countDeferral ? 1 : 0, opts.error ?? null],
  );
  if (!rows[0]) throw new LeaseLostError(jobId);
  return rows[0];
}

export async function markDead(db: Queryable, jobId: string, workerId: string, error: string): Promise<JobRow> {
  const { rows } = await db.query<JobRow>(
    `update jobs
        set status = 'dead', locked_by = null, lease_expires_at = null, last_error = $3,
            finished_at = now(), updated_at = now()
      where id = $1 and locked_by = $2 and status = 'running'
      returning *`,
    [jobId, workerId, error],
  );
  if (!rows[0]) throw new LeaseLostError(jobId);
  return rows[0];
}

export async function extendLeases(workerId: string, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  await pool.query(
    `update jobs set lease_expires_at = now() + make_interval(secs => $3::float8), updated_at = now()
      where id = any($2::uuid[]) and locked_by = $1 and status = 'running'`,
    [workerId, jobIds, config.worker.leaseSeconds],
  );
}
