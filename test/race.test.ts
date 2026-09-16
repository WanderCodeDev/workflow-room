// "Two humans acting on the same task at once can't both win."
// Every scenario fires both actions concurrently (separate pooled connections, 0-3ms random jitter to vary the
// interleaving) many times, then checks the invariants in the DATABASE, not just the return values.
import './env.ts';
import { after, before, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pool } from '../src/db.ts';
import {
  approveProspect,
  claimProspect,
  handBackProspect,
  pauseRoom,
  retryJob,
  skipProspect,
} from '../src/domain/actions.ts';
import type { ActionErrorCode, ActionResult, JobRow, ProspectRow } from '../src/domain/types.ts';
import { REPO_ROOT, eventCounts, resetDb, rows, scalar, seedRoom } from './helpers.ts';

const ITERATIONS = 40;

before(resetDb);
after(() => pool.end());

type Side = 'alice' | 'bob';

/**
 * Varies the interleaving by a random number of no-op database round trips. A timer cannot do this here: Windows
 * timers fire on a ~15ms tick, which is ~50x one round trip, so every "jittered" call would start in the same tick
 * and the two actions would always reach their locks in the same structural order.
 */
async function withJitter<T>(action: () => Promise<T>, maxRoundTrips: number): Promise<T> {
  const trips = Math.floor(Math.random() * (maxRoundTrips + 1));
  for (let i = 0; i < trips; i++) await pool.query('select 1');
  return action();
}

/** `secondHandicap` holds the second action back when it would otherwise always reach its lock first. */
function concurrently<A, B>(first: () => Promise<A>, second: () => Promise<B>, secondHandicap = 0): Promise<[A, B]> {
  return Promise.all([withJitter(first, 3), withJitter(second, 3 + secondHandicap)]);
}

/** Asserts exactly one side succeeded and the other was refused with `loserCode`; returns the winner. */
function singleWinner(alice: ActionResult<unknown>, bob: ActionResult<unknown>, loserCode: ActionErrorCode = 'conflict'): Side {
  const detail = JSON.stringify({ alice, bob });
  assert.equal(Number(alice.ok) + Number(bob.ok), 1, `expected exactly one winner: ${detail}`);
  const loser = alice.ok ? bob : alice;
  assert.equal(loser.ok ? null : loser.code, loserCode, `loser should get "${loserCode}": ${detail}`);
  return alice.ok ? 'alice' : 'bob';
}

async function prospectRow(id: string): Promise<ProspectRow> {
  return (await rows<ProspectRow>('select * from prospects where id = $1', [id]))[0]!;
}

function report(t: TestContext, wins: Record<string, number>): void {
  t.diagnostic(`${ITERATIONS} concurrent rounds, winners: ${JSON.stringify(wins)}`);
}

test('a. alice.claim vs bob.claim: one owner, one version bump, one claimed + one rejected event', async (t) => {
  const wins = { alice: 0, bob: 0 };
  for (let i = 0; i < ITERATIONS; i++) {
    const { prospects: [p], memberIds } = await seedRoom({ stage: 'awaiting_review' });
    const [a, b] = await concurrently(
      () => claimProspect(p!.id, 'alice', p!.version),
      () => claimProspect(p!.id, 'bob', p!.version),
    );
    const winner = singleWinner(a, b);
    wins[winner]++;

    const row = await prospectRow(p!.id);
    assert.equal(row.owner_member_id, memberIds[winner]);
    assert.equal(row.version, p!.version + 1);
    assert.deepEqual(await eventCounts('prospect_id', p!.id), { 'action.rejected': 1, 'task.claimed': 1 });
  }
  report(t, wins);
});

test("b. alice.approve(edited) vs bob.approve: one approval, final_note is the winner's text", async (t) => {
  const wins = { alice: 0, bob: 0 };
  for (let i = 0; i < ITERATIONS; i++) {
    const { prospects: [p], memberIds } = await seedRoom({ stage: 'awaiting_review' });
    const aliceText = `Alice's edited note #${i}\nSecond line.`;
    const [a, b] = await concurrently(
      () => approveProspect(p!.id, 'alice', p!.version, aliceText),
      () => approveProspect(p!.id, 'bob', p!.version),
    );
    const winner = singleWinner(a, b);
    wins[winner]++;

    const row = await prospectRow(p!.id);
    assert.equal(row.stage, 'approved');
    assert.equal(row.final_note, winner === 'alice' ? aliceText : p!.draftBody);
    assert.equal(row.decided_by, memberIds[winner]);
    assert.equal(row.version, p!.version + 1);
    assert.deepEqual(await eventCounts('prospect_id', p!.id), { 'action.rejected': 1, 'task.approved': 1 });
  }
  report(t, wins);
});

test('c. alice.approve vs bob.skip: exactly one terminal decision, matching the winner', async (t) => {
  const wins = { alice: 0, bob: 0 };
  for (let i = 0; i < ITERATIONS; i++) {
    const { prospects: [p], memberIds } = await seedRoom({ stage: 'awaiting_review' });
    const [a, b] = await concurrently(
      () => approveProspect(p!.id, 'alice', p!.version),
      () => skipProspect(p!.id, 'bob', p!.version, 'not a fit'),
    );
    const winner = singleWinner(a, b);
    wins[winner]++;

    const row = await prospectRow(p!.id);
    assert.equal(row.stage, winner === 'alice' ? 'approved' : 'skipped');
    assert.equal(row.final_note, winner === 'alice' ? p!.draftBody : null);
    assert.equal(row.decided_by, memberIds[winner]);
    assert.equal(row.version, p!.version + 1);
    const decision = winner === 'alice' ? 'task.approved' : 'task.skipped';
    assert.deepEqual(await eventCounts('prospect_id', p!.id), { 'action.rejected': 1, [decision]: 1 });
  }
  report(t, wins);
});

test('d. alice.claim vs bob.approve: either alice owns an undecided task, or bob approved it', async (t) => {
  const wins = { alice: 0, bob: 0 };
  for (let i = 0; i < ITERATIONS; i++) {
    const { prospects: [p], memberIds } = await seedRoom({ stage: 'awaiting_review' });
    const [a, b] = await concurrently(
      () => claimProspect(p!.id, 'alice', p!.version),
      () => approveProspect(p!.id, 'bob', p!.version),
    );
    const winner = singleWinner(a, b);
    wins[winner]++;

    const row = await prospectRow(p!.id);
    assert.equal(row.version, p!.version + 1);
    if (winner === 'alice') {
      assert.equal(row.stage, 'awaiting_review');
      assert.equal(row.owner_member_id, memberIds.alice);
      assert.equal(row.decided_at, null);
      assert.deepEqual(await eventCounts('prospect_id', p!.id), { 'action.rejected': 1, 'task.claimed': 1 });
    } else {
      assert.equal(row.stage, 'approved');
      assert.equal(row.decided_by, memberIds.bob);
      assert.deepEqual(await eventCounts('prospect_id', p!.id), { 'action.rejected': 1, 'task.approved': 1 });
    }
  }
  report(t, wins);
});

test('e. bob.pauseRoom vs alice.approve: an approval is never recorded after the pause', async (t) => {
  const outcomes = { approvedBeforePause: 0, rejectedAsPaused: 0 };
  for (let i = 0; i < ITERATIONS; i++) {
    const { roomId, prospects: [p], memberIds } = await seedRoom({ stage: 'awaiting_review' });
    // approve makes more round trips than pause before it reaches the room lock; the handicap lets both orders occur.
    const [approve, pause] = await concurrently(
      () => approveProspect(p!.id, 'alice', p!.version),
      () => pauseRoom(roomId, 'bob'),
      2,
    );
    assert.ok(pause.ok, `pause must always succeed: ${JSON.stringify(pause)}`);

    const [room] = await rows<{ status: string }>('select status from rooms where id = $1', [roomId]);
    assert.equal(room!.status, 'paused');
    const events = await rows<{ id: string; type: string }>(
      `select id, type from events where room_id = $1 and type in ('room.paused', 'task.approved') order by id`,
      [roomId],
    );
    const pausedIds = events.filter((e) => e.type === 'room.paused').map((e) => BigInt(e.id));
    const approvedIds = events.filter((e) => e.type === 'task.approved').map((e) => BigInt(e.id));
    assert.equal(pausedIds.length, 1);

    const row = await prospectRow(p!.id);
    if (approve.ok) {
      outcomes.approvedBeforePause++;
      assert.equal(approvedIds.length, 1);
      assert.ok(approvedIds[0]! < pausedIds[0]!, `task.approved (${approvedIds[0]}) must precede room.paused (${pausedIds[0]})`);
      assert.equal(row.stage, 'approved');
      assert.equal(row.decided_by, memberIds.alice);
    } else {
      outcomes.rejectedAsPaused++;
      assert.equal(approve.code, 'room_paused', JSON.stringify(approve));
      assert.equal(approvedIds.length, 0);
      assert.equal(row.stage, 'awaiting_review');
      assert.equal(row.version, p!.version);
    }
  }
  report(t, outcomes);
});

// Which side of e wins is up to the scheduler, so e alone could in principle exercise one branch only. These two
// orderings are forced, so both branches are checked on every run.
test('e2. pause vs approve, forced both ways: an approval before the pause stands, one after it is refused', async () => {
  const approvedThenPaused = await seedRoom({ stage: 'awaiting_review' });
  const first = approvedThenPaused.prospects[0]!;
  const approveFirst = await approveProspect(first.id, 'alice', first.version);
  assert.ok(approveFirst.ok, JSON.stringify(approveFirst));
  assert.ok((await pauseRoom(approvedThenPaused.roomId, 'bob')).ok);
  const order = await rows<{ type: string }>(
    `select type from events where room_id = $1 and type in ('task.approved', 'room.paused') order by id`,
    [approvedThenPaused.roomId],
  );
  assert.deepEqual(order.map((e) => e.type), ['task.approved', 'room.paused']);

  const pausedThenApproved = await seedRoom({ stage: 'awaiting_review' });
  const second = pausedThenApproved.prospects[0]!;
  assert.ok((await pauseRoom(pausedThenApproved.roomId, 'bob')).ok);
  const approveAfter = await approveProspect(second.id, 'alice', second.version);
  assert.equal(approveAfter.ok, false, JSON.stringify(approveAfter));
  assert.equal(approveAfter.ok ? null : approveAfter.code, 'room_paused');
  const row = await prospectRow(second.id);
  assert.equal(row.stage, 'awaiting_review');
  assert.equal(row.version, second.version);
  assert.equal(row.final_note, null);
  assert.equal(
    await scalar(`select count(*) from events where room_id = $1 and type = 'task.approved'`, [pausedThenApproved.roomId]),
    0,
  );
});

test('f. owner alice.handBack(note) vs alice.approve on the same version: one wins; a hand-back queues exactly one revision-2 draft', async (t) => {
  const wins = { handBack: 0, approve: 0 };
  for (let i = 0; i < ITERATIONS; i++) {
    const { prospects: [p], memberIds } = await seedRoom({ stage: 'awaiting_review', owner: 'alice' });
    const [handBack, approve] = await concurrently(
      () => handBackProspect(p!.id, 'alice', p!.version, 'Mention their recent funding round'),
      () => approveProspect(p!.id, 'alice', p!.version),
    );
    const handBackWon = singleWinner(handBack, approve) === 'alice';
    wins[handBackWon ? 'handBack' : 'approve']++;

    const row = await prospectRow(p!.id);
    const revision2Jobs = await rows<JobRow>(`select * from jobs where prospect_id = $1 and idempotency_key = $2`, [
      p!.id,
      `draft:${p!.id}:2`,
    ]);
    assert.equal(row.version, p!.version + 1);
    if (handBackWon) {
      assert.equal(row.stage, 'enriched');
      assert.equal(row.draft_revision, 2);
      assert.equal(row.owner_member_id, memberIds.agent);
      assert.equal(revision2Jobs.length, 1);
      assert.equal(revision2Jobs[0]!.status, 'pending');
      assert.deepEqual(await eventCounts('prospect_id', p!.id), { 'action.rejected': 1, 'task.handed_back': 1 });
    } else {
      assert.equal(row.stage, 'approved');
      assert.equal(row.draft_revision, 1);
      assert.equal(revision2Jobs.length, 0);
      assert.deepEqual(await eventCounts('prospect_id', p!.id), { 'action.rejected': 1, 'task.approved': 1 });
    }
  }
  report(t, wins);
});

test('g. alice.retryJob vs bob.retryJob on the same dead job: requeued exactly once', async (t) => {
  const wins = { alice: 0, bob: 0 };
  for (let i = 0; i < ITERATIONS; i++) {
    const { prospects: [p] } = await seedRoom({ stage: 'new', openJobStatus: 'dead' });
    const [a, b] = await concurrently(
      () => retryJob(p!.jobId, 'alice'),
      () => retryJob(p!.jobId, 'bob'),
    );
    wins[singleWinner(a, b)]++;

    const [job] = await rows<JobRow>('select * from jobs where id = $1', [p!.jobId]);
    assert.equal(job!.status, 'pending');
    assert.equal(job!.attempts, 0);
    assert.equal(job!.last_error, null);
    assert.equal((await prospectRow(p!.id)).last_error, null);
    assert.deepEqual(await eventCounts('job_id', p!.jobId), { 'action.rejected': 1, 'job.retried_by_human': 1 });
  }
  report(t, wins);
});

// The races above are all refused by the row lock alone. This one isolates the version guard: the task is free to
// act on (the agent owns it again), so only the stale expectedVersion can refuse bob.
test('h. a stale expectedVersion is refused even when the task is otherwise actionable', async () => {
  const { prospects: [p] } = await seedRoom({ stage: 'awaiting_review' });
  const claimed = await claimProspect(p!.id, 'alice', p!.version);
  assert.ok(claimed.ok, JSON.stringify(claimed));
  const handedBack = await handBackProspect(p!.id, 'alice', claimed.value.version);
  assert.ok(handedBack.ok, JSON.stringify(handedBack));
  const current = handedBack.value.version;
  assert.equal(current, p!.version + 2);
  assert.equal(handedBack.value.stage, 'awaiting_review');

  const stale = await approveProspect(p!.id, 'bob', claimed.value.version, 'Bob acts on what he last saw');
  assert.equal(stale.ok, false, `a stale version must be refused: ${JSON.stringify(stale)}`);
  assert.equal(stale.ok ? null : stale.code, 'conflict');
  assert.match(stale.ok ? '' : stale.message, /version/i);
  const untouched = await prospectRow(p!.id);
  assert.equal(untouched.stage, 'awaiting_review');
  assert.equal(untouched.final_note, null);
  assert.equal(untouched.version, current);

  // The same action with the current version succeeds, so the refusal above was the stale view and nothing else.
  const fresh = await approveProspect(p!.id, 'bob', current, 'Bob acts on what he last saw');
  assert.ok(fresh.ok, JSON.stringify(fresh));
  assert.equal(fresh.value.stage, 'approved');
  assert.deepEqual(await eventCounts('prospect_id', p!.id), {
    'action.rejected': 1,
    'task.approved': 1,
    'task.claimed': 1,
    'task.handed_back': 1,
  });
});

const httpModule = path.join(REPO_ROOT, 'src', 'server', 'http.ts');

test(
  'HTTP: two concurrent POST /api/prospects/:id/claim requests -> one 200, one 409',
  { skip: existsSync(httpModule) ? false : 'src/server/http.ts does not exist yet' },
  async (t) => {
    // Loaded by URL so the suite (and `tsc`) doesn't depend on the web layer existing.
    const { startHttpServer } = (await import(pathToFileURL(httpModule).href)) as {
      startHttpServer(port: number): Promise<{ port: number; close(): unknown }>;
    };
    // Port 0: the OS hands out a free port and the server reports which, so concurrent test runs cannot collide.
    const server = await startHttpServer(0);
    const { port } = server;
    const wins = { alice: 0, bob: 0 };
    try {
      for (let i = 0; i < ITERATIONS; i++) {
        const { prospects: [p], memberIds } = await seedRoom({ stage: 'awaiting_review' });
        const claim = (actor: Side) => () =>
          fetch(`http://127.0.0.1:${port}/api/prospects/${p!.id}/claim`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ actor, expectedVersion: p!.version }),
          });
        const [a, b] = await concurrently(claim('alice'), claim('bob'));
        assert.deepEqual([a.status, b.status].sort(), [200, 409], `statuses ${a.status} / ${b.status}`);
        const winner: Side = a.status === 200 ? 'alice' : 'bob';
        wins[winner]++;
        const loserBody = (await (winner === 'alice' ? b : a).json()) as { error?: string };
        assert.equal(loserBody.error, 'conflict');
        await (winner === 'alice' ? a : b).body?.cancel();

        const row = await prospectRow(p!.id);
        assert.equal(row.owner_member_id, memberIds[winner]);
        assert.equal(row.version, p!.version + 1);
        assert.deepEqual(await eventCounts('prospect_id', p!.id), { 'action.rejected': 1, 'task.claimed': 1 });
      }
    } finally {
      await server.close();
    }
    report(t, wins);
  },
);
