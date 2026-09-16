/**
 * Errors a job handler throws to tell the worker what to do with the job.
 * Anything else thrown is treated as retryable.
 */

/** Transient failure: retry with exponential backoff, counts toward JOB_MAX_ATTEMPTS. */
export class RetryableError extends Error {
  override name = 'RetryableError';
}

/** Will never succeed as-is (bad request, auth, missing data): dead-letter now, a human can retry. */
export class PermanentError extends Error {
  override name = 'PermanentError';
}

/** Not a failure: run again later (local rate budget, provider block, waiting on another job). */
export class DeferError extends Error {
  override name = 'DeferError';
  constructor(
    message: string,
    readonly runAfter: Date | { delayMs: number },
    /** Quiet deferrals (e.g. waiting on a sibling job) are not written to the event log. */
    readonly quiet = false,
  ) {
    super(message);
  }
}

/** Provider answered 429: block the provider for everyone, then defer this job. */
export class RateLimitedError extends Error {
  override name = 'RateLimitedError';
  constructor(
    message: string,
    readonly provider: 'apollo' | 'anthropic',
    readonly retryAfterSeconds: number,
    readonly rateHeaders: Record<string, string>,
  ) {
    super(message);
  }
}

/** The agent no longer owns the prospect (a human claimed it): put the job back untouched. */
export class ReleaseJob extends Error {
  override name = 'ReleaseJob';
}

/** Another worker reclaimed this job (our lease expired). Our result must not be committed. */
export class LeaseLostError extends Error {
  override name = 'LeaseLostError';
  constructor(readonly jobId: string) {
    super(`Lease lost for job ${jobId}`);
  }
}
