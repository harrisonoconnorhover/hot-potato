ALTER TABLE reps
  ADD COLUMN IF NOT EXISTS active_calendar_provider text
    CHECK (active_calendar_provider IN ('google', 'microsoft'));

UPDATE reps r
SET active_calendar_provider = (
  SELECT connection.provider
  FROM rep_calendar_connections connection
  WHERE connection.rep_id = r.id
  ORDER BY connection.updated_at DESC, connection.provider
  LIMIT 1
)
WHERE r.active_calendar_provider IS NULL
  AND EXISTS (
    SELECT 1 FROM rep_calendar_connections connection
    WHERE connection.rep_id = r.id
  );
