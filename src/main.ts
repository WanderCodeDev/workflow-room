import { config } from './config.ts';
import { migrate, pool } from './db.ts';
import { log } from './log.ts';
import { Worker } from './queue/worker.ts';

await migrate();

if (config.worker.enabled && !config.apollo.apiKey) {
  log('main', 'WARNING: APOLLO_API_KEY is not set; search/enrich jobs will fail until it is (or point APOLLO_BASE_URL at the fake).');
}

// Loaded lazily so worker-only processes (HTTP_ENABLED=false) don't pull in the web layer.
const server = config.http.enabled ? await (await import('./server/http.ts')).startHttpServer(config.port) : null;
const worker = config.worker.enabled ? new Worker() : null;
await worker?.start();

log('main', 'ready', {
  http: server ? `http://localhost:${config.port}` : 'off',
  worker: worker?.id ?? 'off',
  apollo: config.apollo.baseUrl,
  drafter: config.drafter.mode === 'claude' ? `claude (${config.drafter.model})` : 'template',
  linkedin: config.linkedin.enabled ? `${config.linkedin.channel}${config.linkedin.headless ? ' headless' : ''}` : 'off',
});

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log('main', `${signal} received, shutting down`);
  setTimeout(() => process.exit(1), 10_000).unref();
  await worker?.stop();
  await server?.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
