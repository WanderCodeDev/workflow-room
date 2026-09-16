import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { config } from '../config.ts';

const LOGIN_URL = 'https://www.linkedin.com/login';
const POLL_MS = 1_000;

type SaveTrigger = 'feed reached' | 'Enter pressed';

async function main(): Promise<void> {
  const statePath = path.resolve(config.linkedin.storageStatePath);
  const browser = await chromium.launch({ channel: config.linkedin.channel, headless: false });
  try {
    // Reusing an existing session lets a still-valid login jump straight to the feed and refresh the file.
    const context = await browser.newContext({
      storageState: existsSync(statePath) ? statePath : undefined,
      locale: 'en-US',
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    console.log('Log in to LinkedIn in the browser window that just opened.');
    console.log('The session is saved automatically once your feed loads, or press Enter here to save it now.');
    const trigger = await waitForFeedOrEnter(browser, context);

    await mkdir(path.dirname(statePath), { recursive: true });
    await context.storageState({ path: statePath });
    console.log(`Saved LinkedIn session (${trigger}) to ${statePath}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

function waitForFeedOrEnter(browser: Browser, context: BrowserContext): Promise<SaveTrigger> {
  const rl = readline.createInterface({ input: process.stdin });
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearInterval(poll);
      rl.close();
      browser.off('disconnected', onDisconnected);
    };
    const onDisconnected = (): void => {
      cleanup();
      reject(new Error('The browser was closed before the session was saved.'));
    };
    const poll = setInterval(() => {
      const onFeed = context.pages().some((p) => URL.canParse(p.url()) && new URL(p.url()).pathname.startsWith('/feed'));
      if (onFeed) {
        cleanup();
        resolve('feed reached');
      }
    }, POLL_MS);
    rl.once('line', () => {
      cleanup();
      resolve('Enter pressed');
    });
    browser.on('disconnected', onDisconnected);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
