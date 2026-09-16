import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.ts';
import { pool, withTx } from '../db.ts';
import { appendEvent } from '../domain/events.ts';
import { handlers } from '../agent/handlers.ts';
import { blockProvider } from '../agent/ledger.ts';
import { log } from '../log.ts';
import { DeferError, LeaseLostError, PermanentError, RateLimitedError, ReleaseJob } from './errors.ts';
import { claimNext, extendLeases, markDead, reschedule, type ClaimedJob } from './queue.ts';

export class Worker {
  readonly id = `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private running = false;
  private loops: Promise<void>[] = [];
  private heartbeat: NodeJS.Timeout | undefined;
  private readonly active = new Map<string, AbortController>();

  async start(): Promise<void> {
    await pool.query('insert into workers (id, host, pid) values ($1, $2, $3)', [this.id, os.hostname(), process.pid]);
    await this.reapDeadLocalWorkers();
    this.running = true;
    this.heartbeat = setInterval(() => void this.beat(), config.worker.heartbeatSeconds * 1000);
    for (let slot = 0; slot < config.worker.concurrency; slot++) this.loops.push(this.loop());
    log('worker', `started ${this.id} with concurrency ${config.worker.concurrency}`);
  }

  async stop(): Promise<void> {
    this.running = false;
    clearInterval(this.heartbeat);
    for (const controller of this.active.values()) controller.abort(new Error('worker shutting down'));
    await Promise.allSettled(this.loops);
    await pool.query('update workers set stopped_at = now() where id = $1', [this.id]).catch(() => {});
    log('worker', `stopped ${this.id}`);
  }

  private async loop(): Promise<void> {
    let dbFailures = 0;
    while (this.running) {
      let job: ClaimedJob | null;
      try {
        job = await claimNext(this.id);
        dbFailures = 0;
      } catch (err) {
        dbFailures += 1;
        log('worker', `claim failed (${(err as Error).message}); retrying`);
        await sleep(Math.min(10_000, 500 * 2 ** Math.min(dbFailures, 5)));
        continue;
      }
      if (!job) {
        await sleep(config.worker.pollMs * (0.5 + Math.random()));
        continue;
      }
      if (!this.running) {
        // Claimed in the window after stop() aborted the jobs it knew about: hand it straight back.
        await reschedule(pool, job.id, this.id, { delayMs: 0 }, { countDeferral: true }).catch(() => {});
        break;
      }
      await this.run(job);
    }
  }

  private async run(job: ClaimedJob): Promise<void> {
    const controller = new AbortController();
    this.active.set(job.id, controller);
    try {
      if (job.prev_status === 'running') {
        log('worker', `reclaimed ${job.kind} job ${job.id} from ${job.prev_locked_by}`);
        await appendEvent(pool, {
          roomId: job.room_id,
          prospectId: job.prospect_id,
          jobId: job.id,
          type: 'job.reclaimed',
          data: { kind: job.kind, previousWorker: job.prev_locked_by },
        });
      }
      // Claims that ended in neither a recorded failure nor a deferral are crashes mid-job.
      const unexplainedClaims = job.claims - job.deferrals - job.attempts;
      if (unexplainedClaims > config.worker.maxClaims) {
        throw new PermanentError(`picked up ${job.claims} times without finishing (crash loop?)`);
      }
      await handlers[job.kind]({ job, workerId: this.id, signal: controller.signal });
    } catch (err) {
      await this.handleFailure(job, err, controller.signal).catch((recordErr: Error) =>
        // The lease will expire and the job will be reclaimed, so nothing is lost.
        log('worker', `could not record outcome of job ${job.id}: ${recordErr.message}`),
      );
    } finally {
      this.active.delete(job.id);
    }
  }

  private async handleFailure(job: ClaimedJob, err: unknown, signal: AbortSignal): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const where = { roomId: job.room_id, prospectId: job.prospect_id, jobId: job.id };

    if (err instanceof LeaseLostError) {
      log('worker', `lease lost on ${job.kind} job ${job.id}; result discarded`);
      return;
    }
    if (signal.aborted || err instanceof ReleaseJob) {
      await reschedule(pool, job.id, this.id, { delayMs: 0 }, { countDeferral: true });
      return;
    }
    if (err instanceof DeferError) {
      await withTx(async (tx) => {
        const row = await reschedule(tx, job.id, this.id, err.runAfter, { countDeferral: true });
        if (!err.quiet) {
          await appendEvent(tx, {
            ...where,
            type: 'job.rate_limited',
            data: { kind: job.kind, source: 'local', reason: message, runAfter: row.run_after },
          });
        }
      });
      return;
    }
    if (err instanceof RateLimitedError) {
      // Committed before (and independently of) the job update: if our lease was lost, the other workers
      // must still learn that the provider is rate limiting us.
      const until = await blockProvider(pool, err.provider, err.retryAfterSeconds, `429 from ${err.provider}`, err.rateHeaders);
      await withTx(async (tx) => {
        const row = await reschedule(tx, job.id, this.id, until, { countDeferral: true, error: message });
        await appendEvent(tx, {
          ...where,
          type: 'job.rate_limited',
          data: { kind: job.kind, source: '429', provider: err.provider, retryAfterSeconds: err.retryAfterSeconds, runAfter: row.run_after },
        });
      });
      log('worker', `${err.provider} rate limited; ${job.kind} job deferred ${err.retryAfterSeconds}s`);
      return;
    }

    const attempt = job.attempts + 1;
    // Postgres data exceptions (class 22 — e.g. a NUL byte in vendor text) fail identically on every retry.
    const pgCode = (err as { code?: string }).code;
    const permanent = err instanceof PermanentError || (typeof pgCode === 'string' && pgCode.startsWith('22'));
    if (permanent || attempt >= config.worker.maxAttempts) {
      await withTx(async (tx) => {
        await markDead(tx, job.id, this.id, message);
        await setProspectError(tx, job, message);
        await appendEvent(tx, { ...where, type: 'job.dead', data: { kind: job.kind, error: message, attempt, permanent } });
      });
      log('worker', `${job.kind} job ${job.id} dead: ${message}`);
      return;
    }

    const delayMs = backoffMs(attempt);
    await withTx(async (tx) => {
      const row = await reschedule(tx, job.id, this.id, { delayMs }, { countAttempt: true, error: message });
      await setProspectError(tx, job, message);
      await appendEvent(tx, {
        ...where,
        type: 'job.retry_scheduled',
        data: { kind: job.kind, attempt, maxAttempts: config.worker.maxAttempts, delayMs, error: message, runAfter: row.run_after },
      });
    });
    log('worker', `${job.kind} job ${job.id} failed (attempt ${attempt}): ${message}; retry in ${delayMs}ms`);
  }

  private async beat(): Promise<void> {
    try {
      await pool.query('update workers set heartbeat_at = now() where id = $1', [this.id]);
      await extendLeases(this.id, [...this.active.keys()]);
    } catch (err) {
      log('worker', `heartbeat failed: ${(err as Error).message}`);
    }
  }

  /**
   * Lets a restarted process resume a killed process's jobs immediately instead of waiting out its lease.
   * If the OS has recycled a dead worker's pid, its row still looks alive and those jobs simply wait for the
   * heartbeat to go stale — slower, never wrong.
   */
  private async reapDeadLocalWorkers(): Promise<void> {
    const { rows } = await pool.query<{ id: string; pid: number }>(
      'select id, pid from workers where host = $1 and stopped_at is null and id <> $2',
      [os.hostname(), this.id],
    );
    const dead = rows.filter((w) => !isProcessAlive(w.pid)).map((w) => w.id);
    if (dead.length === 0) return;
    await pool.query('update workers set stopped_at = now() where id = any($1::text[])', [dead]);
    log('worker', `marked ${dead.length} dead worker(s) as stopped: ${dead.join(', ')}`);
  }
}

async function setProspectError(db: Pick<typeof pool, 'query'>, job: ClaimedJob, message: string): Promise<void> {
  if (!job.prospect_id) return;
  // Deliberately no version bump: an error note must not invalidate a human's view of the task.
  await db.query('update prospects set last_error = $2, updated_at = now() where id = $1', [job.prospect_id, `${job.kind}: ${message}`]);
}

/** Exponential backoff with "equal jitter": never shorter than half the nominal delay. */
function backoffMs(attempt: number): number {
  const nominal = Math.min(config.worker.backoffMaxMs, config.worker.backoffBaseMs * 2 ** (attempt - 1));
  return Math.round(nominal / 2 + Math.random() * (nominal / 2));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
