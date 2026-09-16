-- A cancelled or dead lookup must not use up the room's single LinkedIn slot: if the first prospect is
-- decided by a human before its lookup runs, the next prospect should be able to take the slot.
drop index jobs_one_linkedin_per_room;

create unique index jobs_one_linkedin_per_room on jobs (room_id)
  where kind = 'linkedin' and status not in ('cancelled', 'dead');
