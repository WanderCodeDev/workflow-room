// Offline test of the Playwright LinkedIn lookup: a real browser, with linkedin.com answered by local fixtures.
// Live check against the real site: `npm run linkedin:check -- <profile url>`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Route } from 'playwright';
import { fetchLinkedInHeadline, type LinkedInOptions } from '../src/agent/linkedin.ts';

const page = (title: string, body: string, head = '') =>
  `<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`;

interface Fixture {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  hang?: boolean;
}

const FIXTURES: Record<string, Fixture> = {
  '/in/guest-public/': {
    status: 200,
    body: page(
      'Jordan Example - Example Foundation | LinkedIn',
      '<section><h2 class="top-card-layout__headline">  Co-chair,\n  Example Foundation </h2></section>',
    ),
  },
  '/in/member/': {
    status: 200,
    // Rendered client-side after a delay, like the logged-in profile page.
    body: page(
      'Jane | LinkedIn',
      `<main id="m"></main><script>setTimeout(() => { document.getElementById('m').innerHTML =
        '<section class="artdeco-card"><h1>Jane</h1><div class="text-body-medium break-words">Staff Engineer at Acme</div></section>' }, 1200)</script>`,
    ),
  },
  '/in/jsonld/': {
    status: 200,
    body: page(
      'Jane | LinkedIn',
      '<p>profile</p>',
      '<script type="application/ld+json">{"@context":"http://schema.org","@graph":[{"@type":"WebPage"},{"@type":["Person"],"name":"Jane","jobTitle":["","VP Sales at Initech"]}]}</script>',
    ),
  },
  '/in/meta/': {
    status: 200,
    body: page('Jane Doe - Acme Corp | LinkedIn', '<p>profile</p>', '<meta property="og:title" content="Jane Doe - Acme Corp | LinkedIn">'),
  },
  '/in/walled/': { status: 302, headers: { location: 'https://www.linkedin.com/authwall?trk=test' } },
  '/authwall': {
    status: 200,
    body: page('Sign Up | LinkedIn', '<form class="authwall-join-form">Join LinkedIn</form>', '<meta property="og:title" content="Sign Up | LinkedIn">'),
  },
  '/in/gone/': { status: 404, body: page('Page not found | LinkedIn', '<h1>This page doesn’t exist</h1>') },
  '/in/empty/': { status: 200, body: page('Someone | LinkedIn', '<p>nothing here</p>') },
  '/in/hang/': { status: 0, hang: true },
};

const launched: Browser[] = [];
let artifactsDir = '';
let options: LinkedInOptions;
let browserAvailable = true;

before(async () => {
  artifactsDir = await mkdtemp(path.join(os.tmpdir(), 'linkedin-test-'));
  options = {
    headless: true,
    channel: process.env.LINKEDIN_BROWSER_CHANNEL || 'chrome',
    storageStatePath: path.join(artifactsDir, 'no-session.json'),
    artifactsDir,
    timeoutMs: 20_000,
  };
  try {
    (await chromium.launch({ channel: options.channel, headless: true })).close();
  } catch {
    browserAvailable = false;
  }

  // Serve linkedin.com from fixtures: patch the shared `chromium` object the module under test imports.
  const launch = chromium.launch.bind(chromium);
  chromium.launch = (async (launchOptions?: Parameters<typeof chromium.launch>[0]) => {
    const browser = await launch(launchOptions);
    launched.push(browser);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = (async (contextOptions?: Parameters<Browser['newContext']>[0]): Promise<BrowserContext> => {
      const context = await newContext(contextOptions);
      await context.route('**/*', (route: Route) => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'www.linkedin.com') return route.abort();
        const fixture = FIXTURES[url.pathname] ?? FIXTURES[`${url.pathname}/`];
        if (!fixture) return route.fulfill({ status: 200, contentType: 'text/html', body: page('x', '') });
        if (fixture.hang) return undefined; // never answered
        return route.fulfill({ status: fixture.status, headers: fixture.headers, contentType: 'text/html', body: fixture.body ?? '' });
      });
      return context;
    }) as Browser['newContext'];
    return browser;
  }) as typeof chromium.launch;
});

after(async () => {
  await rm(artifactsDir, { recursive: true, force: true });
});

function lookup(slug: string, extra: Partial<LinkedInOptions> = {}) {
  return fetchLinkedInHeadline(`https://www.linkedin.com/in/${slug}/`, { ...options, ...extra });
}

const skipReason = () => (browserAvailable ? false : `browser channel "${options.channel}" is not installed`);

test('reads the headline from a public (guest) profile and saves a screenshot', async (t) => {
  if (skipReason()) return t.skip(String(skipReason()));
  const result = await lookup('guest-public');
  assert.equal(result.outcome, 'ok');
  assert.equal(result.headline, 'Co-chair, Example Foundation');
  assert.equal(result.source, 'dom-public');
  assert.ok(result.screenshotPath && existsSync(result.screenshotPath), 'screenshot written');
});

test('waits for a client-rendered logged-in profile headline', async (t) => {
  if (skipReason()) return t.skip(String(skipReason()));
  const result = await lookup('member');
  assert.equal(result.outcome, 'ok');
  assert.equal(result.headline, 'Staff Engineer at Acme');
  assert.equal(result.source, 'dom-member');
});

test('falls back to JSON-LD, then to the page title', async (t) => {
  if (skipReason()) return t.skip(String(skipReason()));
  const jsonLd = await lookup('jsonld');
  assert.deepEqual([jsonLd.outcome, jsonLd.headline, jsonLd.source], ['ok', 'VP Sales at Initech', 'json-ld']);
  const meta = await lookup('meta');
  assert.deepEqual([meta.outcome, meta.headline, meta.source], ['ok', 'Acme Corp', 'meta']);
});

test('normalizes the http:// profile URLs Apollo returns', async (t) => {
  if (skipReason()) return t.skip(String(skipReason()));
  const result = await fetchLinkedInHeadline('http://www.linkedin.com/in/guest-public', options);
  assert.equal(result.outcome, 'ok');
  assert.equal(result.headline, 'Co-chair, Example Foundation');
});

test('classifies auth walls, missing profiles and pages without a headline', async (t) => {
  if (skipReason()) return t.skip(String(skipReason()));
  assert.equal((await lookup('walled')).outcome, 'authwall');
  assert.equal((await lookup('gone')).outcome, 'not_found');
  assert.equal((await lookup('empty')).outcome, 'no_headline');
});

test('rejects non-profile URLs without launching a browser', async () => {
  const before = launched.length;
  const result = await fetchLinkedInHeadline('https://www.linkedin.com/company/example/', options);
  assert.equal(result.outcome, 'error');
  assert.equal(launched.length, before);
});

test('aborts a hanging page promptly and closes every browser it opened', async (t) => {
  if (skipReason()) return t.skip(String(skipReason()));
  const started = Date.now();
  await assert.rejects(lookup('hang', { signal: AbortSignal.timeout(2_000) }), { name: 'AbortError' });
  assert.ok(Date.now() - started < 8_000, 'abort honoured quickly');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(launched.filter((b) => b.isConnected()).length, 0, 'no browser left running');
});
