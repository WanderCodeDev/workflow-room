import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

export type Queryable = pg.Pool | pg.PoolClient;
export type Tx = pg.PoolClient;

export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch (rollbackErr) {
      broken = rollbackErr as Error;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

const MIGRATION_LOCK = 727_274_001;
const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

export async function migrate(): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(
      'create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set(
      (await client.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(migrationsDir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
  return applied;
}

/** Drops and recreates the schema. Refuses to run against anything but a *_test database. */
export async function resetTestDatabase(): Promise<void> {
  const dbName = new URL(config.databaseUrl).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error(`resetTestDatabase refused: database "${dbName}" does not end with _test`);
  }
  await pool.query('drop schema public cascade; create schema public;');
  await migrate();
}
