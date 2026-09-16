// Regression tests for job claiming. The claim query must hand a job to exactly one worker, must not steal
// from a live worker, and must reclaim from a dead one.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://postgres@localhost:5433/prospect_room_test';
process.env.HTTP_ENABLED ??= 'false';
process.env.WORKER_ENABLED ??= 'false';
process.env.LEASE_SECONDS ??= '30';
process.env.STALE_WORKER_SECONDS ??= '15';

const { pool, resetTestDatabase } = await import('../src/db.ts');
const { claimNext } = await import('../src/queue/queue.ts');
const { createRoom } = await import('../src/domain/actions.ts');

const WORKERS = Array.from({ length: 8 }, (_, i) => `test-worker-${i}`);
const ROUNDS = 60;
let jobId = '';

async function resetJob(): Promise<void> {
  await pool.query(
    `update jobs set status = 'pending', locked_by = null, lease_expires_at = null, run_after = now() where id = $1`,
    [jobId],
  );
  await pool.query(`update workers set heartbeat_at = now(), stopped_at = null where id = any($1::text[])`, [WORKERS]);
}

before(async () => {
  await resetTestDatabase();
  const room = await createRoom({
    objective: 'claim race regression',
    icp: { description: 'anyone', filters: {} },
    targetCount: 1,
    humans: [{ handle: 'alice', displayName: 'Alice' }],
  });
  assert.ok(room.ok, 'room created');
  const jobs = await pool.query<{ id: string }>('select id from jobs where room_id = $1', [room.value.roomId]);
  jobId = jobs.rows[0]!.id; // the room's initial Apollo search job
  for (const id of WORKERS) {
    await pool.query('insert into workers (id, host, pid) values ($1, $2, $3)', [id, 'test-host', process.pid]);
  }
});

after(async () => {
  await pool.end();
});

test('concurrent claims never hand the same job to two workers', async () => {
  for (let round = 0; round < ROUNDS; round++) {
    await resetJob();
    const claims = await Promise.all(WORKERS.map((worker) => claimNext(worker)));
    const winners = claims.filter((claim) => claim?.id === jobId);
    assert.equal(winners.length, 1, `round ${round}: ${winners.length} workers claimed the same job`);
  }
});

test('a job held by a live worker with a valid lease is left alone', async () => {
  await resetJob();
  const first = await claimNext(WORKERS[0]!);
  assert.equal(first?.id, jobId);
  await pool.query('update workers set heartbeat_at = now() where id = $1', [WORKERS[0]]);
  assert.equal(await claimNext(WORKERS[1]!), null, 'a live worker must not be robbed of its job');
});

test('a job is reclaimed when its worker stopped', async () => {
  await pool.query('update workers set stopped_at = now() where id = $1', [WORKERS[0]]);
  const reclaimed = await claimNext(WORKERS[1]!);
  assert.equal(reclaimed?.id, jobId);
  assert.equal(reclaimed?.prev_locked_by, WORKERS[0]);
  assert.equal(reclaimed?.prev_status, 'running');
});

test('a job is reclaimed when its worker stops heartbeating', async () => {
  await pool.query(
    `update workers set stopped_at = null, heartbeat_at = now() - make_interval(secs => $2::float8) where id = $1`,
    [WORKERS[1], Number(process.env.STALE_WORKER_SECONDS) * 3],
  );
  const reclaimed = await claimNext(WORKERS[2]!);
  assert.equal(reclaimed?.id, jobId);
  assert.equal(reclaimed?.prev_locked_by, WORKERS[1]);
});
