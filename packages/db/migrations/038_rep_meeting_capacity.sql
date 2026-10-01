ALTER TABLE reps
  ADD COLUMN daily_meeting_limit integer,
  ADD COLUMN weekly_meeting_limit integer,
  ADD CONSTRAINT reps_daily_meeting_limit_check CHECK (
    daily_meeting_limit IS NULL OR daily_meeting_limit BETWEEN 1 AND 100
  ),
  ADD CONSTRAINT reps_weekly_meeting_limit_check CHECK (
    weekly_meeting_limit IS NULL OR weekly_meeting_limit BETWEEN 1 AND 500
  );

CREATE INDEX bookings_rep_capacity_starts_idx
  ON bookings (rep_id, starts_at)
  WHERE status IN (
    'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
  );

CREATE INDEX bookings_rep_capacity_previous_starts_idx
  ON bookings (rep_id, previous_starts_at)
  WHERE previous_starts_at IS NOT NULL
    AND status IN ('reschedule_pending', 'cancel_pending');

CREATE OR REPLACE FUNCTION hot_potato_enforce_rep_meeting_capacity()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  rep_timezone text;
  daily_limit integer;
  weekly_limit integer;
  capacity_start timestamptz;
  capacity_date date;
  capacity_week date;
  used_count integer;
  already_counted_daily boolean;
  already_counted_weekly boolean;
BEGIN
  IF NEW.status NOT IN (
    'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
  ) THEN
    RETURN NEW;
  END IF;

  -- Lifecycle-only updates must keep working if an administrator lowers a
  -- limit below already-booked volume. Enforce only when a booking enters the
  -- active ledger or changes one of its capacity periods.
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
    )
      AND OLD.rep_id = NEW.rep_id
      AND OLD.starts_at = NEW.starts_at
      AND OLD.previous_starts_at IS NOT DISTINCT FROM NEW.previous_starts_at
    THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT timezone, daily_meeting_limit, weekly_meeting_limit
  INTO rep_timezone, daily_limit, weekly_limit
  FROM reps
  WHERE id = NEW.rep_id;

  IF daily_limit IS NULL AND weekly_limit IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(NEW.rep_id::text));

  FOR capacity_start IN
    SELECT DISTINCT candidate.starts_at
    FROM (
      VALUES
        (NEW.starts_at),
        (
          CASE
            WHEN NEW.status IN ('reschedule_pending', 'cancel_pending')
              THEN NEW.previous_starts_at
            ELSE NULL
          END
        )
    ) AS candidate(starts_at)
    WHERE candidate.starts_at IS NOT NULL
  LOOP
    capacity_date := (capacity_start AT TIME ZONE rep_timezone)::date;
    capacity_week := date_trunc(
      'week', capacity_start AT TIME ZONE rep_timezone
    )::date;

    already_counted_daily := false;
    already_counted_weekly := false;
    IF TG_OP = 'UPDATE' AND OLD.status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
    ) THEN
      SELECT
        coalesce(bool_or(
          (old_start.starts_at AT TIME ZONE rep_timezone)::date = capacity_date
        ), false),
        coalesce(bool_or(
          date_trunc(
            'week', old_start.starts_at AT TIME ZONE rep_timezone
          )::date = capacity_week
        ), false)
      INTO already_counted_daily, already_counted_weekly
      FROM (
        SELECT DISTINCT candidate.starts_at
        FROM (
          VALUES
            (OLD.starts_at),
            (
              CASE
                WHEN OLD.status IN ('reschedule_pending', 'cancel_pending')
                  THEN OLD.previous_starts_at
                ELSE NULL
              END
            )
        ) AS candidate(starts_at)
        WHERE candidate.starts_at IS NOT NULL
      ) old_start;
    END IF;

    IF daily_limit IS NOT NULL AND NOT already_counted_daily THEN
      SELECT count(DISTINCT booking.id)::integer
      INTO used_count
      FROM bookings booking
      CROSS JOIN LATERAL (
        SELECT DISTINCT candidate.starts_at
        FROM (
          VALUES
            (booking.starts_at),
            (
              CASE
                WHEN booking.status IN ('reschedule_pending', 'cancel_pending')
                  THEN booking.previous_starts_at
                ELSE NULL
              END
            )
        ) AS candidate(starts_at)
        WHERE candidate.starts_at IS NOT NULL
      ) active_start
      WHERE booking.rep_id = NEW.rep_id
        AND booking.id <> NEW.id
        AND booking.status IN (
          'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
        )
        AND (active_start.starts_at AT TIME ZONE rep_timezone)::date = capacity_date;

      IF used_count >= daily_limit THEN
        RAISE EXCEPTION USING
          ERRCODE = '23P01',
          CONSTRAINT = 'bookings_rep_meeting_capacity_check',
          MESSAGE = 'Representative daily meeting capacity is full.';
      END IF;
    END IF;

    IF weekly_limit IS NOT NULL AND NOT already_counted_weekly THEN
      SELECT count(DISTINCT booking.id)::integer
      INTO used_count
      FROM bookings booking
      CROSS JOIN LATERAL (
        SELECT DISTINCT candidate.starts_at
        FROM (
          VALUES
            (booking.starts_at),
            (
              CASE
                WHEN booking.status IN ('reschedule_pending', 'cancel_pending')
                  THEN booking.previous_starts_at
                ELSE NULL
              END
            )
        ) AS candidate(starts_at)
        WHERE candidate.starts_at IS NOT NULL
      ) active_start
      WHERE booking.rep_id = NEW.rep_id
        AND booking.id <> NEW.id
        AND booking.status IN (
          'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
        )
        AND date_trunc(
          'week', active_start.starts_at AT TIME ZONE rep_timezone
        )::date = capacity_week;

      IF used_count >= weekly_limit THEN
        RAISE EXCEPTION USING
          ERRCODE = '23P01',
          CONSTRAINT = 'bookings_rep_meeting_capacity_check',
          MESSAGE = 'Representative weekly meeting capacity is full.';
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END
$function$;

CREATE TRIGGER bookings_enforce_rep_meeting_capacity
BEFORE INSERT OR UPDATE OF
  rep_id, starts_at, previous_starts_at, status
ON bookings
FOR EACH ROW
EXECUTE FUNCTION hot_potato_enforce_rep_meeting_capacity();
