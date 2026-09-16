// Validates an Apollo API key and its scopes before running the agent.
// People Search costs 0 credits, so the default check is free; --enrich also verifies people/match (1 credit).
import { config } from '../config.ts';
import { ApolloClient, ApolloError } from './apollo.ts';

const withEnrich = process.argv.includes('--enrich');

if (!config.apollo.apiKey) {
  console.error('APOLLO_API_KEY is not set. Put it in .env (see .env.example).');
  process.exit(1);
}

const client = new ApolloClient(config.apollo);
console.log(`Apollo base URL : ${config.apollo.baseUrl}`);
console.log(`API key         : ${mask(config.apollo.apiKey)}`);

try {
  const search = await client.searchPeople({ person_titles: ['VP of Sales'], person_locations: ['United States'] }, 1, 1);
  console.log(`\nsearch (0 credits): HTTP ${search.status} — ${search.data.people.length} returned of ${search.data.total_entries ?? '?'} matches`);
  const first = search.data.people[0];
  if (first) {
    const name = [first.first_name, first.last_name_obfuscated].filter(Boolean).join(' ');
    console.log(`  sample: ${name} — ${first.title ?? '?'} @ ${first.organization?.name ?? '?'} (id ${first.id})`);
  }
  printLimits(search.rateHeaders);

  if (!withEnrich) {
    console.log('\nEnrichment not checked (it costs 1 credit). Re-run with:  npm run apollo:check -- --enrich');
  } else if (!first) {
    console.log('\nNo search result to enrich.');
  } else {
    const match = await client.matchPerson(first.id);
    const person = match.data.person;
    console.log(`\nenrich (1 credit): HTTP ${match.status} — match_confidence ${person?.match_confidence ?? 'absent'}`);
    if (person) {
      console.log(`  ${person.name ?? '?'} — ${person.title ?? '?'} @ ${person.organization?.name ?? '?'}`);
      console.log(`  email_status ${person.email_status ?? 'none'} · linkedin ${person.linkedin_url ?? 'none'}`);
    }
    printLimits(match.rateHeaders);
  }

  // Scopes are per endpoint, so a search-only check says nothing about people/match.
  console.log(
    withEnrich
      ? '\nKey works for both endpoints this app uses.'
      : '\nSearch scope OK. people/match was NOT verified — a key scoped to one endpoint returns 403 on the other.' +
          '\nRe-run with --enrich (1 credit) before the demo.',
  );
} catch (err) {
  if (err instanceof ApolloError) {
    console.error(`\nApollo call failed (${err.kind}${err.status ? `, HTTP ${err.status}` : ''}):\n  ${err.message}`);
    process.exit(1);
  }
  throw err;
}

function printLimits(headers: Record<string, string>): void {
  const windows: [string, string, string][] = [
    ['minute', 'x-minute-requests-left', 'x-rate-limit-minute'],
    ['hour', 'x-hourly-requests-left', 'x-rate-limit-hourly'],
    ['day', 'x-24-hour-requests-left', 'x-rate-limit-24-hour'],
  ];
  const parts = windows
    .filter(([, left]) => headers[left] !== undefined)
    .map(([label, left, limit]) => `${label} ${headers[left]}/${headers[limit] ?? '?'} left`);
  if (parts.length) console.log(`  rate limits: ${parts.join(' · ')}`);
}

function mask(key: string): string {
  return key.length <= 6 ? '***' : `${key.slice(0, 3)}…${key.slice(-3)} (${key.length} chars)`;
}
