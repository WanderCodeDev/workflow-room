import type { Queryable } from '../db.ts';

export interface NewEvent {
  roomId: string;
  type: string;
  prospectId?: string | null;
  jobId?: string | null;
  actorMemberId?: string | null;
  data?: Record<string, unknown>;
}

/** Appends to the audit log. Call it with the same transaction as the state change it describes. */
export async function appendEvent(db: Queryable, event: NewEvent): Promise<void> {
  await db.query(
    `insert into events (room_id, prospect_id, job_id, actor_member_id, type, data)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      event.roomId,
      event.prospectId ?? null,
      event.jobId ?? null,
      event.actorMemberId ?? null,
      event.type,
      JSON.stringify(event.data ?? {}),
    ],
  );
}
