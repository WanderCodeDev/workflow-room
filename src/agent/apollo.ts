import { scrubDeep } from '../scrub.ts';
import type { ApolloPerson, ApolloSearchFilters, ApolloSearchPerson } from '../domain/types.ts';

/** Connection-level failures that prove the request never reached Apollo. */
const NOT_DELIVERED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

export type ApolloErrorKind = 'rate_limited' | 'transient' | 'permanent';

export class ApolloError extends Error {
  override name = 'ApolloError';
  constructor(
    message: string,
    readonly kind: ApolloErrorKind,
    readonly status: number | null,
    readonly retryAfterSeconds: number | null,
    readonly rateHeaders: Record<string, string>,
    /** True when Apollo may have processed (and charged for) the request even though we never read a response. */
    readonly maybeDelivered = false,
  ) {
    super(message);
  }
}

export interface ApolloResult<T> {
  status: number;
  data: T;
  rateHeaders: Record<string, string>;
}

export interface ApolloSearchResponse {
  people: ApolloSearchPerson[];
  total_entries?: number;
}

export interface ApolloMatchResponse {
  person: ApolloPerson | null;
}

export interface ApolloClientOptions {
  apiKey: string | undefined;
  baseUrl: string;
  timeoutMs: number;
}

const RATE_HEADER = /^(x-rate-limit-|x-minute-|x-hourly-|x-24-hour-|retry-after$)/i;

export class ApolloClient {
  constructor(private readonly opts: ApolloClientOptions) {}

  /** People API Search: 0 credits, obfuscated last names, no contact data. */
  searchPeople(filters: ApolloSearchFilters, page: number, perPage: number, signal?: AbortSignal) {
    return this.post<ApolloSearchResponse>('/mixed_people/api_search', { ...filters, page, per_page: perPage }, signal);
  }

  /** People Enrichment by Apollo id: consumes a credit when data is found. */
  matchPerson(apolloPersonId: string, signal?: AbortSignal) {
    return this.post<ApolloMatchResponse>(
      '/people/match',
      { id: apolloPersonId, reveal_personal_emails: false, reveal_phone_number: false },
      signal,
    );
  }

  private async post<T>(path: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<ApolloResult<T>> {
    if (!this.opts.apiKey) {
      throw new ApolloError('APOLLO_API_KEY is not set', 'permanent', null, null, {});
    }
    const url = `${this.opts.baseUrl}${path}?${toQueryString(params)}`;
    const timeout = AbortSignal.timeout(this.opts.timeoutMs);

    let res: Response;
    let body: string;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': this.opts.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
          'cache-control': 'no-cache',
        },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      body = await res.text();
    } catch (err) {
      if (signal?.aborted) throw err; // our own shutdown, not a provider failure
      // A request that never connected cannot have been charged; a timeout mid-flight can have been.
      const code = (err as { cause?: { code?: string } })?.cause?.code;
      const neverConnected = typeof code === 'string' && NOT_DELIVERED.has(code);
      throw new ApolloError(`Apollo request failed: ${describe(err)}`, 'transient', null, null, {}, !neverConnected);
    }

    const rateHeaders = pickRateHeaders(res.headers);
    if (res.status === 429) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      throw new ApolloError(`Apollo rate limited (429): ${snippet(body)}`, 'rate_limited', 429, retryAfter, rateHeaders);
    }
    if (res.status >= 500 || res.status === 408 || res.status === 425) {
      // 504 means an upstream timeout: Apollo itself may well have run the request.
      const maybeDelivered = res.status === 504;
      throw new ApolloError(`Apollo ${res.status}: ${snippet(body)}`, 'transient', res.status, null, rateHeaders, maybeDelivered);
    }
    if (!res.ok) {
      throw new ApolloError(`Apollo ${res.status}: ${snippet(body)}${configHint(res.status)}`, 'permanent', res.status, null, rateHeaders);
    }
    try {
      // Vendor strings are scrubbed here so nothing downstream can be poisoned by bytes Postgres rejects.
      return { status: res.status, data: scrubDeep(JSON.parse(body)) as T, rateHeaders };
    } catch {
      throw new ApolloError(`Apollo returned non-JSON (${res.status}): ${snippet(body)}`, 'transient', res.status, null, rateHeaders, true);
    }
  }
}

/**
 * If Apollo reports an exhausted window on a successful response, returns how long to hold off
 * (the headers carry no reset time, so these are conservative guesses per window).
 */
export function exhaustedWindowSeconds(rateHeaders: Record<string, string>): number | null {
  if (rateHeaders['x-24-hour-requests-left'] === '0') return 3600;
  if (rateHeaders['x-hourly-requests-left'] === '0') return 900;
  if (rateHeaders['x-minute-requests-left'] === '0') return 60;
  return null;
}

/** Apollo's documented style: arrays as repeated `key[]=value`. */
export function toQueryString(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) qs.append(`${key}[]`, String(item));
    } else {
      qs.append(key, String(value));
    }
  }
  return qs.toString();
}

/** Returns null for an absent, unparseable or non-positive value, so callers apply their own default. */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds : null;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  const wait = Math.ceil((date - Date.now()) / 1000);
  return wait > 0 ? wait : null;
}

function pickRateHeaders(headers: Headers): Record<string, string> {
  const picked: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (RATE_HEADER.test(key)) picked[key.toLowerCase()] = value;
  });
  return picked;
}

/**
 * 401 and 403 are configuration problems, not transient ones, and they dead-letter the job — so the message
 * that lands in the UI says what to check. Apollo returns 403 (API_INACCESSIBLE) when the plan or the key's
 * scope doesn't cover the endpoint.
 */
function configHint(status: number): string {
  if (status === 401) return ' — check APOLLO_API_KEY: it is missing or invalid, or the Apollo account is inactive';
  if (status === 403) {
    return " — the API key's scope or the Apollo plan does not cover this endpoint; this app needs api/v1/mixed_people/api_search and api/v1/people/match (a master key covers both)";
  }
  return '';
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat || '(empty body)';
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}
