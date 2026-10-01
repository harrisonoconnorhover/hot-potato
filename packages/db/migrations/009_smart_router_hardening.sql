ALTER TABLE router_qualification_sessions
  ADD COLUMN IF NOT EXISTS redacted_at timestamptz;

CREATE INDEX IF NOT EXISTS router_sessions_booked_redaction_idx
  ON router_qualification_sessions (booked_at)
  WHERE booked_at IS NOT NULL AND redacted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_calendar_rep_slot_idx
  ON jobs ((payload->>'repId'), (payload->>'startsAt'))
  WHERE type = 'calendar.event.create';
