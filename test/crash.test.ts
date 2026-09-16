// "Kill the process mid-run, restart it, and it picks up where it was. Nothing gets enriched or drafted twice."
// The app runs as a child process and is hard-killed (SIGKILL; TerminateProcess on Windows) at varied moments.
// The fake Apollo runs in THIS process, so its ledger of what the provider actually saw survives every kill.
import './env.ts';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.ts';
import { createRoom } from '../src/domain/actions.ts';
import { startFakeApollo } from './fake-apollo.ts';
import {
  HUMANS,
  TEST_ICP,
  dbNow,
  killAllApps,
  killApp,
  resetDb,
  rows,
  scalar,
  sleep,
  spawnApp,
  stageCount,
  waitFor,
  waitForWorker,
  type AppProcess,
} from './helpers.ts';

const TARGET = 10;
const KILLS = 8;
const LEASE_SECONDS = 30;
const MAX_RESUME_MS = 10_000;
/** How long a kill trigger waits for its moment before killing anyway. */
const TRIGGER_TIMEOUT_MS = 15_000;

const fake = await startFakeApollo({ latencyMs: [250, 900], fail429Rate: 0.1, fail500Rate: 0.1, retryAfterSec: 1, seed: 20260916 });

const APP_ENV = {
  APOLLO_BASE_URL: fake.baseUrl,
  HTTP_ENABLED: 'false',
  WORKER_CONCURRENCY: '3',
  // Deliberately long: resuming well within it proves a restart reaps the killed worker instead of waiting out leases.
  LEASE_SECONDS: String(LEASE_SECONDS),
  JOB_MAX_ATTEMPTS: '30',
};

after(async () => {
  await killAllApps();
  await fake.close();
  await pool.end();
});

type KillMoment = 'mid-call' | 'timed' | 'after-progress' | 'running-job';
const KILL_MOMENTS: readonly KillMoment[] = ['mid-call', 'timed', 'after-progress', 'running-job'];

interface StartedApp {
  app: AppProcess;
  workerId: string;
  /** Worker start -> last orphaned job reclaimed; null when the previous kill left nothing running. */
  resumeMs: number | null;
}

const callInFlight = async (workerId: string) =>
  (await scalar(`select count(*) from external_calls where worker_id = $1 and status = 'started'`, [workerId])) > 0;
const jobRunning = async (workerId: string) =>
  (await scalar(`select count(*) from jobs where locked_by = $1 and status = 'running'`, [workerId])) > 0;
const succeededJobs = () => scalar(`select count(*) from jobs where status = 'succeeded'`);
const runFinished = async (roomId: string) => (await stageCount(roomId, 'awaiting_review')) === TARGET;

/** Waits for a kill moment, giving up as soon as the run finishes: there is then nothing left to interrupt. */
async function pollUntil(roomId: string, probe: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + TRIGGER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    if (await runFinished(roomId)) return false;
    await sleep(10);
  }
  return false;
}

/** Spawns the app and, if the previous kill orphaned running jobs, measures how fast they are reclaimed. */
async function startApp(orphanedJobIds: string[]): Promise<StartedApp> {
  const since = await dbNow();
  const app = spawnApp(APP_ENV);
  const worker = await waitForWorker(app, since);
  if (orphanedJobIds.length === 0) return { app, workerId: worker.id, resumeMs: null };

  // Waits past the lease on purpose, so a regression shows up as a resume time instead of a timeout.
  const lastReclaimAt = await waitFor(
    async () => {
      const [r] = await rows<{ n: number; last: Date | null }>(
        `select count(distinct job_id)::int as n, max(created_at) as last
           from events
          where type = 'job.reclaimed' and job_id = any($1::uuid[]) and created_at >= $2`,
        [orphanedJobIds, worker.started_at],
      );
      return r!.n === orphanedJobIds.length && r!.last;
    },
    { timeoutMs: 2 * LEASE_SECONDS * 1000, what: `${orphanedJobIds.length} orphaned job(s) to be reclaimed`, diagnostics: app.output },
  );
  return { app, workerId: worker.id, resumeMs: lastReclaimAt.getTime() - worker.started_at.getTime() };
}

/** Waits for the moment to pull the plug; returns a label for the report. */
async function waitForKillMoment(moment: KillMoment, iteration: number, roomId: string, started: StartedApp): Promise<string> {
  const label = (hit: boolean) => (hit ? moment : `${moment} (nothing left to interrupt)`);
  switch (moment) {
    case 'mid-call':
      return label(await pollUntil(roomId, () => callInFlight(started.workerId)));
    case 'running-job': {
      const hit = await pollUntil(roomId, () => jobRunning(started.workerId));
      await sleep(Math.floor(Math.random() * 150));
      return label(hit);
    }
    case 'after-progress': {
      const baseline = await succeededJobs();
      const progressed = await pollUntil(roomId, async () => (await succeededJobs()) > baseline);
      return label(progressed && (await pollUntil(roomId, () => callInFlight(started.workerId))));
    }
    case 'timed': {
      // Timed from the worker being ready, not from spawn (~1.5s of that is tsx start-up and migrations), and kept
      // short: eight restarts that each ran for seconds would finish the run before the last kills could land.
      const delayMs = 40 + ((iteration * 137) % 420);
      await sleep(delayMs);
      return `${moment} ${delayMs}ms after the worker was ready`;
    }
  }
}

test('SIGKILL mid-run 8 times: the run resumes each time and nothing is enriched or drafted twice', { timeout: 175_000 }, async () => {
  await resetDb();
  const created = await createRoom({ objective: 'Crash recovery test', icp: TEST_ICP, targetCount: TARGET, humans: HUMANS });
  assert.ok(created.ok, JSON.stringify(created));
  const { roomId } = created.value;

  const kills: { moment: string; runningJobs: number; callsInFlight: number }[] = [];
  const resumeMs: number[] = [];
  let orphanedJobIds: string[] = [];

  for (let i = 0; i < KILLS; i++) {
    const started = await startApp(orphanedJobIds);
    if (started.resumeMs !== null) resumeMs.push(started.resumeMs);
    const moment = await waitForKillMoment(KILL_MOMENTS[i % KILL_MOMENTS.length]!, i, roomId, started);
    assert.ok(
      (await stageCount(roomId, 'awaiting_review')) < TARGET,
      `the run finished before kill #${i + 1}; kills must land mid-run, so kill earlier`,
    );

    await killApp(started.app, 'SIGKILL');
    orphanedJobIds = (
      await rows<{ id: string }>(`select id from jobs where status = 'running' and locked_by = $1`, [started.workerId])
    ).map((r) => r.id);
    // Every earlier kill's jobs were waited for in startApp, so nothing but the process just killed can hold one.
    assert.equal(
      await scalar(`select count(*) from jobs where status = 'running' and locked_by <> $1`, [started.workerId]),
      0,
      'a job was left running by a worker other than the one just killed',
    );
    const callsInFlight = await scalar(`select count(*) from external_calls where worker_id = $1 and status = 'started'`, [started.workerId]);
    kills.push({ moment, runningJobs: orphanedJobIds.length, callsInFlight });
  }

  const final = await startApp(orphanedJobIds);
  if (final.resumeMs !== null) resumeMs.push(final.resumeMs);
  await waitFor(
    async () =>
      (await stageCount(roomId, 'awaiting_review')) === TARGET &&
      (await scalar(`select count(*) from jobs where status in ('pending', 'running')`)) === 0,
    { timeoutMs: 120_000, what: 'the run to complete after the last restart', diagnostics: final.app.output },
  );
  await killApp(final.app, 'SIGTERM');

  // --- the run finished, exactly once per prospect --------------------------------------------------------------
  const prospects = await rows<{ id: string; apollo_person_id: string; stage: string }>(
    'select id, apollo_person_id, stage from prospects where room_id = $1',
    [roomId],
  );
  assert.equal(prospects.length, TARGET);
  assert.deepEqual(prospects.filter((p) => p.stage !== 'awaiting_review'), []);

  assert.equal(await scalar('select count(*) from enrichments where room_id = $1', [roomId]), TARGET);
  const drafts = await rows<{ prospect_id: string; revision: number }>(
    'select d.prospect_id, d.revision from drafts d join prospects p on p.id = d.prospect_id where p.room_id = $1',
    [roomId],
  );
  assert.equal(drafts.length, TARGET);
  assert.equal(new Set(drafts.map((d) => d.prospect_id)).size, TARGET);
  assert.deepEqual(drafts.filter((d) => d.revision !== 1), []);

  const perProspect = await rows<{ id: string; enriched: number; drafted: number }>(
    `select p.id,
            count(e.id) filter (where e.type = 'enrich.completed')::int as enriched,
            count(e.id) filter (where e.type = 'draft.created')::int as drafted
       from prospects p
       left join events e on e.prospect_id = p.id
      where p.room_id = $1
      group by p.id`,
    [roomId],
  );
  for (const p of perProspect) {
    assert.equal(p.enriched, 1, `enrich.completed events for prospect ${p.id}`);
    assert.equal(p.drafted, 1, `draft.created events for prospect ${p.id}`);
  }

  // --- the queue recovered cleanly ------------------------------------------------------------------------------
  assert.equal(await scalar(`select count(*) from jobs where status = 'running'`), 0);
  assert.equal(await scalar(`select count(*) from jobs where status = 'dead'`), 0);
  const reclaimed = await scalar(`select count(*) from events where type = 'job.reclaimed'`);
  const orphaned = kills.reduce((total, k) => total + k.runningJobs, 0);
  assert.ok(reclaimed > 0, 'no kill interrupted in-flight work; make the kills more aggressive');
  // startApp waits for every orphaned job to be reclaimed before the next kill, so the counts must match exactly.
  // A surplus means a job was handed to a second claimer; a shortfall means a restart never picked the work up.
  assert.equal(reclaimed, orphaned, `${reclaimed} job.reclaimed events for ${orphaned} jobs orphaned by the kills`);

  // Leases here never expire (children live < LEASE_SECONDS and heartbeat), so the only legitimate takeover is from a
  // worker already marked dead. A takeover from a live worker means one job ran twice at the same time.
  const takenFromLiveWorker = await rows(
    `select e.job_id, e.created_at, e.data->>'previousWorker' as previous_worker, w.stopped_at
       from events e
       left join workers w on w.id = e.data->>'previousWorker'
      where e.type = 'job.reclaimed' and (w.stopped_at is null or w.stopped_at > e.created_at)`,
  );
  assert.deepEqual(takenFromLiveWorker, [], 'a running job was reclaimed from a worker that was still alive');
  // Every attempt killed mid-call is marked in_doubt by the next attempt; one still 'started' was never accounted for.
  const unresolvedCalls = await rows(`select id, logical_key, worker_id, started_at from external_calls where status = 'started'`);
  assert.deepEqual(unresolvedCalls, [], 'external call attempts left unresolved after the run completed');
  // An attempt is only left unfinished when its process dies, so whatever supersedes it belongs to a later process.
  // The same worker on both sides would mean two claimers ran one job at once inside one process.
  const supersededByItself = await rows(
    `select logical_key, worker_id from (
       select logical_key, worker_id, status,
              lead(worker_id) over (partition by logical_key order by started_at) as next_worker
         from external_calls
     ) attempts
     where status = 'in_doubt' and next_worker = worker_id`,
  );
  assert.deepEqual(supersededByItself, [], 'an in-doubt call was retried by the same worker: one job ran twice at once');

  assert.ok(resumeMs.length > 0, 'no restart had orphaned jobs to resume');
  for (const ms of resumeMs) {
    assert.ok(ms < MAX_RESUME_MS, `orphaned jobs took ${ms}ms to be reclaimed (lease is ${LEASE_SECONDS}s)`);
  }

  // --- what the provider saw: a duplicate charge only where the ledger admits the outcome was in doubt ------------
  const ledger = fake.ledger();
  const inDoubtByKey = new Map(
    (
      await rows<{ logical_key: string; n: number }>(
        `select logical_key, count(*)::int as n from external_calls where status = 'in_doubt' group by logical_key`,
      )
    ).map((r) => [r.logical_key, r.n]),
  );
  let duplicateCharges = 0;
  for (const p of prospects) {
    const charged = ledger.filter((e) => e.operation === 'people_match' && e.personId === p.apollo_person_id && e.charged).length;
    const allowed = 1 + (inDoubtByKey.get(`apollo.people_match:${p.id}`) ?? 0);
    assert.ok(charged >= 1 && charged <= allowed, `${p.apollo_person_id}: ${charged} charged people/match calls, at most ${allowed} allowed`);
    duplicateCharges += charged - 1;
  }

  const inDoubtCalls = [...inDoubtByKey.values()].reduce((sum, n) => sum + n, 0);
  const inDoubtRetries = await scalar(`select count(*) from events where type in ('search.in_doubt_retry', 'enrich.in_doubt_retry')`);
  console.log('[crash] kills:');
  for (const [i, k] of kills.entries()) {
    console.log(`  #${i + 1} ${k.moment.padEnd(32)} running jobs orphaned=${k.runningJobs} apollo calls in flight=${k.callsInFlight}`);
  }
  console.log(
    `[crash] kills=${kills.length} (with running jobs: ${kills.filter((k) => k.runningJobs > 0).length}) ` +
      `job.reclaimed=${reclaimed} in-doubt ledger rows=${inDoubtCalls} in-doubt retries=${inDoubtRetries} ` +
      `apollo requests=${ledger.length} charged people/match=${ledger.filter((e) => e.charged).length} ` +
      `duplicate charged calls=${duplicateCharges} resume after restart (ms)=[${resumeMs.join(', ')}]`,
  );
});
