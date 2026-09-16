import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { z } from 'zod';
import { config } from '../config.ts';
import { pool } from '../db.ts';
import { log } from '../log.ts';
import {
  approveProspect,
  claimProspect,
  createRoom,
  handBackProspect,
  pauseRoom,
  resumeRoom,
  retryJob,
  skipProspect,
} from '../domain/actions.ts';
import { DEFAULT_HUMANS, PRESETS } from '../domain/presets.ts';
import { getRoomSnapshot, listRooms } from '../domain/snapshot.ts';
import type { ActionErrorCode, ActionResult } from '../domain/types.ts';

const BODY_LIMIT_BYTES = 64 * 1024;
const SSE_HEARTBEAT_MS = 15_000;
const LISTEN_CHANNEL = 'room_events';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const STATUS_BY_CODE: Record<ActionErrorCode, number> = {
  conflict: 409,
  not_found: 404,
  forbidden: 403,
  room_paused: 423,
  invalid: 400,
};

export interface HttpServer {
  port: number;
  close(): Promise<void>;
}

/** An expected, client-caused failure that maps straight to a JSON error response. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------------------------------- validation

const handleSchema = z.string().min(1).max(32);
const optionalText = z.string().max(1_000).nullish();
const stringList = z.array(z.string().min(1).max(200)).max(50);

const humansSchema = z
  .array(z.strictObject({ handle: handleSchema, displayName: z.string().max(100) }))
  .min(1)
  .max(10);

const icpSchema = z.strictObject({
  description: z.string().min(1).max(2_000),
  pitch: z.string().max(1_000).optional(),
  filters: z.strictObject({
    person_titles: stringList.optional(),
    include_similar_titles: z.boolean().optional(),
    person_seniorities: stringList.optional(),
    person_locations: stringList.optional(),
    organization_locations: stringList.optional(),
    organization_num_employees_ranges: z.array(z.string().regex(/^\d+,\d+$/, 'expected "min,max"')).max(20).optional(),
    q_keywords: z.string().max(200).optional(),
    contact_email_status: stringList.optional(),
  }),
});

const schemas = {
  createRoom: z.strictObject({
    objective: z.string().min(1).max(500),
    icp: icpSchema,
    targetCount: z.number().int().min(1).max(100).optional(),
    humans: humansSchema.optional(),
  }),
  fromPreset: z.strictObject({ presetId: z.string().min(1), humans: humansSchema.optional() }),
  actor: z.strictObject({ actor: handleSchema }),
  claim: z.strictObject({ actor: handleSchema, expectedVersion: z.number().int().min(0) }),
  handback: z.strictObject({ actor: handleSchema, expectedVersion: z.number().int().min(0), note: optionalText }),
  approve: z.strictObject({ actor: handleSchema, expectedVersion: z.number().int().min(0), text: optionalText }),
  skip: z.strictObject({ actor: handleSchema, expectedVersion: z.number().int().min(0), reason: optionalText }),
};

function validate<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const message = parsed.error.issues
    .slice(0, 3)
    .map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ');
  throw new HttpError(400, 'invalid', message);
}

// ------------------------------------------------------------------------------------------- http plumbing

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  // Requiring a JSON content type forces a CORS preflight, so other sites can't post forms at a local instance.
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'invalid', 'Content-Type must be application/json');
  }
  if (Number(req.headers['content-length'] ?? 0) > BODY_LIMIT_BYTES) {
    throw new HttpError(413, 'invalid', `Body exceeds ${BODY_LIMIT_BYTES} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) throw new HttpError(413, 'invalid', `Body exceeds ${BODY_LIMIT_BYTES} bytes`);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid', 'Body must be valid JSON');
  }
}

function sendAction<T>(res: ServerResponse, result: ActionResult<T>, wrap: (value: T) => unknown, status = 200): void {
  if (result.ok) sendJson(res, status, wrap(result.value));
  else sendJson(res, STATUS_BY_CODE[result.code], { error: result.code, message: result.message });
}

function requireUuid(id: string, what: string): string {
  if (!UUID.test(id)) throw new HttpError(404, 'not_found', `${what} not found`);
  return id;
}

// ------------------------------------------------------------------------------------------- SSE fan-out

/**
 * One dedicated LISTEN connection for the whole process, fanned out to every open stream.
 * If it drops, notifications may have been missed, so subscribers are told to resync once it's back.
 */
class RoomEventHub {
  private readonly subscribers = new Map<string, Set<ServerResponse>>();
  private client: pg.PoolClient | null = null;
  private closed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readonly heartbeat = setInterval(() => this.broadcast(': heartbeat\n\n'), SSE_HEARTBEAT_MS);

  async start(): Promise<void> {
    await this.connect().catch((err: Error) => this.scheduleReconnect(err));
  }

  subscribe(roomId: string, res: ServerResponse): () => void {
    const set = this.subscribers.get(roomId) ?? new Set<ServerResponse>();
    set.add(res);
    this.subscribers.set(roomId, set);
    return () => {
      set.delete(res);
      if (set.size === 0 && this.subscribers.get(roomId) === set) this.subscribers.delete(roomId);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.reconnectTimer);
    for (const set of this.subscribers.values()) for (const res of set) res.end();
    this.subscribers.clear();
    const client = this.client;
    this.client = null;
    if (client) {
      await client.query(`unlisten ${LISTEN_CHANNEL}`).catch(() => {});
      client.release();
    }
  }

  private async connect(): Promise<void> {
    const client = await pool.connect();
    client.on('notification', (msg) => this.dispatch(msg.payload));
    client.on('error', (err) => this.onClientError(client, err));
    try {
      await client.query(`listen ${LISTEN_CHANNEL}`);
    } catch (err) {
      client.release(err as Error);
      throw err;
    }
    if (this.closed) {
      client.release();
      return;
    }
    this.client = client;
    if (this.reconnectAttempt > 0) {
      log('http', 'LISTEN connection restored; asking streams to resync');
      this.broadcast('event: resync\ndata: {}\n\n');
    }
    this.reconnectAttempt = 0;
  }

  private onClientError(client: pg.PoolClient, err: Error): void {
    if (this.client !== client) return;
    this.client = null;
    client.release(err); // destroys the broken connection instead of returning it to the pool
    this.scheduleReconnect(err);
  }

  private scheduleReconnect(err: Error): void {
    if (this.closed) return;
    this.reconnectAttempt += 1;
    const delayMs = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempt, 6));
    log('http', `LISTEN connection unavailable (${err.message}); reconnecting in ${delayMs}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((e: Error) => this.scheduleReconnect(e));
    }, delayMs);
  }

  private dispatch(payload: string | undefined): void {
    let event: { roomId?: unknown; eventId?: unknown; type?: unknown };
    try {
      event = JSON.parse(payload ?? '');
    } catch {
      log('http', 'ignoring malformed room_events payload', { payload });
      return;
    }
    const set = typeof event.roomId === 'string' ? this.subscribers.get(event.roomId) : undefined;
    if (!set) return;
    const frame = `event: change\ndata: ${JSON.stringify({ eventId: event.eventId, type: event.type })}\n\n`;
    for (const res of set) res.write(frame);
  }

  private broadcast(frame: string): void {
    for (const set of this.subscribers.values()) for (const res of set) res.write(frame);
  }
}

async function openStream(hub: RoomEventHub, req: IncomingMessage, res: ServerResponse, roomId: string): Promise<void> {
  const { rowCount } = await pool.query('select 1 from rooms where id = $1', [roomId]);
  if (!rowCount) throw new HttpError(404, 'not_found', 'Room not found');
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n: connected\n\n');
  const unsubscribe = hub.subscribe(roomId, res);
  req.on('close', unsubscribe);
}

// ------------------------------------------------------------------------------------------- static files

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

async function sendFile(res: ServerResponse, filePath: string, type: string): Promise<void> {
  let body: Buffer;
  try {
    body = await readFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'not_found', 'File not found');
    throw err;
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-security-policy': CONTENT_SECURITY_POLICY,
  });
  res.end(body);
}

function artifactPath(name: string): string {
  // Basename-only whitelist: no separators, no dot-files, .png only.
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*\.png$/.test(name) || name.includes('..')) {
    throw new HttpError(404, 'not_found', 'File not found');
  }
  return path.join(path.resolve(config.artifactsDir), name);
}

// ------------------------------------------------------------------------------------------- routes

type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: string[] }) => Promise<void>;

interface Route {
  method: 'GET' | 'POST';
  pattern: RegExp;
  handler: Handler;
}

function buildRoutes(hub: RoomEventHub): Route[] {
  const get = (pattern: RegExp, handler: Handler): Route => ({ method: 'GET', pattern, handler });
  const post = (pattern: RegExp, handler: Handler): Route => ({ method: 'POST', pattern, handler });
  const seg = '([^/]+)';
  const param = (params: string[], index: number) => decodeURIComponent(params[index] ?? '');

  return [
    get(/^\/api\/rooms$/, async ({ res }) => sendJson(res, 200, await listRooms())),
    post(/^\/api\/rooms$/, async ({ req, res }) => {
      const body = validate(schemas.createRoom, await readJson(req));
      const result = await createRoom({ ...body, humans: body.humans ?? DEFAULT_HUMANS });
      sendAction(res, result, (value) => value, 201);
    }),
    get(/^\/api\/presets$/, async ({ res }) =>
      sendJson(res, 200, Object.entries(PRESETS).map(([id, preset]) => ({ id, label: preset.label, room: preset.room }))),
    ),
    post(/^\/api\/rooms\/from-preset$/, async ({ req, res }) => {
      const body = validate(schemas.fromPreset, await readJson(req));
      const preset = Object.hasOwn(PRESETS, body.presetId) ? PRESETS[body.presetId] : undefined;
      if (!preset) throw new HttpError(404, 'not_found', `Unknown preset "${body.presetId}"`);
      const result = await createRoom({ ...preset.room, humans: body.humans ?? DEFAULT_HUMANS });
      sendAction(res, result, (value) => value, 201);
    }),
    get(new RegExp(`^/api/rooms/${seg}$`), async ({ res, params }) => {
      const snapshot = await getRoomSnapshot(requireUuid(param(params, 0), 'Room'));
      if (!snapshot) throw new HttpError(404, 'not_found', 'Room not found');
      sendJson(res, 200, snapshot);
    }),
    get(new RegExp(`^/api/rooms/${seg}/stream$`), ({ req, res, params }) =>
      openStream(hub, req, res, requireUuid(param(params, 0), 'Room')),
    ),
    post(new RegExp(`^/api/rooms/${seg}/(pause|resume)$`), async ({ req, res, params }) => {
      const roomId = requireUuid(param(params, 0), 'Room');
      const { actor } = validate(schemas.actor, await readJson(req));
      const result = params[1] === 'pause' ? await pauseRoom(roomId, actor) : await resumeRoom(roomId, actor);
      sendAction(res, result, (room) => ({ room }));
    }),
    post(new RegExp(`^/api/prospects/${seg}/claim$`), async ({ req, res, params }) => {
      const body = validate(schemas.claim, await readJson(req));
      sendAction(res, await claimProspect(param(params, 0), body.actor, body.expectedVersion), (prospect) => ({ prospect }));
    }),
    post(new RegExp(`^/api/prospects/${seg}/handback$`), async ({ req, res, params }) => {
      const body = validate(schemas.handback, await readJson(req));
      const result = await handBackProspect(param(params, 0), body.actor, body.expectedVersion, body.note);
      sendAction(res, result, (prospect) => ({ prospect }));
    }),
    post(new RegExp(`^/api/prospects/${seg}/approve$`), async ({ req, res, params }) => {
      const body = validate(schemas.approve, await readJson(req));
      const result = await approveProspect(param(params, 0), body.actor, body.expectedVersion, body.text);
      sendAction(res, result, (prospect) => ({ prospect }));
    }),
    post(new RegExp(`^/api/prospects/${seg}/skip$`), async ({ req, res, params }) => {
      const body = validate(schemas.skip, await readJson(req));
      const result = await skipProspect(param(params, 0), body.actor, body.expectedVersion, body.reason);
      sendAction(res, result, (prospect) => ({ prospect }));
    }),
    post(new RegExp(`^/api/jobs/${seg}/retry$`), async ({ req, res, params }) => {
      const { actor } = validate(schemas.actor, await readJson(req));
      sendAction(res, await retryJob(param(params, 0), actor), (job) => ({ job }));
    }),
    get(new RegExp(`^/artifacts/${seg}$`), async ({ res, params }) =>
      sendFile(res, artifactPath(param(params, 0)), 'image/png'),
    ),
    ...Object.entries(STATIC_FILES).map(([urlPath, { file, type }]) =>
      get(new RegExp(`^${urlPath.replace(/[.]/g, '\\.')}$`), ({ res }) => sendFile(res, path.join(PUBLIC_DIR, file), type)),
    ),
  ];
}

async function handle(routes: Route[], req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  const matching = routes
    .map((route) => ({ route, match: route.pattern.exec(pathname) }))
    .filter((m): m is { route: Route; match: RegExpExecArray } => m.match !== null);
  if (matching.length === 0) throw new HttpError(404, 'not_found', 'No such route');
  const hit = matching.find((m) => m.route.method === req.method);
  if (!hit) {
    res.setHeader('allow', [...new Set(matching.map((m) => m.route.method))].join(', '));
    throw new HttpError(405, 'invalid', `Method ${req.method} not allowed`);
  }
  await hit.route.handler({ req, res, params: hit.match.slice(1) });
}

function sendError(req: IncomingMessage, res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    if (!res.headersSent) sendJson(res, err.status, { error: err.code, message: err.message });
    else res.end();
    return;
  }
  if (err instanceof URIError) {
    if (!res.headersSent) sendJson(res, 400, { error: 'invalid', message: 'Malformed URL' });
    return;
  }
  log('http', `${req.method} ${req.url} failed`, { stack: err instanceof Error ? err.stack : String(err) });
  if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: 'Internal error' });
  else res.end();
}

export async function startHttpServer(port: number): Promise<HttpServer> {
  const hub = new RoomEventHub();
  await hub.start();
  const routes = buildRoutes(hub);
  const server = createServer((req, res) => {
    handle(routes, req, res).catch((err: unknown) => sendError(req, res, err));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const actualPort = (server.address() as AddressInfo).port;
  log('http', `listening on http://localhost:${actualPort}`);

  return {
    port: actualPort,
    async close() {
      await hub.close();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
