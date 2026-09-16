import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { pool, resetTestDatabase, withTx, type Tx } from '../src/db.ts';
import type { Icp, JobStatus, Stage } from '../src/domain/types.ts';

export { sleep };

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const HUMANS = [
  { handle: 'alice', displayName: 'Alice' },
  { handle: 'bob', displayName: 'Bob' },
];

/** Matches well over 10 people in the fake Apollo dataset, so one search page fills a 10-prospect room. */
export const TEST_ICP: Icp = {
  description: 'Sales and revenue leaders (fake Apollo dataset)',
  pitch: 'We cut manual prospect research so reps spend their time selling',
  filters: { person_titles: ['Sales', 'Revenue'] },
};

export function resetDb(): Promise<void> {
  return resetTestDatabase();
}

// ------------------------------------------------------------------------------------------- queries

export async function rows<T extends object>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query<T>(sql, params)).rows;
}

/** First column of the first row, as a number (for `select count(*) ...`). */
export async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const { rows: result } = await pool.query(sql, params);
  const first = result[0] as Record<string, unknown> | undefined;
  return Number(first ? Object.values(first)[0] : 0);
}

export async function dbNow(): Promise<Date> {
  return (await pool.query<{ now: Date }>('select now() as now')).rows[0]!.now;
}

export function stageCount(roomId: string, stage: Stage): Promise<number> {
  return scalar('select count(*) from prospects where room_id = $1 and stage = $2', [roomId, stage]);
}

/** Event counts by type, for the events matching `column = id`. */
export async function eventCounts(column: 'prospect_id' | 'job_id' | 'room_id', id: string): Promise<Record<string, number>> {
  const result = await rows<{ type: string; n: number }>(
    `select type, count(*)::int as n from events where ${column} = $1 group by type order by type`,
    [id],
  );
  return Object.fromEntries(result.map((r) => [r.type, r.n]));
}

// ------------------------------------------------------------------------------------------- waiting

export interface WaitOptions {
  timeoutMs: number;
  what: string;
  intervalMs?: number;
  /** Appended to the timeout error, e.g. a child process's output. */
  diagnostics?: () => string;
}

type Truthy<T> = Exclude<T, false | 0 | '' | null | undefined>;

export async function waitFor<T>(probe: () => T | Promise<T>, opts: WaitOptions): Promise<Truthy<T>> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as Truthy<T>;
    if (Date.now() > deadline) {
      const extra = opts.diagnostics ? `\n--- diagnostics ---\n${opts.diagnostics()}` : '';
      throw new Error(`Timed out after ${opts.timeoutMs}ms waiting for ${opts.what}${extra}`);
    }
    await sleep(opts.intervalMs ?? 25);
  }
}

// ------------------------------------------------------------------------------------------- seeding

export type Owner = 'agent' | 'alice' | 'bob';

export interface SeedOptions {
  prospects?: number;
  /** 'new': enrich job open. 'enriched': enrichment + draft job open. 'awaiting_review': enrichment + draft r1. */
  stage?: 'new' | 'enriched' | 'awaiting_review';
  owner?: Owner;
  /** Status of the open job for 'new' / 'enriched' prospects. */
  openJobStatus?: Extract<JobStatus, 'pending' | 'dead'>;
  apolloPersonIds?: string[];
}

export interface SeededProspect {
  id: string;
  version: number;
  apolloPersonId: string;
  draftBody: string | null;
  /** The enrich job for 'new', the draft job for 'enriched'/'awaiting_review'. */
  jobId: string;
}

export interface SeededRoom {
  roomId: string;
  memberIds: Record<Owner, string>;
  prospects: SeededProspect[];
}

/**
 * Inserts a room and its prospects directly in SQL, already at the requested stage, with the enrichment, draft,
 * ledger and job rows that stage implies. No search job is created, so a worker only sees the seeded work.
 */
export function seedRoom(opts: SeedOptions = {}): Promise<SeededRoom> {
  const count = opts.prospects ?? 1;
  const stage = opts.stage ?? 'awaiting_review';
  const ids = opts.apolloPersonIds ?? Array.from({ length: count }, (_, i) => `fake_person_${String(i + 1).padStart(3, '0')}`);

  return withTx(async (tx) => {
    const room = await tx.query<{ id: string }>('insert into rooms (objective, icp, target_count) values ($1, $2, $3) returning id', [
      'Seeded test room',
      JSON.stringify(TEST_ICP),
      count,
    ]);
    const roomId = room.rows[0]!.id;
    const members = await tx.query<{ id: string; handle: Owner }>(
      `insert into members (room_id, handle, display_name, kind)
       values ($1, 'alice', 'Alice', 'human'), ($1, 'bob', 'Bob', 'human'), ($1, 'agent', 'Prospecting agent', 'agent')
       returning id, handle`,
      [roomId],
    );
    const memberIds = Object.fromEntries(members.rows.map((m) => [m.handle, m.id])) as Record<Owner, string>;
    await tx.query('update rooms set agent_member_id = $2 where id = $1', [roomId, memberIds.agent]);

    const prospects: SeededProspect[] = [];
    for (const [index, apolloPersonId] of ids.entries()) {
      prospects.push(await seedProspect(tx, roomId, memberIds[opts.owner ?? 'agent'], index + 1, apolloPersonId, stage, opts.openJobStatus));
    }
    return { roomId, memberIds, prospects };
  });
}

async function seedProspect(
  tx: Tx,
  roomId: string,
  ownerId: string,
  position: number,
  apolloPersonId: string,
  stage: NonNullable<SeedOptions['stage']>,
  openJobStatus: SeedOptions['openJobStatus'] = 'pending',
): Promise<SeededProspect> {
  const name = `Person ${position}`;
  const error = openJobStatus === 'dead' ? 'seeded permanent failure' : null;
  const inserted = await tx.query<{ id: string; version: number }>(
    `insert into prospects (room_id, position, apollo_person_id, stage, owner_member_id, display_name, title, company, search_result, last_error)
     values ($1, $2, $3, $4, $5, $6, 'VP of Sales', 'Example Co', $7, $8)
     returning id, version`,
    [roomId, position, apolloPersonId, stage, ownerId, name, JSON.stringify({ id: apolloPersonId, first_name: name }), error],
  );
  const { id, version } = inserted.rows[0]!;

  const insertJob = async (kind: 'enrich' | 'draft', key: string, status: JobStatus, payload: object = {}) => {
    const job = await tx.query<{ id: string }>(
      `insert into jobs (room_id, prospect_id, kind, idempotency_key, payload, status, last_error, finished_at)
       values ($1, $2, $3, $4, $5, $6, $7, case when $6 in ('succeeded', 'dead') then now() end)
       returning id`,
      [roomId, id, kind, key, JSON.stringify(payload), status, status === 'dead' ? error : null],
    );
    return job.rows[0]!.id;
  };

  if (stage === 'new') {
    const jobId = await insertJob('enrich', `enrich:${id}`, openJobStatus);
    return { id, version, apolloPersonId, draftBody: null, jobId };
  }

  await insertJob('enrich', `enrich:${id}`, 'succeeded');
  const call = await tx.query<{ id: string }>(
    `insert into external_calls (provider, operation, logical_key, room_id, prospect_id, status, http_status, finished_at)
     values ('apollo', 'people_match', $1, $2, $3, 'succeeded', 200, now())
     returning id`,
    [`apollo.people_match:${id}`, roomId, id],
  );
  const person = { id: apolloPersonId, name, first_name: name, title: 'VP of Sales', organization: { name: 'Example Co' } };
  await tx.query(
    `insert into enrichments (prospect_id, room_id, apollo_person_id, person, organization, external_call_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [id, roomId, apolloPersonId, JSON.stringify(person), JSON.stringify(person.organization), call.rows[0]!.id],
  );

  const draftPayload = { revision: 1, awaitLinkedIn: false };
  if (stage === 'enriched') {
    const jobId = await insertJob('draft', `draft:${id}:1`, openJobStatus, draftPayload);
    return { id, version, apolloPersonId, draftBody: null, jobId };
  }

  const draftBody = `Hi ${name}, noticed you're VP of Sales at Example Co.\nWorth a quick chat?`;
  await tx.query(`insert into drafts (prospect_id, revision, body, generator) values ($1, 1, $2, 'template')`, [id, draftBody]);
  const jobId = await insertJob('draft', `draft:${id}:1`, 'succeeded', draftPayload);
  return { id, version, apolloPersonId, draftBody, jobId };
}

// ------------------------------------------------------------------------------------------- app processes

export interface AppProcess {
  child: ChildProcess;
  pid: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  hasExited(): boolean;
  /** The tail of the process's stdout + stderr. */
  output(): string;
}

const OUTPUT_LIMIT = 64_000;
const liveApps = new Set<AppProcess>();

/** Runs `node --import tsx src/main.ts` from the repo root, inheriting the test env plus `env`. */
export function spawnApp(env: Record<string, string> = {}): AppProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (child.pid === undefined) throw new Error('failed to spawn the app');

  let buffer = '';
  // Always drain the pipes: a child blocked on a full stdout pipe would stall and skew timing.
  const capture = (chunk: Buffer) => {
    buffer = (buffer + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
  };
  child.stdout!.on('data', capture);
  child.stderr!.on('data', capture);

  let done = false;
  const app: AppProcess = {
    child,
    pid: child.pid,
    exited: new Promise((resolve) =>
      child.once('exit', (code, signal) => {
        done = true;
        liveApps.delete(app);
        resolve({ code, signal });
      }),
    ),
    hasExited: () => done,
    output: () => buffer,
  };
  liveApps.add(app);
  return app;
}

/** Kills the app and proves the OS process is gone. On Windows every signal is TerminateProcess (a hard kill). */
export async function killApp(app: AppProcess, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
  if (!app.hasExited()) app.child.kill(signal);
  await Promise.race([
    app.exited,
    sleep(10_000).then(() => {
      throw new Error(`pid ${app.pid} did not exit within 10s of ${signal}`);
    }),
  ]);
  await waitFor(() => !isProcessAlive(app.pid), { timeoutMs: 5_000, what: `pid ${app.pid} to disappear` });
}

export async function killAllApps(): Promise<void> {
  await Promise.all([...liveApps].map((app) => killApp(app)));
}

// Last line of defence if a test crashes out without its after() hook: never leave an orphaned worker running.
process.once('exit', () => {
  for (const app of liveApps) app.child.kill('SIGKILL');
});

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Waits for the app's worker to register itself (the `workers` row carries the OS pid). */
export function waitForWorker(app: AppProcess, since: Date, timeoutMs = 30_000): Promise<{ id: string; started_at: Date }> {
  return waitFor(
    async () => {
      if (app.hasExited()) throw new Error(`app (pid ${app.pid}) exited before its worker started:\n${app.output()}`);
      const found = await rows<{ id: string; started_at: Date }>(
        'select id, started_at from workers where pid = $1 and started_at >= $2 order by started_at desc limit 1',
        [app.pid, since],
      );
      return found[0];
    },
    { timeoutMs, what: `worker of pid ${app.pid} to register`, diagnostics: app.output },
  );
}
