export const STAGES = ['new', 'enriched', 'awaiting_review', 'approved', 'skipped'] as const;
export type Stage = (typeof STAGES)[number];
export const TERMINAL_STAGES: readonly Stage[] = ['approved', 'skipped'];

export type JobKind = 'search' | 'enrich' | 'draft' | 'linkedin';
export type JobStatus = 'pending' | 'running' | 'succeeded' | 'dead' | 'cancelled';
export type RoomStatus = 'active' | 'paused';
export type MemberKind = 'human' | 'agent';

/** Apollo `mixed_people/api_search` filters we support (sent verbatim). */
export interface ApolloSearchFilters {
  person_titles?: string[];
  include_similar_titles?: boolean;
  person_seniorities?: string[];
  person_locations?: string[];
  organization_locations?: string[];
  organization_num_employees_ranges?: string[];
  q_keywords?: string;
  contact_email_status?: string[];
}

export interface Icp {
  /** Free-text ICP, shown to humans and given to the drafter. */
  description: string;
  /** One-sentence value proposition the outreach note should carry. */
  pitch?: string;
  filters: ApolloSearchFilters;
}

/** Subset of an Apollo search hit (search results carry obfuscated last names, no contact data). */
export interface ApolloSearchPerson {
  id: string;
  first_name?: string | null;
  last_name_obfuscated?: string | null;
  title?: string | null;
  organization?: { name?: string | null } | null;
  [key: string]: unknown;
}

/** Subset of an Apollo `people/match` person. */
export interface ApolloPerson {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  title?: string | null;
  headline?: string | null;
  email?: string | null;
  email_status?: string | null;
  /** "high" | "medium" | "low" | "none" — "none" means Apollo could not identify the person. */
  match_confidence?: string | null;
  linkedin_url?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  organization?: {
    id?: string | null;
    name?: string | null;
    industry?: string | null;
    website_url?: string | null;
    estimated_num_employees?: number | null;
    short_description?: string | null;
    [key: string]: unknown;
  } | null;
  employment_history?: unknown[];
  [key: string]: unknown;
}

export interface RoomRow {
  id: string;
  objective: string;
  icp: Icp;
  target_count: number;
  status: RoomStatus;
  agent_member_id: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface MemberRow {
  id: string;
  room_id: string;
  handle: string;
  display_name: string;
  kind: MemberKind;
}

export interface ProspectRow {
  id: string;
  room_id: string;
  position: number;
  apollo_person_id: string;
  stage: Stage;
  owner_member_id: string;
  display_name: string;
  title: string | null;
  company: string | null;
  search_result: ApolloSearchPerson;
  draft_revision: number;
  handback_note: string | null;
  final_note: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  last_error: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface JobRow {
  id: string;
  room_id: string;
  prospect_id: string | null;
  kind: JobKind;
  idempotency_key: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  run_after: Date;
  attempts: number;
  claims: number;
  deferrals: number;
  locked_by: string | null;
  lease_expires_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

/** Result of a human action. Failures are expected outcomes (lost a race, stale view), not exceptions. */
export type ActionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ActionErrorCode; message: string };

export type ActionErrorCode = 'conflict' | 'not_found' | 'forbidden' | 'room_paused' | 'invalid';
