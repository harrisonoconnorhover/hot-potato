ALTER TABLE rep_calendar_connections
  ADD COLUMN IF NOT EXISTS check_conflicts boolean NOT NULL DEFAULT true;

UPDATE rep_calendar_connections connection
SET check_conflicts = true
FROM reps rep
WHERE connection.rep_id = rep.id
  AND connection.provider = rep.active_calendar_provider
  AND connection.check_conflicts = false;
