import { withTx, type Queryable } from '../db.ts';

export type Provider = 'apollo' | 'anthropic' | 'linkedin';

export interface CallBudget {
  perMinute: number;
  perHour: number;
  perDay: number;
}

export interface BeginCallInput {
  provider: Provider;
  operation: string;
  /** Identifies the logical call (e.g. "apollo.people_match:<prospect>") across retries and restarts. */
  logicalKey: string;
  roomId: string;
  prospectId: string | null;
  jobId: string;
  workerId: string;
  request: unknown;
  budget?: CallBudget;
}

export type BeginCallResult =
  | { kind: 'go'; callId: string; inDoubt: number }
  | { kind: 'defer'; until: Date; reason: string };

interface WindowRow {
  minute: number;
  hour: number;
  day: number;
  minute_frees: Date | null;
  hour_frees: Date | null;
  day_frees: Date | null;
}

/**
 * Records an outbound call as 'started' and commits it BEFORE the call is made, after checking the
 * provider block and the local rate budget. The advisory lock serializes budget checks per provider,
 * so concurrent workers cannot both take the last slot in a window.
 */
export async function beginExternalCall(input: BeginCallInput): Promise<BeginCallResult> {
  return withTx(async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [`external_calls:${input.provider}`]);

    const block = await tx.query<{ blocked_until: Date; reason: string | null }>(
      `select blocked_until, reason from provider_limits where provider = $1 and blocked_until > now()`,
      [input.provider],
    );
    if (block.rows[0]) {
      return { kind: 'defer', until: block.rows[0].blocked_until, reason: block.rows[0].reason ?? 'provider blocked' };
    }

    if (input.budget) {
      const { rows } = await tx.query<WindowRow>(
        `select count(*) filter (where started_at > now() - interval '1 minute')::int as minute,
                count(*) filter (where started_at > now() - interval '1 hour')::int  as hour,
                count(*)::int as day,
                min(started_at) filter (where started_at > now() - interval '1 minute') + interval '1 minute' as minute_frees,
                min(started_at) filter (where started_at > now() - interval '1 hour') + interval '1 hour' as hour_frees,
                min(started_at) + interval '1 day' as day_frees
           from external_calls
          where provider = $1 and started_at > now() - interval '1 day'`,
        [input.provider],
      );
      const w = rows[0]!;
      const b = input.budget;
      if (w.minute >= b.perMinute && w.minute_frees) {
        return { kind: 'defer', until: w.minute_frees, reason: `local budget: ${w.minute}/${b.perMinute} calls in the last minute` };
      }
      if (w.hour >= b.perHour && w.hour_frees) {
        return { kind: 'defer', until: w.hour_frees, reason: `local budget: ${w.hour}/${b.perHour} calls in the last hour` };
      }
      if (w.day >= b.perDay && w.day_frees) {
        return { kind: 'defer', until: w.day_frees, reason: `local budget: ${w.day}/${b.perDay} calls in the last day` };
      }
    }

    // A 'started' row for the same logical call means an earlier attempt died mid-flight.
    const doubt = await tx.query(
      `update external_calls
          set status = 'in_doubt', finished_at = now(),
              error = 'attempt ended (crash or lost lease) before its outcome was recorded'
        where logical_key = $1 and status = 'started'`,
      [input.logicalKey],
    );
    const inserted = await tx.query<{ id: string }>(
      `insert into external_calls (provider, operation, logical_key, room_id, prospect_id, job_id, worker_id, request)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id`,
      [
        input.provider,
        input.operation,
        input.logicalKey,
        input.roomId,
        input.prospectId,
        input.jobId,
        input.workerId,
        JSON.stringify(input.request ?? null),
      ],
    );
    return { kind: 'go', callId: inserted.rows[0]!.id, inDoubt: doubt.rowCount ?? 0 };
  });
}

export interface CallOutcome {
  status: 'succeeded' | 'failed';
  httpStatus?: number | null;
  response?: unknown;
  rateHeaders?: Record<string, string> | null;
  error?: string | null;
}

export async function finishExternalCall(db: Queryable, callId: string, outcome: CallOutcome): Promise<void> {
  await db.query(
    `update external_calls
        set status = $2, http_status = $3, response = $4, rate_headers = $5, error = $6, finished_at = now()
      where id = $1`,
    [
      callId,
      outcome.status,
      outcome.httpStatus ?? null,
      outcome.response === undefined ? null : JSON.stringify(outcome.response),
      outcome.rateHeaders ? JSON.stringify(outcome.rateHeaders) : null,
      outcome.error ?? null,
    ],
  );
}

/** Blocks a provider for every worker until now()+seconds (never shortens an existing block). */
export async function blockProvider(
  db: Queryable,
  provider: Provider,
  seconds: number,
  reason: string,
  headers: Record<string, string> | null,
): Promise<Date> {
  const { rows } = await db.query<{ blocked_until: Date }>(
    `insert into provider_limits (provider, blocked_until, reason, last_headers, updated_at)
     values ($1, now() + make_interval(secs => $2::float8), $3, $4, now())
     on conflict (provider) do update
        set blocked_until = greatest(coalesce(provider_limits.blocked_until, now()), excluded.blocked_until),
            reason = excluded.reason,
            last_headers = coalesce(excluded.last_headers, provider_limits.last_headers),
            updated_at = now()
     returning blocked_until`,
    [provider, seconds, reason, headers ? JSON.stringify(headers) : null],
  );
  return rows[0]!.blocked_until;
}

export async function recordProviderHeaders(db: Queryable, provider: Provider, headers: Record<string, string>) {
  if (Object.keys(headers).length === 0) return;
  await db.query(`update provider_limits set last_headers = $2, updated_at = now() where provider = $1`, [
    provider,
    JSON.stringify(headers),
  ]);
}
