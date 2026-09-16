/**
 * Deterministic, entirely fictional dataset behind the fake Apollo server.
 * Every company uses a reserved `.example` domain and every LinkedIn URL is
 * prefixed with `fake-`, so nothing here can collide with a real person.
 */

export interface FakeLocation {
  city: string;
  state: string | null;
  country: string;
}

type EmailPattern = 'first.last' | 'flast' | 'first';

export interface FakeOrganization {
  id: string;
  name: string;
  domain: string;
  industry: string;
  estimatedNumEmployees: number;
  foundedYear: number;
  shortDescription: string;
  focus: string;
  location: FakeLocation;
  emailPattern: EmailPattern;
  hasPhone: boolean;
  hasRevenue: boolean;
}

export interface ApolloEmploymentHistory {
  id: string;
  current: boolean;
  organization_id: string | null;
  organization_name: string;
  title: string;
  start_date: string;
  end_date: string | null;
}

export interface FakePerson {
  id: string;
  firstName: string;
  lastName: string;
  title: string;
  headline: string;
  email: string | null;
  emailStatus: 'verified' | 'unverified' | 'unavailable';
  linkedinUrl: string;
  photoUrl: string;
  location: FakeLocation;
  hasDirectPhone: boolean;
  lastRefreshedAt: string;
  employmentHistory: ApolloEmploymentHistory[];
  organization: FakeOrganization;
}

/** One row of POST /mixed_people/api_search `people[]`. */
export interface ApolloSearchHit {
  id: string;
  first_name: string;
  last_name_obfuscated: string;
  title: string;
  last_refreshed_at: string;
  has_email: boolean;
  has_city: boolean;
  has_state: boolean;
  has_country: boolean;
  has_direct_phone: 'Yes' | 'No';
  organization: {
    name: string;
    has_industry: boolean;
    has_phone: boolean;
    has_city: boolean;
    has_state: boolean;
    has_country: boolean;
    has_zip_code: boolean;
    has_revenue: boolean;
    has_employee_count: boolean;
  };
}

/** The `person` object of POST /people/match. */
export interface ApolloMatchPerson {
  id: string;
  /** Real Apollo returns this on every match; "none" only appears with waterfall enrichment, which we never request. */
  match_confidence: 'high';
  first_name: string;
  last_name: string;
  name: string;
  title: string;
  headline: string;
  email: string | null;
  email_status: string;
  linkedin_url: string;
  photo_url: string;
  city: string;
  state: string | null;
  country: string;
  organization_id: string;
  employment_history: ApolloEmploymentHistory[];
  organization: {
    id: string;
    name: string;
    industry: string;
    website_url: string;
    linkedin_url: string;
    primary_domain: string;
    estimated_num_employees: number;
    founded_year: number;
    short_description: string;
  };
}

type StaffSeed = readonly [firstName: string, lastName: string, title: string, remote?: FakeLocation];

interface CompanySeed {
  name: string;
  domain: string;
  industry: string;
  employees: number;
  founded: number;
  location: FakeLocation;
  emailPattern: EmailPattern;
  focus: string;
  description: string;
  hasPhone?: boolean;
  staff: readonly StaffSeed[];
}

const US = 'United States';
const UK = 'United Kingdom';

const COMPANY_SEEDS: readonly CompanySeed[] = [
  {
    name: 'Northwind Signal',
    domain: 'northwindsignal.example',
    industry: 'computer software',
    employees: 180,
    founded: 2017,
    location: { city: 'San Francisco', state: 'California', country: US },
    emailPattern: 'first.last',
    focus: 'AI revenue forecasting',
    description: 'Northwind Signal turns CRM activity into forecasts sales leaders can commit to.',
    staff: [
      ['Avery', 'Callahan', 'Chief Revenue Officer'],
      ['Priya', 'Raman', 'VP of Sales'],
      ['Marcus', 'Whitfield', 'Head of Revenue Operations'],
      ['Elena', 'Sokolova', 'Director of Sales Development'],
      ['Tobias', 'Lindqvist', 'Senior Account Executive', { city: 'Portland', state: 'Oregon', country: US }],
    ],
  },
  {
    name: 'Brightloop',
    domain: 'brightloop.example',
    industry: 'information technology & services',
    employees: 320,
    founded: 2015,
    location: { city: 'Austin', state: 'Texas', country: US },
    emailPattern: 'first.last',
    focus: 'customer retention',
    description: 'Brightloop is the customer success platform that flags churn risk before renewal season.',
    staff: [
      ['Nadia', 'Haddad', 'VP Sales'],
      ['Samuel', 'Okafor', 'Head of Growth'],
      ['Keiko', 'Tanabe', 'Director of Revenue Operations'],
      ['Diego', 'Marquez', 'Sales Development Manager'],
      ['Hannah', 'Brennan', 'VP Customer Success'],
    ],
  },
  {
    name: 'Ledgerline',
    domain: 'ledgerline.example',
    industry: 'financial services',
    employees: 95,
    founded: 2019,
    location: { city: 'New York', state: 'New York', country: US },
    emailPattern: 'flast',
    focus: 'finance automation for mid-market teams',
    description: 'Ledgerline automates close, reconciliation and spend controls for mid-market finance teams.',
    staff: [
      ['Omar', 'Farouk', 'Head of Sales'],
      ['Lucia', 'Bellini', 'Director of Demand Generation'],
      ['Felix', 'Hartmann', 'Revenue Operations Manager'],
      ['Ingrid', 'Solberg', 'Chief Revenue Officer', { city: 'Jersey City', state: 'New Jersey', country: US }],
      ['Rahul', 'Mehta', 'Enterprise Account Executive'],
    ],
  },
  {
    name: 'Quillstack',
    domain: 'quillstack.example',
    industry: 'computer software',
    employees: 60,
    founded: 2020,
    location: { city: 'Toronto', state: 'Ontario', country: 'Canada' },
    emailPattern: 'first',
    focus: 'sales engagement',
    description: 'Quillstack writes, sequences and times outbound so SDRs spend their day in conversations.',
    staff: [
      ['Chloe', 'Tremblay', 'Head of Growth'],
      ['Mateo', 'Alvarez', 'VP of Sales'],
      ['Sofia', 'Petrakis', 'Head of Revenue Operations'],
      ['Declan', 'Murphy', 'SDR Team Lead'],
      ['Amara', 'Nwosu', 'Director of Partnerships', { city: 'Vancouver', state: 'British Columbia', country: 'Canada' }],
    ],
  },
  {
    name: 'Harborview Analytics',
    domain: 'harborviewanalytics.example',
    industry: 'computer software',
    employees: 450,
    founded: 2013,
    location: { city: 'Boston', state: 'Massachusetts', country: US },
    emailPattern: 'first.last',
    focus: 'product analytics',
    description: 'Harborview Analytics shows B2B product teams which features actually drive expansion revenue.',
    staff: [
      ['Julian', 'Ashworth', 'Chief Revenue Officer'],
      ['Mei', 'Chen', 'VP of Revenue Operations'],
      ['Gabriel', 'Duarte', 'Director of Sales Development'],
      ['Freya', 'Nilsson', 'Head of Growth Marketing'],
      ['Tariq', 'Aziz', 'Regional VP Sales, East', { city: 'Philadelphia', state: 'Pennsylvania', country: US }],
    ],
  },
  {
    name: 'Tessellate HR',
    domain: 'tessellatehr.example',
    industry: 'human resources',
    employees: 210,
    founded: 2016,
    location: { city: 'London', state: 'England', country: UK },
    emailPattern: 'flast',
    focus: 'people operations',
    description: 'Tessellate HR runs onboarding, reviews and compensation cycles for distributed companies.',
    staff: [
      ['Isla', 'MacLeod', 'VP Sales EMEA'],
      ['Nikhil', 'Rao', 'Head of Revenue Operations'],
      ['Rosa', 'Jimenez', 'Director of Sales Development'],
      ['Henrik', 'Vestergaard', 'Chief Commercial Officer', { city: 'Copenhagen', state: 'Capital Region', country: 'Denmark' }],
      ['Zara', 'Whitaker', 'Growth Lead'],
    ],
  },
  {
    name: 'Cobaltforge',
    domain: 'cobaltforge.example',
    industry: 'computer software',
    employees: 140,
    founded: 2018,
    location: { city: 'Berlin', state: 'Berlin', country: 'Germany' },
    emailPattern: 'first.last',
    focus: 'developer platform tooling',
    description: 'Cobaltforge gives platform teams golden paths for shipping services without ticket queues.',
    staff: [
      ['Caleb', 'Morrison', 'Head of Sales'],
      ['Aisha', 'Bello', 'Head of Developer Growth'],
      ['Lars', 'Becker', 'Sales Operations Manager'],
      ['Bianca', 'Rossi', 'Director of Business Development', { city: 'Munich', state: 'Bavaria', country: 'Germany' }],
      ['Kwame', 'Mensah', 'Account Executive, DACH'],
    ],
  },
  {
    name: 'Pinecrest Cloud',
    domain: 'pinecrestcloud.example',
    industry: 'computer & network security',
    employees: 800,
    founded: 2012,
    location: { city: 'Seattle', state: 'Washington', country: US },
    emailPattern: 'flast',
    focus: 'cloud security posture management',
    description: 'Pinecrest Cloud continuously maps cloud misconfigurations to the teams who can fix them.',
    staff: [
      ['Noor', 'Rahman', 'Chief Revenue Officer'],
      ['Oliver', 'Grant', 'VP of Sales, North America'],
      ['Yuki', 'Morimoto', 'Senior Director, Revenue Operations'],
      ['Rafael', 'Costa', 'Director of Sales Development', { city: 'Austin', state: 'Texas', country: US }],
      ['Leah', 'Goldberg', 'Head of Growth'],
    ],
  },
  {
    name: 'Mosaic Commerce',
    domain: 'mosaiccommerce.example',
    industry: 'internet',
    employees: 75,
    founded: 2021,
    location: { city: 'Dublin', state: null, country: 'Ireland' },
    emailPattern: 'first',
    focus: 'commerce operations',
    description: 'Mosaic Commerce unifies inventory, orders and returns for fast-growing B2B wholesalers.',
    hasPhone: false,
    staff: [
      ['Dmitri', 'Volkov', 'Head of Revenue'],
      ['Camila', 'Reyes', 'Growth Marketing Manager'],
      ['Ethan', 'Doyle', 'Head of Sales'],
      ['Sanne', 'de Vries', 'Revenue Operations Lead', { city: 'Utrecht', state: 'Utrecht', country: 'Netherlands' }],
      ['Arjun', 'Kapoor', 'Business Development Representative'],
    ],
  },
  {
    name: 'Relaywell',
    domain: 'relaywell.example',
    industry: 'information technology & services',
    employees: 260,
    founded: 2016,
    location: { city: 'Chicago', state: 'Illinois', country: US },
    emailPattern: 'first.last',
    focus: 'conversational support',
    description: 'Relaywell resolves tier-one support conversations across chat, email and voice.',
    staff: [
      ['Maya', 'Patel', 'VP Sales'],
      ['Connor', 'Fitzgerald', 'Director of Sales Development'],
      ['Ines', 'Carvalho', 'Head of Revenue Operations'],
      ['Theo', 'Nakamura', 'VP Marketing & Growth', { city: 'Minneapolis', state: 'Minnesota', country: US }],
      ['Farah', 'Siddiqui', 'Enterprise Account Executive'],
    ],
  },
  {
    name: 'Fieldnote',
    domain: 'fieldnote.example',
    industry: 'computer software',
    employees: 130,
    founded: 2018,
    location: { city: 'Denver', state: 'Colorado', country: US },
    emailPattern: 'flast',
    focus: 'field service software',
    description: 'Fieldnote schedules, dispatches and invoices field technicians from a single mobile app.',
    staff: [
      ['Bruno', 'Ferreira', 'Chief Revenue Officer'],
      ['Clara', 'Hoffmann', 'Head of Growth'],
      ['Emeka', 'Obi', 'Sales Development Manager'],
      ['Hana', 'Kobayashi', 'Director of Revenue Operations'],
      ['Pablo', 'Navarro', 'VP of Sales', { city: 'Salt Lake City', state: 'Utah', country: US }],
    ],
  },
  {
    name: 'Orbitpay',
    domain: 'orbitpay.example',
    industry: 'financial services',
    employees: 520,
    founded: 2014,
    location: { city: 'Amsterdam', state: 'North Holland', country: 'Netherlands' },
    emailPattern: 'first.last',
    focus: 'cross-border B2B payments',
    description: 'Orbitpay moves supplier payouts across 40 currencies with same-day settlement.',
    staff: [
      ['Astrid', 'Johansson', 'VP Sales Europe'],
      ['Vikram', 'Iyer', 'Head of Revenue Operations'],
      ['Nora', 'Kessler', 'Director of Sales Development'],
      ['Silas', 'Oduya', 'Chief Revenue Officer', { city: 'London', state: 'England', country: UK }],
      ['Lena', 'Brandt', 'Head of Growth'],
      // Engineering leaders live at the end of the last company on purpose: person ids are handed out in
      // order, so appending here keeps every existing fake_person_NNN id stable.
      ['Tomas', 'Berger', 'CTO', { city: 'London', state: 'England', country: UK }],
      ['Ayesha', 'Rahman', 'VP Engineering', { city: 'London', state: 'England', country: UK }],
      ['Joon', 'Park', 'Head of Engineering'],
    ],
  },
  {
    // Appended last for the same reason: existing fake_person_NNN ids stay put.
    name: 'Sterlingcross',
    domain: 'sterlingcross.example',
    industry: 'financial services',
    employees: 240,
    founded: 2016,
    location: { city: 'London', state: 'England', country: UK },
    emailPattern: 'first.last',
    focus: 'open banking payments',
    description: 'Sterlingcross runs open banking payouts and reconciliation for UK lenders.',
    staff: [
      ['Imogen', 'Ashworth', 'CTO'],
      ['Dev', 'Anand', 'VP Engineering'],
      ['Marta', 'Dimitriou', 'Head of Engineering'],
      ['Callum', 'Halvorsen', 'VP Engineering', { city: 'Manchester', state: 'England', country: UK }],
      ['Yewande', 'Adeyemi', 'Head of Engineering'],
      ['Ines', 'Delacroix', 'Head of Platform Engineering'],
      ['Tomasz', 'Wozniak', 'Director of Engineering'],
    ],
  },
];

const PRIOR_EMPLOYERS = [
  'Vantage Ridge Software',
  'Copperline Systems',
  'Bluefin Data',
  'Summit Arc Labs',
  'Kestrel Works',
  'Meridian Stack',
] as const;

const PRIOR_TITLES = [
  'Regional Sales Director',
  'Senior Manager, Sales Development',
  'Revenue Operations Manager',
  'Growth Marketing Lead',
  'Senior Account Executive',
  'Sales Manager',
] as const;

/** All timestamps hang off a fixed instant so the dataset never drifts between runs. */
const DATASET_EPOCH_MS = Date.UTC(2026, 7, 28);

function pick<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length];
  if (item === undefined) throw new Error('pick() called on an empty list');
  return item;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function letters(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '');
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function emailLocalPart(pattern: EmailPattern, firstName: string, lastName: string): string {
  const first = letters(firstName);
  const last = letters(lastName);
  switch (pattern) {
    case 'first.last':
      return `${first}.${last}`;
    case 'flast':
      return `${first.slice(0, 1)}${last}`;
    case 'first':
      return first;
  }
}

function headlineFor(n: number, title: string, org: FakeOrganization): string {
  switch (n % 3) {
    case 0:
      return `${title} at ${org.name} | ${org.focus.charAt(0).toUpperCase()}${org.focus.slice(1)}`;
    case 1:
      return `${title} @ ${org.name} - building ${org.focus}`;
    default:
      return `Scaling ${org.focus} | ${title}, ${org.name}`;
  }
}

function buildOrganization(seed: CompanySeed, index: number): FakeOrganization {
  return {
    id: `fake_org_${pad(index + 1, 2)}`,
    name: seed.name,
    domain: seed.domain,
    industry: seed.industry,
    estimatedNumEmployees: seed.employees,
    foundedYear: seed.founded,
    shortDescription: seed.description,
    focus: seed.focus,
    location: seed.location,
    emailPattern: seed.emailPattern,
    hasPhone: seed.hasPhone ?? true,
    hasRevenue: seed.employees >= 100,
  };
}

function buildPerson(org: FakeOrganization, [firstName, lastName, title, remote]: StaffSeed, n: number): FakePerson {
  const id = `fake_person_${pad(n, 3)}`;
  const hasEmail = n % 20 !== 0;
  const startYear = 2018 + (n % 7);
  const currentStart = `${startYear}-${pad(((n * 5) % 12) + 1, 2)}-01`;
  const previousStart = `${startYear - 3}-${pad(((n * 7) % 12) + 1, 2)}-01`;

  return {
    id,
    firstName,
    lastName,
    title,
    headline: headlineFor(n, title, org),
    email: hasEmail ? `${emailLocalPart(org.emailPattern, firstName, lastName)}@${org.domain}` : null,
    emailStatus: !hasEmail ? 'unavailable' : n % 9 === 0 ? 'unverified' : 'verified',
    linkedinUrl: `https://www.linkedin.com/in/fake-${slug(firstName)}-${slug(lastName)}-${n}`,
    photoUrl: `https://images.example/apollo/${id}.jpg`,
    location: remote ?? org.location,
    hasDirectPhone: n % 3 === 0,
    lastRefreshedAt: new Date(DATASET_EPOCH_MS - n * 11 * 3_600_000).toISOString(),
    employmentHistory: [
      {
        id: `${id}_emp_1`,
        current: true,
        organization_id: org.id,
        organization_name: org.name,
        title,
        start_date: currentStart,
        end_date: null,
      },
      {
        id: `${id}_emp_2`,
        current: false,
        organization_id: null,
        organization_name: pick(PRIOR_EMPLOYERS, n),
        title: pick(PRIOR_TITLES, n * 5),
        start_date: previousStart,
        end_date: currentStart,
      },
    ],
    organization: org,
  };
}

/** 60 people, 5 per company, ids fake_person_001..060 in a stable order. */
export const FAKE_PEOPLE: readonly FakePerson[] = COMPANY_SEEDS.flatMap((seed, companyIndex) => {
  const org = buildOrganization(seed, companyIndex);
  return seed.staff.map((staff) => ({ org, staff }));
}).map(({ org, staff }, index) => buildPerson(org, staff, index + 1));

const PEOPLE_BY_ID = new Map(FAKE_PEOPLE.map((person) => [person.id, person]));

export function findFakePerson(id: string): FakePerson | undefined {
  return PEOPLE_BY_ID.get(id);
}

/** Apollo masks search results: first two characters, three stars, last character. */
export function obfuscateLastName(lastName: string): string {
  return `${lastName.slice(0, 2)}***${lastName.slice(-1)}`;
}

export function toSearchHit(person: FakePerson): ApolloSearchHit {
  const { location, organization: org } = person;
  return {
    id: person.id,
    first_name: person.firstName,
    last_name_obfuscated: obfuscateLastName(person.lastName),
    title: person.title,
    last_refreshed_at: person.lastRefreshedAt,
    has_email: person.email !== null,
    has_city: true,
    has_state: location.state !== null,
    has_country: true,
    has_direct_phone: person.hasDirectPhone ? 'Yes' : 'No',
    organization: {
      name: org.name,
      has_industry: true,
      has_phone: org.hasPhone,
      has_city: true,
      has_state: org.location.state !== null,
      has_country: true,
      has_zip_code: true,
      has_revenue: org.hasRevenue,
      has_employee_count: true,
    },
  };
}

export function toMatchPerson(person: FakePerson): ApolloMatchPerson {
  const org = person.organization;
  return {
    id: person.id,
    match_confidence: 'high',
    first_name: person.firstName,
    last_name: person.lastName,
    name: `${person.firstName} ${person.lastName}`,
    title: person.title,
    headline: person.headline,
    email: person.email,
    email_status: person.emailStatus,
    linkedin_url: person.linkedinUrl,
    photo_url: person.photoUrl,
    city: person.location.city,
    state: person.location.state,
    country: person.location.country,
    organization_id: org.id,
    employment_history: person.employmentHistory.map((entry) => ({ ...entry })),
    organization: {
      id: org.id,
      name: org.name,
      industry: org.industry,
      website_url: `http://www.${org.domain}`,
      linkedin_url: `http://www.linkedin.com/company/fake-${slug(org.name)}`,
      primary_domain: org.domain,
      estimated_num_employees: org.estimatedNumEmployees,
      founded_year: org.foundedYear,
      short_description: org.shortDescription,
    },
  };
}
