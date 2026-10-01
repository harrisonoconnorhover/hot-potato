DO $migration$
DECLARE
  conflicting_booking record;
BEGIN
  SELECT
    earlier.rep_id,
    earlier.id AS earlier_booking_id,
    later.id AS later_booking_id
  INTO conflicting_booking
  FROM bookings earlier
  JOIN bookings later
    ON later.rep_id = earlier.rep_id
   AND later.id > earlier.id
   AND tstzrange(later.starts_at, later.ends_at, '[)')
       && tstzrange(earlier.starts_at, earlier.ends_at, '[)')
  WHERE earlier.status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending'
    )
    AND later.status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending'
    )
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Cannot enable durable booking ranges: rep %s has overlapping active bookings %s and %s.',
        conflicting_booking.rep_id,
        conflicting_booking.earlier_booking_id,
        conflicting_booking.later_booking_id
      ),
      HINT = 'Cancel, fail, or reschedule one of the overlapping bookings, then rerun the migration.';
  END IF;
END
$migration$;

DROP INDEX IF EXISTS bookings_rep_active_slot_idx;

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_rep_active_time_excl
  EXCLUDE USING gist (
    rep_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
  WHERE (
    status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending'
    )
  );
