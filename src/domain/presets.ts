import type { CreateRoomInput } from './actions.ts';

export interface RoomPreset {
  label: string;
  room: Omit<CreateRoomInput, 'humans'>;
}

export const DEFAULT_HUMANS: CreateRoomInput['humans'] = [
  { handle: 'alice', displayName: 'Alice' },
  { handle: 'bob', displayName: 'Bob' },
];

/**
 * ICPs expressed as Apollo People Search filters. Deliberately no `q_keywords`: Apollo matches it against
 * indexed text, so a term like "SaaS" quietly drops companies that never use the word (the industry taxonomy
 * has no such value). Titles, locations and headcount do the filtering; the description carries the framing
 * for the drafter. Add keywords per room from the UI's custom form or `npm run cli -- create --keywords`.
 */
export const PRESETS: Record<string, RoomPreset> = {
  'saas-revenue-leaders': {
    label: 'Revenue leaders at mid-market US B2B SaaS',
    room: {
      objective: 'Book intro calls with revenue leaders at mid-market B2B SaaS companies',
      targetCount: 10,
      icp: {
        description: 'VP / Head of Sales or Revenue Operations at US B2B SaaS companies with 51-500 employees',
        pitch: 'We help revenue teams cut manual prospect research so reps spend their time selling',
        filters: {
          person_titles: ['VP of Sales', 'Head of Sales', 'VP Revenue Operations', 'Head of Revenue Operations'],
          include_similar_titles: true,
          person_locations: ['United States'],
          organization_num_employees_ranges: ['51,200', '201,500'],
        },
      },
    },
  },
  'fintech-engineering-leaders': {
    label: 'Engineering leaders at UK fintech scale-ups',
    room: {
      objective: 'Start conversations with engineering leaders at UK fintech scale-ups',
      targetCount: 10,
      icp: {
        description: 'CTO / VP Engineering at UK fintech companies with 51-1000 employees',
        pitch: 'We give platform teams audit-ready infrastructure change logs without extra tooling work',
        filters: {
          person_titles: ['CTO', 'VP Engineering', 'Head of Engineering'],
          include_similar_titles: true,
          person_locations: ['United Kingdom'],
          organization_num_employees_ranges: ['51,200', '201,500', '501,1000'],
        },
      },
    },
  },
};
