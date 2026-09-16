// "Apollo rate limits and failures are handled without losing the run."
// The fake Apollo runs in this process; the agent runs in-process (scenarios a, c) or as a child process (b).
import './env.ts';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeApollo, type LedgerEntry } from './fake-apollo.ts';

const RETRY_AFTER_SEC = 2;
const LATENCY_MS: [number, number] = [10, 60];
const APOLLO_TIMEOUT_MS = 800;

const fake = await startFakeApollo({ latencyMs: LATENCY_MS, retryAfterSec: RETRY_AFTER_SEC, hangMs: 5_000, seed: 7 });

// src/config.ts reads the environment once, on first import, and the fake's port is only known now:
// point the app at the fake BEFORE loading any src module.
process.env.APOLLO_BASE_URL = fake.baseUrl;
process.env.APOLLO_TIMEOUT_MS = String(APOLLO_TIMEOUT_MS);
const { pool } = await import('../src/db.ts');
const { createRoom, retryJob } = await import('../src/domain/actions.ts');
const { Worker } = await import('../src/queue/worker.ts');
const { HUMANS, TEST_ICP, eventCounts, killAllApps, killApp, resetDb, rows, scalar, seedRoom, sleep, spawnApp, stageCount, waitFor } =
  await import('./helpers.ts');

after(async () => {
  await killAllApps();
  await fake.close();
  await pool.end();
});

async function createTestRoom(targetCount: number): Promise<string> {
  const created = await createRoom({ objective: 'Rate limit test', icp: TEST_ICP, targetCount, humans: HUMANS });
  assert.ok(created.ok, JSON.stringify(created));
  return created.value.roomId;
}

async function jobSummary(): Promise<string> {
  const summary = await rows('select kind, status, count(*)::int as n, max(last_error) as last_error from jobs group by 1, 2 order by 1, 2');
  return JSON.stringify(summary, null, 1);
}

function rateLimitedEvents(source: '429' | 'local'): Promise<number> {
  return scalar(`select count(*) from events where type = 'job.rate_limited' and data->>'source' = $1`, [source]);
}

function chargedMatches(ledger: LedgerEntry[], personId: string): number {
  return ledger.filter((e) => e.operation === 'people_match' && e.personId === personId && e.charged).length;
}

/**
 * A job.reclaimed event naming a worker that had not stopped yet means the queue handed one job to two claimers.
 * Without a crash that is the only way a single logical step can reach Apollo twice, so it is checked on its own:
 * the charge assertions below would otherwise report it as a mysterious duplicate call.
 */
async function assertNoConcurrentClaims(): Promise<void> {
  const stolen = await rows(
    `select e.job_id, e.created_at, e.data->>'previousWorker' as previous_worker, w.stopped_at
       from events e
       left join workers w on w.id = e.data->>'previousWorker'
      where e.type = 'job.reclaimed' and (w.stopped_at is null or w.stopped_at > e.created_at)`,
  );
  assert.deepEqual(stolen, [], 'a running job was claimed a second time while its first claimer was still alive');
}

/**
 * Requests the fake received after a 429 was answered but before its retry-after elapsed. Requests arriving within
 * `inFlightMs` of the 429 were already on the wire (or past the block check) when the 429 came back, so they are
 * not violations; `clockSlackMs` absorbs timestamp rounding at the far end of the window.
 */
function callsInsideRetryAfterWindows(ledger: LedgerEntry[], inFlightMs: number, clockSlackMs: number) {
  const time = (e: LedgerEntry) => Date.parse(e.at);
  const limited = ledger.filter((e) => e.status === 429);
  return ledger.flatMap((call) =>
    limited
      .filter((l) => {
        const gap = time(call) - time(l);
        return gap > inFlightMs && gap < RETRY_AFTER_SEC * 1000 - clockSlackMs;
      })
      .map((l) => ({ limited: l, call })),
  );
}

test('a. scripted 429 x3, 500 x2, a timeout, then 20% 429 / 10% 500: the run completes and respects retry-after', async (t) => {
  await resetDb();
  fake.reset();
  fake.setControl({ script: ['429', '429', '429', '500', '500', 'timeout'], fail429Rate: 0.2, fail500Rate: 0.1 });
  const roomId = await createTestRoom(10);

  const worker = new Worker();
  await worker.start();
  try {
    await waitFor(async () => (await stageCount(roomId, 'awaiting_review')) === 10, {
      timeoutMs: 90_000,
      what: '10 prospects awaiting review',
      diagnostics: () => 'see job summary below',
    }).catch(async (err: Error) => {
      throw new Error(`${err.message}\n${await jobSummary()}`);
    });
  } finally {
    await worker.stop();
  }

  const ledger = fake.ledger();
  const injected = (kind: string) => ledger.filter((e) => e.injected === kind).length;
  assert.equal(injected('429') >= 3 && injected('500') >= 2 && injected('timeout') === 1, true, `faults ${JSON.stringify(ledger)}`);

  assert.equal(await scalar(`select count(*) from jobs where status = 'dead'`), 0, await jobSummary());
  assert.equal(await scalar(`select count(*) from jobs where status <> 'succeeded'`), 0, await jobSummary());
  assert.equal(await scalar(`select count(*) from provider_limits where provider = 'apollo' and blocked_until is not null`), 1);
  const limitedBy429 = await rateLimitedEvents('429');
  const retries = await scalar(`select count(*) from events where type = 'job.retry_scheduled'`);
  assert.ok(limitedBy429 >= 3, `job.rate_limited(source 429) events: ${limitedBy429}`);
  assert.ok(retries >= 3, `job.retry_scheduled events: ${retries}`);

  const violations = callsInsideRetryAfterWindows(ledger, LATENCY_MS[1] + 100, 100);
  assert.deepEqual(violations, [], 'an Apollo request was sent while a retry-after window was open');

  // The same rule from the app's own records. A ledger row is committed before its request goes out, so a row
  // started after a block was recorded (100ms covers the two transactions overlapping) is a call that ignored it.
  const ignoredBlocks = await rows(
    `select c.logical_key, c.started_at, e.created_at as blocked_at, e.data->>'runAfter' as blocked_until
       from events e
       join external_calls c
         on c.provider = 'apollo'
        and c.started_at > e.created_at + interval '100 milliseconds'
        and c.started_at < (e.data->>'runAfter')::timestamptz
      where e.type = 'job.rate_limited' and e.data->>'source' = '429'`,
  );
  assert.deepEqual(ignoredBlocks, [], 'a call was started while the provider block from a 429 was still in force');

  // The run really landed, not just the prospect rows: every prospect has its enrichment and its first draft.
  assert.equal(await scalar('select count(*) from enrichments where room_id = $1', [roomId]), 10);
  assert.equal(
    await scalar(
      `select count(*) from drafts d join prospects p on p.id = d.prospect_id where p.room_id = $1 and d.revision = 1`,
      [roomId],
    ),
    10,
  );

  // No crash here, so every prospect's enrichment was paid for exactly once despite the faults.
  await assertNoConcurrentClaims();
  const prospects = await rows<{ apollo_person_id: string }>('select apollo_person_id from prospects where room_id = $1', [roomId]);
  for (const p of prospects) assert.equal(chargedMatches(ledger, p.apollo_person_id), 1, p.apollo_person_id);

  t.diagnostic(
    `apollo requests=${ledger.length} injected 429=${injected('429')} 500=${injected('500')} timeout=${injected('timeout')}; ` +
      `job.rate_limited(429)=${limitedBy429} job.rate_limited(local)=${await rateLimitedEvents('local')} job.retry_scheduled=${retries}`,
  );
});

test('b. local budget (APOLLO_LIMIT_PER_MINUTE=4): exactly 4 calls, the rest deferred rather than failed', async (t) => {
  await resetDb();
  fake.reset();
  await createTestRoom(10);

  // A separate process, because the budget is read from the environment once at start-up.
  const app = spawnApp({ APOLLO_BASE_URL: fake.baseUrl, APOLLO_LIMIT_PER_MINUTE: '4' });
  try {
    await waitFor(() => fake.ledger().length >= 4, { timeoutMs: 30_000, what: '4 Apollo calls', diagnostics: app.output });
    await waitFor(async () => (await rateLimitedEvents('local')) > 0, {
      timeoutMs: 10_000,
      what: 'a local-budget deferral',
      diagnostics: app.output,
    });
    const firstCallAt = Date.parse(fake.ledger()[0]!.at);
    await sleep(Math.max(0, firstCallAt + 6_000 - Date.now()));

    assert.equal(fake.ledger().length, 4, `calls seen by Apollo within 6s: ${JSON.stringify(fake.ledger())}`);
    assert.equal(await scalar(`select count(*) from external_calls where provider = 'apollo'`), 4);
    assert.equal(await scalar(`select count(*) from jobs where status = 'dead'`), 0, await jobSummary());
    const [reason] = await rows<{ reason: string }>(
      `select data->>'reason' as reason from events where type = 'job.rate_limited' and data->>'source' = 'local' limit 1`,
    );
    assert.match(reason!.reason, /local budget: 4\/4 calls in the last minute/);
    const deferred = await scalar(`select count(*) from jobs where status = 'pending' and deferrals > 0 and run_after > now()`);
    assert.ok(deferred > 0, await jobSummary());
    // A deferral is not a failure: the fake injected no faults here, so no job may have burnt a retry attempt.
    assert.equal(await scalar('select count(*) from jobs where attempts > 0'), 0, await jobSummary());
    t.diagnostic(`apollo calls in 6s=${fake.ledger().length}; jobs deferred to the next minute=${deferred}; local deferral events=${await rateLimitedEvents('local')}`);
  } finally {
    await killApp(app, 'SIGTERM');
  }
});

test('c. a permanent failure kills only its own job; the others finish; a human retry requeues it', async (t) => {
  await resetDb();
  fake.reset();
  const unknownPerson = 'fake_person_999'; // not in the fake dataset: people/match answers {person: null}
  const { roomId, prospects } = await seedRoom({
    stage: 'new',
    apolloPersonIds: ['fake_person_001', 'fake_person_002', unknownPerson, 'fake_person_004', 'fake_person_005'],
  });
  const bad = prospects.find((p) => p.apolloPersonId === unknownPerson)!;
  const deadEvents = () => scalar(`select count(*) from events where type = 'job.dead' and job_id = $1`, [bad.jobId]);

  const firstWorker = new Worker();
  await firstWorker.start();
  try {
    await waitFor(async () => (await stageCount(roomId, 'awaiting_review')) === 4 && (await deadEvents()) === 1, {
      timeoutMs: 30_000,
      what: '4 prospects awaiting review and 1 dead job',
    });
  } finally {
    await firstWorker.stop();
  }

  const [job] = await rows<{ status: string; last_error: string }>('select status, last_error from jobs where id = $1', [bad.jobId]);
  assert.equal(job!.status, 'dead');
  assert.match(job!.last_error, /no match/);
  const [badProspect] = await rows<{ stage: string; last_error: string | null }>('select stage, last_error from prospects where id = $1', [bad.id]);
  assert.equal(badProspect!.stage, 'new');
  assert.match(badProspect!.last_error ?? '', /^enrich: .*no match/);
  const [deadEvent] = await rows<{ permanent: boolean }>(
    `select (data->>'permanent')::boolean as permanent from events where type = 'job.dead' and job_id = $1`,
    [bad.jobId],
  );
  assert.equal(deadEvent!.permanent, true);
  assert.equal(await scalar(`select count(*) from jobs where status = 'dead'`), 1);

  await assertNoConcurrentClaims();
  const ledger = fake.ledger();
  assert.equal(ledger.filter((e) => e.personId === unknownPerson).length, 1, 'a permanent failure must not be retried automatically');
  for (const p of prospects.filter((p) => p !== bad)) {
    const charged = chargedMatches(ledger, p.apolloPersonId);
    assert.equal(charged, 1, `${p.apolloPersonId}: ${charged} charged people/match calls for a single enrich attempt (enriched twice?)`);
  }

  const retried = await retryJob(bad.jobId, 'alice');
  assert.ok(retried.ok, JSON.stringify(retried));
  assert.equal(retried.value.status, 'pending');
  assert.equal(retried.value.attempts, 0);
  const [cleared] = await rows<{ last_error: string | null }>('select last_error from prospects where id = $1', [bad.id]);
  assert.equal(cleared!.last_error, null);
  assert.equal((await eventCounts('job_id', bad.jobId))['job.retried_by_human'], 1);

  // The requeued job really runs again (and, the person still being unknown, fails again).
  const secondWorker = new Worker();
  await secondWorker.start();
  try {
    await waitFor(async () => (await deadEvents()) === 2, { timeoutMs: 30_000, what: 'the retried job to run again' });
  } finally {
    await secondWorker.stop();
  }
  const unknownCalls = fake.ledger().filter((e) => e.personId === unknownPerson).length;
  assert.equal(unknownCalls, 2, `expected one Apollo call per attempt (first run + the human retry), saw ${unknownCalls}`);
  assert.equal(await stageCount(roomId, 'awaiting_review'), 4);
  t.diagnostic(`dead job ${bad.jobId} retried by alice and re-run; other prospects awaiting review=4`);
});
