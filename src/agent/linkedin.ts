import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

export type LinkedInOutcome = 'ok' | 'authwall' | 'not_found' | 'no_headline' | 'error';

export interface LinkedInResult {
  outcome: LinkedInOutcome;
  headline: string | null;
  source: string | null;
  finalUrl: string | null;
  screenshotPath: string | null;
  detail: Record<string, unknown>;
}

export interface LinkedInOptions {
  headless: boolean;
  channel: string;
  storageStatePath: string;
  artifactsDir: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Thrown only when the browser itself cannot be launched; callers treat it as transient. */
export class BrowserUnavailableError extends Error {
  override name = 'BrowserUnavailableError';
}

type Strategy = 'dom-member' | 'dom-public' | 'json-ld' | 'meta';

interface ProfileTarget {
  url: string;
  slug: string;
}

interface Evidence {
  finalUrl: string | null;
  screenshotPath: string | null;
  detail: Record<string, unknown>;
}

interface PageSnapshot {
  title: string;
  ogTitle: string | null;
  memberTexts: string[];
  publicTexts: string[];
  jsonLdBlocks: string[];
  signInWall: boolean;
  bodyText: string;
}

interface Match {
  source: Strategy;
  headline: string;
  note?: Record<string, unknown>;
}

type Found = Omit<Match, 'source'> | null;

// LinkedIn markup changes often, so each strategy tries several known variants.
const MEMBER_HEADLINE_SELECTORS = [
  'main section.artdeco-card div.text-body-medium.break-words',
  'main .pv-text-details__left-panel div.text-body-medium',
  'main div.text-body-medium[data-generated-suggestion-target]',
  '.pv-top-card div.text-body-medium.break-words',
];
const PUBLIC_HEADLINE_SELECTORS = [
  'h2.top-card-layout__headline',
  '.top-card-layout__headline',
  '.top-card__headline',
];
const SIGN_IN_WALL_SELECTORS = [
  '.authwall-join-form',
  '.authwall-sign-in-form',
  'form.join-form',
  '#join-form',
];

const AUTHWALL_PATH = /^\/(authwall|login|signup|checkpoint|uas\/login)(\/|$)/i;
const NOT_FOUND_PATH = /^\/404(\/|$)/;
const NOT_FOUND_TEXT = /page (doesn[’']t|does not) exist|page not found|profile (is )?not (available|found)/i;
// LinkedIn's non-standard "request denied" status for traffic it considers automated.
const HTTP_DENIED = 999;

const MAX_HEADLINE_CHARS = 300;
const GENERIC_TEXT = /^(linkedin|sign up|sign in|log in|login|join linkedin|join now)$/i;
const VIEWPORT = { width: 1280, height: 900 };

export async function fetchLinkedInHeadline(
  profileUrl: string,
  opts: LinkedInOptions,
): Promise<LinkedInResult> {
  const startedAt = Date.now();
  const target = parseProfileUrl(profileUrl);
  if ('reason' in target) {
    return {
      outcome: 'error',
      headline: null,
      source: null,
      finalUrl: null,
      screenshotPath: null,
      detail: { reason: target.reason, elapsedMs: Date.now() - startedAt },
    };
  }
  throwIfAborted(opts.signal);

  const storageState = existsSync(opts.storageStatePath) ? opts.storageStatePath : undefined;
  const evidence: Evidence = {
    finalUrl: null,
    screenshotPath: null,
    detail: {
      httpStatus: null,
      pageTitle: null,
      authwall: false,
      strategiesTried: [],
      loggedInSession: storageState !== undefined,
      channel: opts.channel,
      headless: opts.headless,
    },
  };

  const browser = await launchBrowser(opts);
  const closeOnAbort = (): void => void browser.close().catch(() => {});
  opts.signal?.addEventListener('abort', closeOnAbort, { once: true });
  try {
    throwIfAborted(opts.signal);
    const { outcome, headline, source } = await inspectProfile(browser, target, opts, storageState, evidence);
    throwIfAborted(opts.signal);
    return { outcome, headline, source, ...finalize(evidence, startedAt) };
  } catch (err) {
    if (opts.signal?.aborted) throw abortError();
    const result = finalize(evidence, startedAt);
    return {
      outcome: 'error',
      headline: null,
      source: null,
      ...result,
      detail: { ...result.detail, message: errorMessage(err) },
    };
  } finally {
    opts.signal?.removeEventListener('abort', closeOnAbort);
    await browser.close().catch(() => {});
  }
}

function parseProfileUrl(raw: string): ProfileTarget | { reason: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { reason: 'not a valid URL' };
  }
  // Apollo returns profile URLs as http://, which LinkedIn only ever redirects to https.
  if (url.protocol === 'http:') url.protocol = 'https:';
  if (url.protocol !== 'https:') return { reason: 'URL must use https' };
  if (url.hostname !== 'linkedin.com' && !url.hostname.endsWith('.linkedin.com')) {
    return { reason: 'URL host must be linkedin.com' };
  }
  const slug = /^\/in\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  if (!slug) return { reason: 'URL path must be a /in/<profile> page' };
  return { url: url.href, slug };
}

async function launchBrowser(opts: LinkedInOptions): Promise<Browser> {
  try {
    return await chromium.launch({ channel: opts.channel, headless: opts.headless, timeout: opts.timeoutMs });
  } catch (err) {
    throw new BrowserUnavailableError(
      `Could not launch browser channel "${opts.channel}": ${errorMessage(err)}. ` +
        'Hint: set LINKEDIN_BROWSER_CHANNEL=msedge, or run `npx playwright install chromium` ' +
        'and set LINKEDIN_BROWSER_CHANNEL=chromium.',
      { cause: err },
    );
  }
}

async function inspectProfile(
  browser: Browser,
  target: ProfileTarget,
  opts: LinkedInOptions,
  storageState: string | undefined,
  evidence: Evidence,
): Promise<Pick<LinkedInResult, 'outcome' | 'headline' | 'source'>> {
  const budget = timeBudget(opts.timeoutMs);
  const context = await browser.newContext({
    storageState,
    locale: 'en-US',
    viewport: VIEWPORT,
    userAgent: opts.headless ? await headedUserAgent(browser) : undefined,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(budget.stepMs);

  try {
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: budget.navigationMs });
    const httpStatus = response?.status() ?? null;
    evidence.detail.httpStatus = httpStatus;

    await waitForHeadline(page, budget.headlineWaitMs);
    const snapshot = await readSnapshot(page);
    const finalPath = new URL(page.url()).pathname;
    const authwall = AUTHWALL_PATH.test(finalPath) || snapshot.signInWall || httpStatus === HTTP_DENIED;
    const notFound =
      httpStatus === 404 || NOT_FOUND_PATH.test(finalPath) || NOT_FOUND_TEXT.test(snapshot.bodyText);

    const strategiesTried: Strategy[] = [];
    const match = extractHeadline(snapshot, strategiesTried);
    Object.assign(evidence.detail, { pageTitle: snapshot.title, authwall, notFound, strategiesTried, ...match?.note });

    if (match) return { outcome: 'ok', headline: match.headline, source: match.source };
    return { outcome: notFound ? 'not_found' : authwall ? 'authwall' : 'no_headline', headline: null, source: null };
  } finally {
    evidence.finalUrl = page.url() === 'about:blank' ? null : page.url();
    if (evidence.finalUrl) await captureScreenshot(page, opts.artifactsDir, target.slug, evidence);
  }
}

function timeBudget(timeoutMs: number): { navigationMs: number; headlineWaitMs: number; stepMs: number } {
  return {
    navigationMs: Math.max(1_000, Math.round(timeoutMs * 0.7)),
    headlineWaitMs: Math.min(6_000, Math.round(timeoutMs * 0.15)),
    stepMs: Math.max(1_000, Math.round(timeoutMs * 0.15)),
  };
}

// Headless Chrome advertises "HeadlessChrome" in its user agent, which sites commonly treat as a bot.
// Send the UA the same browser would send when headed.
async function headedUserAgent(browser: Browser): Promise<string> {
  const session = await browser.newBrowserCDPSession();
  try {
    const { userAgent } = await session.send('Browser.getVersion');
    return userAgent.replace('HeadlessChrome', 'Chrome');
  } finally {
    await session.detach();
  }
}

async function waitForHeadline(page: Page, timeoutMs: number): Promise<void> {
  await page
    .waitForFunction(
      (selectors) => selectors.some((sel) => document.querySelector(sel)?.textContent?.trim()),
      [...MEMBER_HEADLINE_SELECTORS, ...PUBLIC_HEADLINE_SELECTORS],
      { timeout: timeoutMs },
    )
    .catch(() => {});
}

function readSnapshot(page: Page): Promise<PageSnapshot> {
  // No named inner functions here: tsx's keepNames transform would inject a `__name` helper
  // that does not exist in the browser.
  return page.evaluate(
    ({ member, guest, wall }) => ({
      title: document.title,
      ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? null,
      memberTexts: member.flatMap((sel) => Array.from(document.querySelectorAll(sel), (el) => el.textContent ?? '')),
      publicTexts: guest.flatMap((sel) => Array.from(document.querySelectorAll(sel), (el) => el.textContent ?? '')),
      jsonLdBlocks: Array.from(
        document.querySelectorAll('script[type="application/ld+json"]'),
        (el) => el.textContent ?? '',
      ),
      signInWall: wall.some((sel) => document.querySelector(sel) !== null),
      bodyText: (document.body?.innerText ?? '').slice(0, 4_000),
    }),
    { member: MEMBER_HEADLINE_SELECTORS, guest: PUBLIC_HEADLINE_SELECTORS, wall: SIGN_IN_WALL_SELECTORS },
  );
}

function extractHeadline(snapshot: PageSnapshot, tried: Strategy[]): Match | null {
  const strategies: Array<[Strategy, () => Found]> = [
    ['dom-member', () => firstHeadline(snapshot.memberTexts)],
    ['dom-public', () => firstHeadline(snapshot.publicTexts)],
    ['json-ld', () => fromJsonLd(snapshot.jsonLdBlocks)],
    ['meta', () => fromTitle([snapshot.ogTitle, snapshot.title])],
  ];
  for (const [source, run] of strategies) {
    tried.push(source);
    const found = run();
    if (found) return { source, ...found };
  }
  return null;
}

function firstHeadline(texts: string[]): Found {
  for (const text of texts) {
    const headline = cleanHeadline(text);
    if (headline) return { headline };
  }
  return null;
}

function fromJsonLd(blocks: string[]): Found {
  const persons = blocks.flatMap((block) => {
    try {
      return collectPersons(JSON.parse(block));
    } catch {
      return [];
    }
  });
  for (const person of persons) {
    for (const field of ['jobTitle', 'description'] as const) {
      const value = person[field];
      for (const candidate of Array.isArray(value) ? value : [value]) {
        const headline = cleanHeadline(candidate);
        if (headline) return { headline, note: { jsonLdField: field } };
      }
    }
  }
  return null;
}

function collectPersons(node: unknown): Record<string, unknown>[] {
  if (Array.isArray(node)) return node.flatMap(collectPersons);
  if (typeof node !== 'object' || node === null) return [];
  const record = node as Record<string, unknown>;
  if (record['@graph'] !== undefined) return collectPersons(record['@graph']);
  const type = record['@type'];
  return type === 'Person' || (Array.isArray(type) && type.includes('Person')) ? [record] : [];
}

/** Titles look like "Name - Headline | LinkedIn"; guests often get the current company in that slot instead. */
function fromTitle(titles: Array<string | null>): Found {
  for (const title of titles) {
    const parts = title?.replace(/\s*\|\s*LinkedIn\s*$/i, '').split(/\s[-–—]\s/);
    if (!parts || parts.length < 2) continue;
    const headline = cleanHeadline(parts.slice(1).join(' - '));
    if (headline) {
      return { headline, note: { metaCaveat: 'derived from the page title; may be the current company rather than the headline' } };
    }
  }
  return null;
}

function cleanHeadline(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, MAX_HEADLINE_CHARS).trim();
  if (!text || GENERIC_TEXT.test(text.replace(/\s*\|\s*LinkedIn$/i, ''))) return null;
  return text;
}

async function captureScreenshot(page: Page, artifactsDir: string, slug: string, evidence: Evidence): Promise<void> {
  const safeSlug = slug.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80);
  const file = path.join(artifactsDir, `linkedin-${safeSlug}-${Date.now()}.png`);
  try {
    await mkdir(artifactsDir, { recursive: true });
    await page.screenshot({ path: file });
    evidence.screenshotPath = file;
  } catch (err) {
    evidence.detail.screenshotError = errorMessage(err);
  }
}

function finalize(evidence: Evidence, startedAt: number): Pick<LinkedInResult, 'finalUrl' | 'screenshotPath' | 'detail'> {
  return {
    finalUrl: evidence.finalUrl,
    screenshotPath: evidence.screenshotPath,
    detail: { ...evidence.detail, elapsedMs: Date.now() - startedAt },
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const err = new Error('LinkedIn lookup aborted');
  err.name = 'AbortError';
  return err;
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Playwright appends a colourised call log; the message is persisted, so strip the ANSI codes.
  return message.replace(/\[[0-9;]*m/g, '');
}
