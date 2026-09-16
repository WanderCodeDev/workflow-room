import { parseArgs } from 'node:util';
import { config } from './config.ts';
import { migrate, pool } from './db.ts';
import {
  approveProspect,
  claimProspect,
  createRoom,
  handBackProspect,
  pauseRoom,
  resumeRoom,
  retryJob,
  skipProspect,
  type CreateRoomInput,
} from './domain/actions.ts';
import { DEFAULT_HUMANS, PRESETS } from './domain/presets.ts';
import { getRoomSnapshot, listRooms, type EventView, type JobView, type RoomSnapshot } from './domain/snapshot.ts';
import { STAGES, type ActionResult, type ApolloSearchFilters, type ProspectRow, type Stage } from './domain/types.ts';

const USAGE = `Usage: npm run cli -- <command> [options]

  rooms                                           list rooms
  presets                                         list ICP presets
  create --preset <id> [--humans alice:Alice,bob:Bob]
  create --objective <text> --icp <description> [--pitch <text>] [--titles "A,B"]
         [--locations "X;Y"] [--employees "51,200;201,500"] [--keywords <text>] [--target 10] [--humans ..]
  status <roomId>                                 room, Apollo status and tasks
  claim|approve|skip|handback <taskId> --as <handle> [--version N] [--text ..] [--note ..] [--reason ..]
  pause|resume <roomId> --as <handle>
  retry <jobId> --as <handle>                     jobs ids for dead jobs are listed by "status"
  events <roomId> [--follow]

  <taskId> is a prospect uuid or "<roomId>#<position>".
  --version is the task version you last looked at. If omitted, the current version is read first,
  which skips stale-view protection: you act on the task as it is now, even if it changed since you looked.
  --json prints raw JSON for rooms, presets, status and events.`;

const OPTIONS = {
  preset: { type: 'string' },
  humans: { type: 'string' },
  objective: { type: 'string' },
  icp: { type: 'string' },
  pitch: { type: 'string' },
  titles: { type: 'string' },
  locations: { type: 'string' },
  employees: { type: 'string' },
  keywords: { type: 'string' },
  target: { type: 'string' },
  as: { type: 'string' },
  version: { type: 'string' },
  text: { type: 'string' },
  note: { type: 'string' },
  reason: { type: 'string' },
  follow: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_STAGE: Record<Stage, string> = {
  new: 'new',
  enriched: 'enriched',
  awaiting_review: 'review',
  approved: 'approved',
  skipped: 'skipped',
};
const TASK_OPTION: Record<string, 'text' | 'note' | 'reason' | undefined> = {
  approve: 'text',
  handback: 'note',
  skip: 'reason',
};

/** An expected failure: printed as a one-line message, never with a stack trace. */
class CliError extends Error {}

async function main(argv: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    throw new CliError(`${(err as Error).message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const [command, target, ...extra] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return;
  }
  if (extra.length > 0) throw new CliError(`Unexpected arguments: ${extra.join(' ')}`);
  await migrate();

  switch (command) {
    case 'rooms':
      return cmdRooms(values);
    case 'presets':
      return cmdPresets(values);
    case 'create':
      return cmdCreate(values);
    case 'status':
      return cmdStatus(required(target, '<roomId>'), values);
    case 'claim':
    case 'approve':
    case 'skip':
    case 'handback':
      return cmdTask(command, required(target, '<taskId>'), values);
    case 'pause':
    case 'resume':
      return cmdRoomStatus(command, required(target, '<roomId>'), values);
    case 'retry':
      return cmdRetry(required(target, '<jobId>'), values);
    case 'events':
      return cmdEvents(required(target, '<roomId>'), values);
    default:
      throw new CliError(`Unknown command "${command}"\n\n${USAGE}`);
  }
}

// ------------------------------------------------------------------------------------------- commands

async function cmdRooms(values: Values): Promise<void> {
  const rooms = await listRooms();
  if (values.json) return printJson(rooms);
  if (rooms.length === 0) return console.log('No rooms yet. Create one: npm run cli -- create --preset <id>');
  printTable(
    ['ID', 'STATUS', 'FOUND', 'STAGES', 'HUMANS', 'OBJECTIVE'],
    rooms.map((r) => [
      r.id,
      r.status,
      `${STAGES.reduce((n, s) => n + r.stageCounts[s], 0)}/${r.targetCount}`,
      stageSummary(r.stageCounts),
      r.humans.join(','),
      clip(r.objective, 60),
    ]),
  );
}

function cmdPresets(values: Values): void {
  const presets = Object.entries(PRESETS).map(([id, preset]) => ({ id, ...preset }));
  if (values.json) return printJson(presets);
  printTable(
    ['ID', 'LABEL', 'TARGET'],
    presets.map((p) => [p.id, p.label, String(p.room.targetCount ?? 10)]),
  );
}

async function cmdCreate(values: Values): Promise<void> {
  const humans = values.humans ? parseHumans(values.humans) : DEFAULT_HUMANS;
  let input: CreateRoomInput;
  if (values.preset) {
    const preset = Object.hasOwn(PRESETS, values.preset) ? PRESETS[values.preset] : undefined;
    if (!preset) throw new CliError(`Unknown preset "${values.preset}". Available: ${Object.keys(PRESETS).join(', ')}`);
    input = { ...preset.room, humans };
  } else {
    input = {
      objective: required(values.objective, '--objective (or --preset)'),
      icp: {
        description: required(values.icp, '--icp'),
        ...(values.pitch ? { pitch: values.pitch } : {}),
        filters: buildFilters(values),
      },
      targetCount: values.target === undefined ? undefined : toInt(values.target, '--target'),
      humans,
    };
  }
  const { roomId } = unwrap(await createRoom(input));
  // Only the id goes to stdout, so `ROOM=$(npm run -s cli -- create ...)` works.
  console.log(roomId);
  console.error(`created. UI: http://localhost:${config.port}/?room=${roomId}&as=${humans[0]?.handle ?? ''}`);
}

async function cmdStatus(roomId: string, values: Values): Promise<void> {
  const snap = await loadSnapshot(roomId);
  if (values.json) return printJson(snap);
  const { room } = snap;
  const now = Date.parse(snap.serverTime);
  const humans = snap.members.filter((m) => m.kind === 'human').map((m) => m.handle);

  console.log(room.objective);
  console.log(`room ${room.id} · ${room.status} · target ${room.targetCount} · humans ${humans.join(', ')}`);
  console.log(`icp: ${room.icp.description}`);
  console.log(`stages: ${stageSummary(snap.stageCounts)}`);
  for (const p of snap.providers) console.log(`${p.provider}: ${providerLine(p, now)}`);
  console.log(`calls: ${snap.calls.map((c) => `${c.provider} ${c.status} ${c.count}`).join(', ') || 'none yet'}`);
  console.log(`search: ${snap.roomJobs.map((j) => jobSummary(j, now)).join(', ') || 'none'}`);
  console.log('');

  if (snap.prospects.length === 0) console.log('No prospects yet.');
  else {
    printTable(
      ['#', 'STAGE', 'OWNER', 'VER', 'NAME', 'ROLE', 'OPEN JOBS', 'LAST ERROR'],
      snap.prospects.map((p) => [
        String(p.position),
        SHORT_STAGE[p.stage],
        p.ownerHandle,
        String(p.version),
        clip(p.displayName, 24),
        clip([p.title, p.company].filter(Boolean).join(' @ '), 40),
        openJobs(p.jobs).map((j) => jobSummary(j, now)).join(' ') || '-',
        clip(p.lastError, 50) || '-',
      ]),
    );
  }

  const dead = [...snap.roomJobs, ...snap.prospects.flatMap((p) => p.jobs)].filter((j) => j.status === 'dead');
  if (dead.length > 0) {
    console.log(`\ndead jobs (npm run cli -- retry <jobId> --as <handle>):`);
    for (const j of dead) {
      const position = snap.prospects.find((p) => p.id === j.prospectId)?.position;
      console.log(`  ${j.id}  ${j.kind}${position ? ` #${position}` : ''}  ${clip(j.lastError, 80)}`);
    }
  }
}

async function cmdTask(command: string, ref: string, values: Values): Promise<void> {
  const actor = required(values.as, '--as <handle>');
  for (const option of ['text', 'note', 'reason'] as const) {
    if (values[option] !== undefined && TASK_OPTION[command] !== option) {
      throw new CliError(`--${option} does not apply to "${command}"`);
    }
  }
  const task = await resolveTask(ref);
  let version: number;
  if (values.version === undefined) {
    version = task.version;
    console.error(`note: no --version given; acting on current version ${version} (stale-view protection skipped)`);
  } else {
    version = toInt(values.version, '--version');
  }

  const result: ActionResult<ProspectRow> =
    command === 'claim'
      ? await claimProspect(task.id, actor, version)
      : command === 'approve'
        ? await approveProspect(task.id, actor, version, values.text)
        : command === 'skip'
          ? await skipProspect(task.id, actor, version, values.reason)
          : await handBackProspect(task.id, actor, version, values.note);
  const p = unwrap(result);
  console.log(`#${p.position} ${command}: ok · stage ${SHORT_STAGE[p.stage]} · version ${p.version}`);
}

async function cmdRoomStatus(command: 'pause' | 'resume', roomId: string, values: Values): Promise<void> {
  const actor = required(values.as, '--as <handle>');
  if (!UUID.test(roomId)) throw new CliError(`"${roomId}" is not a room id`);
  const room = unwrap(command === 'pause' ? await pauseRoom(roomId, actor) : await resumeRoom(roomId, actor));
  console.log(`room ${room.id}: ${room.status}`);
}

async function cmdRetry(jobId: string, values: Values): Promise<void> {
  const job = unwrap(await retryJob(jobId, required(values.as, '--as <handle>')));
  console.log(`job ${job.id} (${job.kind}): ${job.status}`);
}

async function cmdEvents(roomId: string, values: Values): Promise<void> {
  let lastId = 0;
  const printNew = (snap: RoomSnapshot) => {
    const positions = new Map(snap.prospects.map((p) => [p.id, p.position]));
    for (const event of [...snap.events].reverse()) {
      if (event.id <= lastId) continue;
      console.log(values.json ? JSON.stringify(event) : formatEvent(event, positions));
      lastId = event.id;
    }
  };
  printNew(await loadSnapshot(roomId));
  if (values.follow) await follow(roomId, async () => printNew(await loadSnapshot(roomId)));
}

/** Re-reads the room on every NOTIFY for it until Ctrl+C. Runs are serialized so output stays ordered. */
async function follow(roomId: string, onChange: () => Promise<void>): Promise<void> {
  const client = await pool.connect();
  let chain = Promise.resolve();
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    chain = chain
      .then(() => {
        queued = false;
        return onChange();
      })
      .catch((err: Error) => console.error(`error: ${err.message}`));
  };

  let failure: Error | undefined;
  const stopped = new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
    client.on('error', (err) => {
      failure = err;
      resolve();
    });
  });
  client.on('notification', (msg) => {
    try {
      if ((JSON.parse(msg.payload ?? '{}') as { roomId?: string }).roomId === roomId) schedule();
    } catch {
      // not ours to interpret
    }
  });
  await client.query('listen room_events');
  console.error('following; Ctrl+C to stop');
  await stopped;
  await chain;
  client.release(failure);
  if (failure) throw new CliError(`lost the database connection: ${failure.message}`);
}

// ------------------------------------------------------------------------------------------- helpers

async function loadSnapshot(roomId: string): Promise<RoomSnapshot> {
  if (!UUID.test(roomId)) throw new CliError(`"${roomId}" is not a room id`);
  return (await getRoomSnapshot(roomId)) ?? fail(`Room ${roomId} not found`);
}

async function resolveTask(ref: string): Promise<{ id: string; version: number }> {
  const byPosition = /^([^#]+)#(\d+)$/.exec(ref);
  const uuid = byPosition ? byPosition[1]! : ref;
  if (!UUID.test(uuid)) throw new CliError(`"${ref}" is not a task id (use a prospect uuid or <roomId>#<position>)`);
  const { rows } = byPosition
    ? await pool.query<{ id: string; version: number }>(
        'select id, version from prospects where room_id = $1 and position = $2',
        [uuid, Number(byPosition[2])],
      )
    : await pool.query<{ id: string; version: number }>('select id, version from prospects where id = $1', [uuid]);
  return rows[0] ?? fail(`Task ${ref} not found`);
}

function buildFilters(values: Values): ApolloSearchFilters {
  const filters: ApolloSearchFilters = {};
  const titles = splitList(values.titles, ',');
  if (titles.length > 0) {
    filters.person_titles = titles;
    filters.include_similar_titles = true;
  }
  const locations = splitList(values.locations, ';');
  if (locations.length > 0) filters.person_locations = locations;
  const employees = splitList(values.employees, ';');
  if (employees.some((range) => !/^\d+,\d+$/.test(range))) {
    throw new CliError('--employees takes ranges like "51,200;201,500"');
  }
  if (employees.length > 0) filters.organization_num_employees_ranges = employees;
  if (values.keywords?.trim()) filters.q_keywords = values.keywords.trim();
  return filters;
}

function parseHumans(spec: string): CreateRoomInput['humans'] {
  return splitList(spec, ',').map((entry) => {
    const [handle = '', ...name] = entry.split(':');
    return { handle: handle.trim(), displayName: name.join(':').trim() || handle.trim() };
  });
}

function openJobs(jobs: JobView[]): JobView[] {
  return jobs.filter((j) => j.status === 'pending' || j.status === 'running' || j.status === 'dead');
}

function jobSummary(job: JobView, now: number): string {
  const wait = Date.parse(job.runAfter) - now;
  const detail = [
    job.attempts > 0 ? `a${job.attempts}` : '',
    job.deferrals > 0 ? `d${job.deferrals}` : '',
    job.status === 'pending' && wait > 1000 ? `in ${Math.ceil(wait / 1000)}s` : '',
  ].filter(Boolean);
  return `${job.kind}:${job.status}${detail.length ? `(${detail.join(',')})` : ''}`;
}

function providerLine(p: RoomSnapshot['providers'][number], now: number): string {
  const parts: string[] = [];
  const blockedMs = p.blockedUntil ? Date.parse(p.blockedUntil) - now : 0;
  parts.push(blockedMs > 0 ? `BLOCKED ${Math.ceil(blockedMs / 1000)}s (${p.reason ?? 'rate limited'})` : 'ok');
  const h = p.lastHeaders ?? {};
  const left = [
    ['minute', h['x-minute-requests-left'], h['x-rate-limit-minute']],
    ['hour', h['x-hourly-requests-left'], h['x-rate-limit-hourly']],
    ['day', h['x-24-hour-requests-left'], h['x-rate-limit-24-hour']],
  ].filter(([, remaining]) => remaining !== undefined);
  if (left.length > 0) parts.push(`left ${left.map(([w, r, l]) => `${w} ${r}${l ? `/${l}` : ''}`).join(' · ')}`);
  return parts.join(' · ');
}

function stageSummary(counts: Record<Stage, number>): string {
  return STAGES.map((s) => `${SHORT_STAGE[s]} ${counts[s]}`).join(' · ');
}

function formatEvent(event: EventView, positions: Map<string, number>): string {
  const time = new Date(event.createdAt).toLocaleTimeString('en-GB', { hour12: false });
  const position = event.prospectId ? positions.get(event.prospectId) : undefined;
  // An action rejected for a non-member has no member row to join, so the handle only survives in the data.
  const actor = event.actorHandle ?? (typeof event.data.actor === 'string' ? event.data.actor : null);
  const subject = `${actor ?? 'agent'}${position ? ` #${position}` : ''}`;
  return `${time}  ${event.type.padEnd(21)} ${subject.padEnd(10)} ${describeData(event)}`.trimEnd();
}

function describeData(event: EventView): string {
  const d = event.data;
  if (event.type === 'action.rejected') return `${fmt(d.action)} rejected (${fmt(d.code)}): ${fmt(d.message)}`;
  const hidden = new Set(['icp', 'actor']);
  return Object.entries(d)
    .filter(([key, value]) => !hidden.has(key) && value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${fmt(value)}`)
    .join(' ');
}

function fmt(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return clip(text, 90);
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => (row[i] ?? '').length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  console.log(line(headers));
  for (const row of rows) console.log(line(row));
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function clip(text: string | null | undefined, max: number): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function splitList(value: string | undefined, separator: string): string[] {
  return (value ?? '')
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toInt(value: string, name: string): number {
  if (!/^-?\d+$/.test(value)) throw new CliError(`${name} must be an integer, got "${value}"`);
  return Number(value);
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') throw new CliError(`missing ${name}\n\n${USAGE}`);
  return value;
}

function unwrap<T>(result: ActionResult<T>): T {
  if (!result.ok) throw new CliError(`${result.code}: ${result.message}`);
  return result.value;
}

function fail(message: string): never {
  throw new CliError(message);
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  process.exitCode = 1;
  console.error(err instanceof CliError ? `error: ${err.message}` : ((err as Error).stack ?? String(err)));
} finally {
  await pool.end();
}
