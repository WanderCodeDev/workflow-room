import { config } from '../config.ts';
import { fetchLinkedInHeadline } from './linkedin.ts';

const profileUrl = process.argv[2];
if (!profileUrl) {
  console.error('Usage: npm run linkedin:check -- <https://www.linkedin.com/in/profile>');
  process.exit(1);
}

// Ctrl+C aborts the lookup so the browser is closed instead of orphaned.
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

try {
  const result = await fetchLinkedInHeadline(profileUrl, {
    headless: config.linkedin.headless,
    channel: config.linkedin.channel,
    storageStatePath: config.linkedin.storageStatePath,
    artifactsDir: config.artifactsDir,
    timeoutMs: config.linkedin.timeoutMs,
    signal: controller.signal,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exitCode = 1;
}
