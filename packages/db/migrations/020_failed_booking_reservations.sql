DO $migration$
DECLARE
  conflicting_booking record;
BEGIN
  SELECT
    earlier.rep_id,
    earlier.id AS earlier_booking_id,
    earlier.status AS earlier_status,
    later.id AS later_booking_id,
    later.status AS later_status
  INTO conflicting_booking
  FROM bookings earlier
  JOIN bookings later
    ON later.rep_id = earlier.rep_id
   AND later.id > earlier.id
  WHERE earlier.status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
    )
    AND later.status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
    )
    AND (
      tstzrange(earlier.starts_at, earlier.ends_at, '[)')
        && tstzrange(later.starts_at, later.ends_at, '[)')
      OR (
        earlier.status = 'reschedule_pending'
        AND tstzrange(
          earlier.previous_starts_at,
          earlier.previous_ends_at,
          '[)'
        ) && tstzrange(later.starts_at, later.ends_at, '[)')
      )
      OR (
        later.status = 'reschedule_pending'
        AND tstzrange(earlier.starts_at, earlier.ends_at, '[)')
          && tstzrange(
            later.previous_starts_at,
            later.previous_ends_at,
            '[)'
          )
      )
      OR (
        earlier.status = 'reschedule_pending'
        AND later.status = 'reschedule_pending'
        AND tstzrange(
          earlier.previous_starts_at,
          earlier.previous_ends_at,
          '[)'
        ) && tstzrange(
          later.previous_starts_at,
          later.previous_ends_at,
          '[)'
        )
      )
    )
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Cannot reserve failed calendar creates: rep %s has overlapping bookings %s (%s) and %s (%s).',
        conflicting_booking.rep_id,
        conflicting_booking.earlier_booking_id,
        conflicting_booking.earlier_status,
        conflicting_booking.later_booking_id,
        conflicting_booking.later_status
      ),
      HINT = 'Reconcile each failed calendar.event.create with its provider. Delete/cancel any owned provider event or otherwise repair the overlap before rerunning the migration.';
  END IF;
END
$migration$;

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_rep_active_time_excl;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_rep_active_time_excl
  EXCLUDE USING gist (
    rep_id WITH =,
    (
      CASE
        WHEN status = 'reschedule_pending' THEN tstzmultirange(
          tstzrange(starts_at, ends_at, '[)'),
          tstzrange(previous_starts_at, previous_ends_at, '[)')
        )
        ELSE tstzmultirange(tstzrange(starts_at, ends_at, '[)'))
      END
    ) WITH &&
  )
  WHERE (
    status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
    )
  );

-- Retire the legacy job-based slot guard only after the failed-booking
-- reservation preflight and replacement exclusion have both succeeded in this
-- same migration transaction.
DROP INDEX IF EXISTS jobs_calendar_rep_slot_idx;
