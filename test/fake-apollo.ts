/**
 * Local fake of the Apollo.io REST API (people search + people match) with
 * deterministic fault injection. Used by the crash-recovery, race and
 * rate-limit suites, and to run the demo without a real key. The wire format
 * (paths, params, bodies, rate headers, 401/429 payloads) mirrors docs.apollo.io.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FAKE_PEOPLE, findFakePerson, toMatchPerson, toSearchHit } from './fake-apollo-data.ts';

export interface FakeApolloOptions {
  /** 0 = random free port. */
  port?: number;
  /** Default 'fake-key'. */
  apiKey?: string;
  /** Default 50/200/600 (Apollo free plan). */
  limits?: { minute: number; hour: number; day: number };
  /** Uniform response latency range, default [20, 80]. */
  latencyMs?: [number, number];
  fail429Rate?: number;
  fail500Rate?: number;
  failTimeoutRate?: number;
  /** How long a 'timeout' fault holds the socket before dropping it, default 30000. */
  hangMs?: number;
  /** retry-after for injected 429s, default 2. */
  retryAfterSec?: number;
  seed?: number;
  /** Append every ledger entry as a JSON line here, so it outlives the process. */
  ledgerFile?: string;
}

export type FaultKind = 'ok' | '429' | '500' | 'timeout';

export interface LedgerEntry {
  seq: number;
  /** ISO timestamp of when the request was judged (before latency). */
  at: string;
  operation: 'people_search' | 'people_match' | 'unknown';
  personId: string | null;
  /** 0 when the connection was dropped without a response. */
  status: number;
  /** 'ok' marks a scripted pass-through; null means nothing was injected. */
  injected: FaultKind | 'limit' | 'auth' | null;
  charged: boolean;
}

export type ControlPatch = Partial<
  Pick<FakeApolloOptions, 'latencyMs' | 'fail429Rate' | 'fail500Rate' | 'failTimeoutRate' | 'retryAfterSec' | 'limits'>
> & {
  /** Replaces the pending script; each request consumes one entry. */
  script?: FaultKind[];
};

export interface FakeApollo {
  /** e.g. http://127.0.0.1:4010/api/v1 */
  baseUrl: string;
  port: number;
  ledger(): LedgerEntry[];
  setControl(patch: ControlPatch): void;
  /** Clears the ledger, usage windows and script, and restores the start-up control. */
  reset(): void;
  close(): Promise<void>;
}

type Limits = NonNullable<FakeApolloOptions['limits']>;
type Params = Record<string, unknown>;

interface Control {
  latencyMs: [number, number];
  fail429Rate: number;
  fail500Rate: number;
  failTimeoutRate: number;
  retryAfterSec: number;
  limits: Limits;
  script: FaultKind[];
}

interface RateWindow {
  key: keyof Limits;
  ms: number;
  unit: string;
  limitHeader: string;
  usageHeader: string;
  leftHeader: string;
}

type Verdict =
  | { type: 'ok'; injected: 'ok' | null }
  | { type: 'auth' }
  | { type: 'limit'; window: RateWindow; retryAfterSec: number }
  | { type: 'fault'; kind: '429' | '500' | 'timeout' };

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  charged?: boolean;
}

const API_PREFIX = '/api/v1';
const DEFAULT_PORT = 4010;
const UPGRADE_URL = 'https://app.apollo.io/#/settings/plans/upgrade';

const WINDOWS: readonly RateWindow[] = [
  {
    key: 'minute',
    ms: 60_000,
    unit: 'minute',
    limitHeader: 'x-rate-limit-minute',
    usageHeader: 'x-minute-usage',
    leftHeader: 'x-minute-requests-left',
  },
  {
    key: 'hour',
    ms: 3_600_000,
    unit: 'hour',
    limitHeader: 'x-rate-limit-hourly',
    usageHeader: 'x-hourly-usage',
    leftHeader: 'x-hourly-requests-left',
  },
  {
    key: 'day',
    ms: 86_400_000,
    unit: 'day',
    limitHeader: 'x-rate-limit-24-hour',
    usageHeader: 'x-24-hour-usage',
    leftHeader: 'x-24-hour-requests-left',
  },
];
const LONGEST_WINDOW_MS = 86_400_000;

const FAULT_KINDS: readonly FaultKind[] = ['ok', '429', '500', 'timeout'];

export async function startFakeApollo(opts: FakeApolloOptions = {}): Promise<FakeApollo> {
  const apiKey = opts.apiKey ?? 'fake-key';
  const hangMs = opts.hangMs ?? 30_000;
  const seed = opts.seed ?? 1;
  const ledgerFile = opts.ledgerFile === undefined ? null : resolve(opts.ledgerFile);
  if (ledgerFile) mkdirSync(dirname(ledgerFile), { recursive: true });

  const initialControl = (): Control => ({
    latencyMs: opts.latencyMs ? [...opts.latencyMs] : [20, 80],
    fail429Rate: opts.fail429Rate ?? 0,
    fail500Rate: opts.fail500Rate ?? 0,
    failTimeoutRate: opts.failTimeoutRate ?? 0,
    retryAfterSec: opts.retryAfterSec ?? 2,
    limits: { minute: 50, hour: 200, day: 600, ...opts.limits },
    script: [],
  });

  let control = initialControl();
  let entries: LedgerEntry[] = [];
  /** Arrival times of every rate-counted request (all but auth failures), ascending. */
  let usage: number[] = [];
  // Separate streams so changing latency never shifts which requests get faults.
  let faultRng = mulberry32(seed);
  let latencyRng = mulberry32(seed ^ 0x9e3779b9);

  const sockets = new Set<Socket>();
  const timers = new Set<NodeJS.Timeout>();

  function schedule(ms: number, fn: () => void): NodeJS.Timeout {
    const timer = setTimeout(() => {
      timers.delete(timer);
      fn();
    }, ms);
    timers.add(timer);
    return timer;
  }

  function delay(ms: number): Promise<void> {
    return ms <= 0 ? Promise.resolve() : new Promise((done) => schedule(ms, done));
  }

  function usageIn(window: RateWindow, now: number): number[] {
    return usage.filter((t) => t > now - window.ms);
  }

  function rateHeaders(now: number): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const window of WINDOWS) {
      const limit = control.limits[window.key];
      const used = usageIn(window, now).length;
      headers[window.limitHeader] = String(limit);
      headers[window.usageHeader] = String(used);
      headers[window.leftHeader] = String(Math.max(0, limit - used));
    }
    return headers;
  }

  function checkLimits(now: number): Verdict | null {
    let worst: Extract<Verdict, { type: 'limit' }> | null = null;
    for (const window of WINDOWS) {
      const limit = control.limits[window.key];
      const inWindow = usageIn(window, now);
      if (inWindow.length < limit) continue;
      // Rejected calls count too, so enough of the oldest must age out for one more call to fit.
      const unblockedBy = inWindow[inWindow.length - limit] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((unblockedBy + window.ms - now) / 1000));
      if (!worst || retryAfterSec > worst.retryAfterSec) worst = { type: 'limit', window, retryAfterSec };
    }
    return worst;
  }

  function judge(req: IncomingMessage, operation: LedgerEntry['operation'], now: number): Verdict {
    if (req.headers['x-api-key'] !== apiKey) return { type: 'auth' };
    // A stray probe (GET /, a typo'd path) must not consume a scripted fault or a random draw.
    if (operation === 'unknown') return { type: 'ok', injected: null };

    const scripted = control.script.shift();
    if (scripted !== undefined) return scripted === 'ok' ? { type: 'ok', injected: 'ok' } : { type: 'fault', kind: scripted };

    const limited = checkLimits(now);
    if (limited) return limited;

    const roll = faultRng();
    let threshold = control.fail429Rate;
    if (roll < threshold) return { type: 'fault', kind: '429' };
    threshold += control.fail500Rate;
    if (roll < threshold) return { type: 'fault', kind: '500' };
    threshold += control.failTimeoutRate;
    if (roll < threshold) return { type: 'fault', kind: 'timeout' };
    return { type: 'ok', injected: null };
  }

  function record(entry: Omit<LedgerEntry, 'seq' | 'at'>, now: number): void {
    const full: LedgerEntry = { seq: entries.length + 1, at: new Date(now).toISOString(), ...entry };
    entries.push(full);
    if (entry.injected !== 'auth') usage.push(now);
    while (usage.length > 0 && (usage[0] ?? now) <= now - LONGEST_WINDOW_MS) usage.shift();
    // Synchronous so the entry is on disk before the client can observe the response.
    if (ledgerFile) appendFileSync(ledgerFile, `${JSON.stringify(full)}\n`);
  }

  function limitMessage(endpoint: string, limit: number, unit: string): string {
    return `The maximum number of api calls allowed for ${endpoint} is ${limit} times per ${unit}. Please upgrade your plan from ${UPGRADE_URL}.`;
  }

  function serveOperation(operation: LedgerEntry['operation'], params: Params | null): Reply {
    if (operation === 'unknown') return { status: 404, body: { error: 'Not Found' } };
    if (params === null) return { status: 400, body: { error: 'Invalid JSON body' } };
    if (operation === 'people_search') return { status: 200, body: searchPeople(params) };

    const person = typeof params.id === 'string' ? findFakePerson(params.id) : undefined;
    return person
      ? { status: 200, body: { person: toMatchPerson(person) }, charged: true }
      : { status: 200, body: { person: null } };
  }

  function replyFor(verdict: Exclude<Verdict, { type: 'fault'; kind: 'timeout' }>, endpoint: string, operation: LedgerEntry['operation'], params: Params | null): Reply {
    switch (verdict.type) {
      case 'auth':
        return { status: 401, body: { error: 'Invalid access credentials.' } };
      case 'limit':
        return {
          status: 429,
          body: { message: limitMessage(endpoint, control.limits[verdict.window.key], verdict.window.unit) },
          headers: { 'retry-after': String(verdict.retryAfterSec) },
        };
      case 'fault':
        return verdict.kind === '429'
          ? {
              status: 429,
              body: { message: limitMessage(endpoint, control.limits.minute, 'minute') },
              headers: { 'retry-after': String(control.retryAfterSec) },
            }
          : { status: 500, body: { error: 'Internal Server Error' } };
      case 'ok':
        return serveOperation(operation, params);
    }
  }

  function injectedFor(verdict: Verdict): LedgerEntry['injected'] {
    switch (verdict.type) {
      case 'ok':
        return verdict.injected;
      case 'auth':
      case 'limit':
        return verdict.type;
      case 'fault':
        return verdict.kind;
    }
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const body = parseBody(await readBody(req), req.headers['content-type']);
    const params = body === null ? null : mergeParams(parseQuery(url.searchParams), body);
    const operation = operationFor(req.method, url.pathname);
    const personId = operation === 'people_match' && typeof params?.id === 'string' ? params.id : null;
    const endpoint = url.pathname.replace(/^\/+/, '');

    // Judge and record synchronously: concurrent requests see a consistent usage window,
    // and a call counts (and charges) server-side even if the client dies during latency.
    const now = Date.now();
    const verdict = judge(req, operation, now);
    const injected = injectedFor(verdict);

    if (verdict.type === 'fault' && verdict.kind === 'timeout') {
      record({ operation, personId, status: 0, injected, charged: false }, now);
      hang(req.socket);
      return;
    }

    const reply = replyFor(verdict, endpoint, operation, params);
    record({ operation, personId, status: reply.status, injected, charged: reply.charged ?? false }, now);
    const headers = { ...rateHeaders(now), ...reply.headers };

    const [min, max] = control.latencyMs;
    await delay(Math.round(min + latencyRng() * Math.max(0, max - min)));
    sendJson(res, reply.status, reply.body, headers);
  }

  function hang(socket: Socket): void {
    if (socket.destroyed) return;
    const timer = schedule(hangMs, () => socket.destroy());
    socket.once('close', () => {
      clearTimeout(timer);
      timers.delete(timer);
    });
  }

  function snapshot(): Control {
    return { ...control, latencyMs: [...control.latencyMs], limits: { ...control.limits }, script: [...control.script] };
  }

  function setControl(patch: ControlPatch): void {
    const { script, limits, latencyMs, ...rates } = patch;
    control = {
      ...control,
      ...definedOnly(rates),
      ...(latencyMs ? { latencyMs: [...latencyMs] } : {}),
      ...(limits ? { limits: { ...control.limits, ...limits } } : {}),
      ...(script ? { script: [...script] } : {}),
    };
  }

  function reset(): void {
    control = initialControl();
    entries = [];
    usage = [];
    faultRng = mulberry32(seed);
    latencyRng = mulberry32(seed ^ 0x9e3779b9);
  }

  async function handleControl(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    switch (`${req.method} ${pathname}`) {
      case 'GET /__ledger':
        return sendJson(res, 200, { calls: [...entries] });
      case 'GET /__control':
        return sendJson(res, 200, snapshot());
      case 'POST /__control': {
        const body = parseBody(await readBody(req), 'application/json');
        try {
          if (body === null) throw new Error('Invalid JSON body');
          setControl(parseControlPatch(body, control.limits));
        } catch (err) {
          return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
        return sendJson(res, 200, snapshot());
      }
      case 'POST /__reset':
        reset();
        return sendJson(res, 200, snapshot());
      default:
        return sendJson(res, 404, { error: 'Not Found' });
    }
  }

  const server = createServer((req, res) => {
    // A malformed request target (e.g. `//[`) would otherwise throw out of the listener and crash the process.
    const target = req.url ?? '/';
    if (!URL.canParse(target, 'http://127.0.0.1')) return sendJson(res, 400, { error: 'Bad Request' });
    const url = new URL(target, 'http://127.0.0.1');
    const handled = url.pathname.startsWith('/__') ? handleControl(req, res, url.pathname) : handleApi(req, res, url);
    handled.catch((err: unknown) => {
      if (res.headersSent) res.destroy();
      else sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal Server Error' });
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((ready, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.off('error', fail);
      ready();
    });
  });

  const { port } = server.address() as AddressInfo;
  let closing: Promise<void> | null = null;

  return {
    baseUrl: `http://127.0.0.1:${port}${API_PREFIX}`,
    port,
    ledger: () => entries.map((entry) => ({ ...entry })),
    setControl,
    reset,
    close() {
      closing ??= new Promise<void>((done, fail) => {
        server.close((err) => (err ? fail(err) : done()));
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}

function wholeWord(term: string): RegExp {
  return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
}

function searchPeople(params: Params): { total_entries: number; people: ReturnType<typeof toSearchHit>[] } {
  const titles = stringList(params.person_titles).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const keywords = typeof params.q_keywords === 'string' ? params.q_keywords.trim().toLowerCase() : '';

  const matches = FAKE_PEOPLE.filter((person) => {
    const title = person.title.toLowerCase();
    // Whole words only, like Apollo: a plain substring match would make "CTO" match "Director".
    if (titles.length > 0 && !titles.some((wanted) => wholeWord(wanted).test(title))) return false;
    if (keywords === '') return true;
    // Real Apollo matches keywords against company text too, not just the title and company name.
    const org = person.organization;
    const haystack = [title, person.headline, org.name, org.industry, org.shortDescription, org.focus]
      .join(' ')
      .toLowerCase();
    return haystack.includes(keywords);
  });
  // Note: person_locations and organization_num_employees_ranges are accepted but not applied — this fake
  // exists to exercise the agent's failure/rate-limit handling, not to reimplement Apollo's filtering.

  const perPage = Math.min(100, Math.max(1, intParam(params.per_page, 25)));
  const page = Math.max(1, intParam(params.page, 1));
  const start = (page - 1) * perPage;
  return { total_entries: matches.length, people: matches.slice(start, start + perPage).map(toSearchHit) };
}

function operationFor(method: string | undefined, pathname: string): LedgerEntry['operation'] {
  if (method !== 'POST') return 'unknown';
  const path = pathname.replace(/\/+$/, '');
  if (path === `${API_PREFIX}/mixed_people/api_search`) return 'people_search';
  if (path === `${API_PREFIX}/people/match`) return 'people_match';
  return 'unknown';
}

/** Apollo encodes arrays as repeated `key[]=v`; a bare `key=v` stays scalar. */
function parseQuery(search: URLSearchParams): Params {
  const params: Params = {};
  for (const [rawKey, value] of search) {
    if (rawKey.endsWith('[]')) {
      const key = rawKey.slice(0, -2);
      const existing = params[key];
      params[key] = Array.isArray(existing) ? [...existing, value] : [value];
    } else {
      params[rawKey] = value;
    }
  }
  return params;
}

function mergeParams(query: Params, body: Params): Params {
  const merged = { ...query };
  for (const [key, value] of Object.entries(body)) merged[key.endsWith('[]') ? key.slice(0, -2) : key] = value;
  return merged;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

/** Returns null for a body that cannot be parsed. */
function parseBody(raw: string, contentType: string | undefined): Params | null {
  if (raw.trim() === '') return {};
  if (contentType?.includes('application/x-www-form-urlencoded')) return parseQuery(new URLSearchParams(raw));
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

function parseControlPatch(input: Params, currentLimits: Limits): ControlPatch {
  const patch: ControlPatch = {};
  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case 'fail429Rate':
      case 'fail500Rate':
      case 'failTimeoutRate':
        patch[key] = numberIn(value, key, 0, 1);
        break;
      case 'retryAfterSec':
        patch.retryAfterSec = numberIn(value, key, 0, Number.MAX_SAFE_INTEGER);
        break;
      case 'latencyMs': {
        if (!Array.isArray(value) || value.length !== 2) throw new Error('latencyMs must be [min, max]');
        const min = numberIn(value[0], 'latencyMs[0]', 0, Number.MAX_SAFE_INTEGER);
        const max = numberIn(value[1], 'latencyMs[1]', min, Number.MAX_SAFE_INTEGER);
        patch.latencyMs = [min, max];
        break;
      }
      case 'limits': {
        if (!isRecord(value)) throw new Error('limits must be an object');
        const limits = { ...currentLimits };
        for (const window of WINDOWS) {
          const limit = value[window.key];
          if (limit !== undefined) limits[window.key] = numberIn(limit, `limits.${window.key}`, 0, Number.MAX_SAFE_INTEGER);
        }
        patch.limits = limits;
        break;
      }
      case 'script':
        if (!Array.isArray(value) || !value.every(isFaultKind)) {
          throw new Error(`script must be an array of ${FAULT_KINDS.join(' | ')}`);
        }
        patch.script = value;
        break;
      default:
        throw new Error(`Unknown control field: ${key}`);
    }
  }
  return patch;
}

function numberIn(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return value;
}

function isFaultKind(value: unknown): value is FaultKind {
  return FAULT_KINDS.includes(value as FaultKind);
}

function isRecord(value: unknown): value is Params {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number').map(String);
  return typeof value === 'string' ? [value] : [];
}

function intParam(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isInteger(n) ? n : fallback;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// ---------------------------------------------------------------------------
// Standalone mode: `npm run fake-apollo`
// ---------------------------------------------------------------------------

function envNumber(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

function envRange(name: string): [number, number] | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const [min, max, ...rest] = raw.split(',').map((part) => Number(part.trim()));
  if (min === undefined || max === undefined || rest.length > 0 || !Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error(`${name} must be "min,max", got "${raw}"`);
  }
  return [min, max];
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = import.meta.url;
  const invoked = pathToFileURL(entry).href;
  // Windows drive letters may differ in case between the loader and argv.
  return process.platform === 'win32' ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
}

async function main(): Promise<void> {
  const fake = await startFakeApollo({
    port: envNumber('FAKE_APOLLO_PORT') ?? DEFAULT_PORT,
    apiKey: process.env.FAKE_APOLLO_API_KEY || undefined,
    fail429Rate: envNumber('FAKE_APOLLO_429_RATE'),
    fail500Rate: envNumber('FAKE_APOLLO_500_RATE'),
    failTimeoutRate: envNumber('FAKE_APOLLO_TIMEOUT_RATE'),
    latencyMs: envRange('FAKE_APOLLO_LATENCY_MS'),
    seed: envNumber('FAKE_APOLLO_SEED'),
    ledgerFile: process.env.FAKE_APOLLO_LEDGER || undefined,
  });
  process.stdout.write(`FAKE_APOLLO_READY ${fake.baseUrl}\n`);

  const shutdown = (): void => {
    fake.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (isEntrypoint()) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
