/**
 * Test environment. Every test file imports this FIRST: ESM evaluates imports in order, and src/config.ts reads
 * process.env exactly once, when it is first imported. Child processes spawned by the tests inherit these values.
 *
 * Values that the assertions depend on are forced (a developer's shell or .env must not turn on Claude drafting
 * or the real browser mid-test). Only DATABASE_URL may be overridden, and only with another *_test database.
 */

process.env.DATABASE_URL ||= 'postgres://postgres@localhost:5433/prospect_room_test';

const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
if (!dbName.endsWith('_test')) {
  throw new Error(`Refusing to run tests: DATABASE_URL points at "${dbName}", which does not end with _test`);
}

Object.assign(process.env, {
  HTTP_ENABLED: 'false',
  WORKER_ENABLED: 'true',
  // Nothing listens on port 9: a test that forgets to point Apollo at the fake fails loudly instead of calling the real API.
  APOLLO_BASE_URL: 'http://127.0.0.1:9/api/v1',
  APOLLO_API_KEY: 'fake-key',
  APOLLO_TIMEOUT_MS: '5000',
  APOLLO_LIMIT_PER_MINUTE: '45',
  APOLLO_LIMIT_PER_HOUR: '190',
  APOLLO_LIMIT_PER_DAY: '580',
  DRAFTER: 'template',
  LINKEDIN_ENABLED: 'false',
  LINKEDIN_HEADLESS: 'true',
  WORKER_CONCURRENCY: '3',
  WORKER_POLL_MS: '50',
  LEASE_SECONDS: '30',
  HEARTBEAT_SECONDS: '5',
  STALE_WORKER_SECONDS: '15',
  JOB_MAX_ATTEMPTS: '8',
  JOB_MAX_CLAIMS: '25',
  JOB_BACKOFF_BASE_MS: '100',
  JOB_BACKOFF_MAX_MS: '2000',
});
