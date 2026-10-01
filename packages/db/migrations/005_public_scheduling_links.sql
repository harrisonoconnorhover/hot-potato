ALTER TABLE reps
  ADD COLUMN IF NOT EXISTS scheduling_slug text,
  ADD COLUMN IF NOT EXISTS scheduling_link_active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS meeting_title text NOT NULL DEFAULT 'Intro meeting',
  ADD COLUMN IF NOT EXISTS meeting_description text NOT NULL DEFAULT 'Pick a time that works for you.',
  ADD COLUMN IF NOT EXISTS meeting_duration_minutes integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS minimum_notice_minutes integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS booking_window_days integer NOT NULL DEFAULT 14;

WITH normalized AS (
  SELECT
    id,
    organization_id,
    coalesce(
      nullif(
        trim(BOTH '-' FROM regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')),
        ''
      ),
      'rep'
    ) AS base_slug
  FROM reps
  WHERE scheduling_slug IS NULL
), ranked AS (
  SELECT
    id,
    base_slug,
    row_number() OVER (
      PARTITION BY organization_id, base_slug
      ORDER BY id
    ) AS duplicate_number
  FROM normalized
)
UPDATE reps r
SET scheduling_slug = CASE
  WHEN ranked.duplicate_number = 1 THEN ranked.base_slug
  ELSE ranked.base_slug || '-' || ranked.duplicate_number::text
END
FROM ranked
WHERE r.id = ranked.id;

ALTER TABLE reps
  ALTER COLUMN scheduling_slug SET NOT NULL,
  ADD CONSTRAINT reps_scheduling_slug_format_check
    CHECK (scheduling_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ADD CONSTRAINT reps_meeting_duration_check
    CHECK (meeting_duration_minutes BETWEEN 15 AND 480),
  ADD CONSTRAINT reps_minimum_notice_check
    CHECK (minimum_notice_minutes BETWEEN 0 AND 43200),
  ADD CONSTRAINT reps_booking_window_check
    CHECK (booking_window_days BETWEEN 1 AND 365);

CREATE UNIQUE INDEX IF NOT EXISTS reps_org_scheduling_slug_idx
  ON reps (organization_id, scheduling_slug);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_calendar_rep_slot_idx
  ON jobs ((payload->>'repId'), (payload->>'startsAt'))
  WHERE type = 'calendar.event.create';
