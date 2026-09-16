import 'dotenv/config';

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got "${raw}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const anthropicKey = optional('ANTHROPIC_API_KEY');

export const config = Object.freeze({
  databaseUrl: str('DATABASE_URL', 'postgres://postgres@localhost:5433/prospect_room'),
  port: num('PORT', 3000),
  http: Object.freeze({
    enabled: bool('HTTP_ENABLED', true),
  }),

  apollo: Object.freeze({
    apiKey: optional('APOLLO_API_KEY'),
    baseUrl: str('APOLLO_BASE_URL', 'https://api.apollo.io/api/v1').replace(/\/+$/, ''),
    timeoutMs: num('APOLLO_TIMEOUT_MS', 20_000),
    // Local budget kept just under Apollo's free-plan limits (50/min, 200/hour, 600/day).
    limitPerMinute: num('APOLLO_LIMIT_PER_MINUTE', 45),
    limitPerHour: num('APOLLO_LIMIT_PER_HOUR', 190),
    limitPerDay: num('APOLLO_LIMIT_PER_DAY', 580),
  }),

  drafter: Object.freeze({
    mode: str('DRAFTER', anthropicKey ? 'claude' : 'template') as 'claude' | 'template',
    model: str('CLAUDE_MODEL', 'claude-opus-5'),
  }),

  worker: Object.freeze({
    enabled: bool('WORKER_ENABLED', true),
    concurrency: num('WORKER_CONCURRENCY', 2),
    pollMs: num('WORKER_POLL_MS', 500),
    leaseSeconds: num('LEASE_SECONDS', 30),
    heartbeatSeconds: num('HEARTBEAT_SECONDS', 5),
    staleWorkerSeconds: num('STALE_WORKER_SECONDS', 15),
    maxAttempts: num('JOB_MAX_ATTEMPTS', 8),
    maxClaims: num('JOB_MAX_CLAIMS', 25),
    backoffBaseMs: num('JOB_BACKOFF_BASE_MS', 2_000),
    backoffMaxMs: num('JOB_BACKOFF_MAX_MS', 300_000),
  }),

  linkedin: Object.freeze({
    enabled: bool('LINKEDIN_ENABLED', true),
    headless: bool('LINKEDIN_HEADLESS', false),
    channel: str('LINKEDIN_BROWSER_CHANNEL', 'chrome'),
    storageStatePath: str('LINKEDIN_STORAGE_STATE', '.linkedin-state.json'),
    timeoutMs: num('LINKEDIN_TIMEOUT_MS', 45_000),
    // Overrides the profile URL for the one lookup (useful with the fake Apollo dataset).
    urlOverride: optional('LINKEDIN_URL_OVERRIDE'),
  }),

  artifactsDir: str('ARTIFACTS_DIR', 'artifacts'),
});

export type Config = typeof config;
