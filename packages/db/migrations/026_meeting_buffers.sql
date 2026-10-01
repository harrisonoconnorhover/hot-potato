ALTER TABLE meeting_types
  ADD COLUMN buffer_before_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN buffer_after_minutes integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT meeting_types_buffer_before_check CHECK (
    buffer_before_minutes BETWEEN 0 AND 480
  ),
  ADD CONSTRAINT meeting_types_buffer_after_check CHECK (
    buffer_after_minutes BETWEEN 0 AND 480
  );

-- Snapshot buffer policy on each booking. Editing a meeting type must not
-- silently change the reserved range of an already-confirmed meeting.
ALTER TABLE bookings
  ADD COLUMN buffer_before_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN buffer_after_minutes integer NOT NULL DEFAULT 0,
  ADD COLUMN reserved_starts_at timestamptz,
  ADD COLUMN reserved_ends_at timestamptz,
  ADD COLUMN previous_reserved_starts_at timestamptz,
  ADD COLUMN previous_reserved_ends_at timestamptz,
  ADD CONSTRAINT bookings_buffer_before_check CHECK (
    buffer_before_minutes BETWEEN 0 AND 480
  ),
  ADD CONSTRAINT bookings_buffer_after_check CHECK (
    buffer_after_minutes BETWEEN 0 AND 480
  );

UPDATE bookings
SET reserved_starts_at =
      starts_at - buffer_before_minutes * interval '1 minute',
    reserved_ends_at =
      ends_at + buffer_after_minutes * interval '1 minute',
    previous_reserved_starts_at = CASE
      WHEN previous_starts_at IS NULL THEN NULL
      ELSE previous_starts_at - buffer_before_minutes * interval '1 minute'
    END,
    previous_reserved_ends_at = CASE
      WHEN previous_ends_at IS NULL THEN NULL
      ELSE previous_ends_at + buffer_after_minutes * interval '1 minute'
    END;

ALTER TABLE bookings
  ALTER COLUMN reserved_starts_at SET NOT NULL,
  ALTER COLUMN reserved_ends_at SET NOT NULL,
  ADD CONSTRAINT bookings_reserved_time_check CHECK (
    reserved_ends_at > reserved_starts_at
  ),
  ADD CONSTRAINT bookings_previous_reserved_time_pair_check CHECK (
    (previous_reserved_starts_at IS NULL) =
      (previous_reserved_ends_at IS NULL)
  ),
  ADD CONSTRAINT bookings_previous_reserved_time_order_check CHECK (
    previous_reserved_starts_at IS NULL
    OR previous_reserved_ends_at > previous_reserved_starts_at
  );

CREATE OR REPLACE FUNCTION hot_potato_set_booking_reserved_ranges()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.reserved_starts_at :=
    NEW.starts_at - NEW.buffer_before_minutes * interval '1 minute';
  NEW.reserved_ends_at :=
    NEW.ends_at + NEW.buffer_after_minutes * interval '1 minute';

  IF NEW.previous_starts_at IS NULL THEN
    NEW.previous_reserved_starts_at := NULL;
    NEW.previous_reserved_ends_at := NULL;
  ELSE
    NEW.previous_reserved_starts_at :=
      NEW.previous_starts_at
        - NEW.buffer_before_minutes * interval '1 minute';
    NEW.previous_reserved_ends_at :=
      NEW.previous_ends_at
        + NEW.buffer_after_minutes * interval '1 minute';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER bookings_set_reserved_ranges
BEFORE INSERT OR UPDATE OF
  starts_at, ends_at, previous_starts_at, previous_ends_at,
  buffer_before_minutes, buffer_after_minutes
ON bookings
FOR EACH ROW
EXECUTE FUNCTION hot_potato_set_booking_reserved_ranges();

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_rep_active_time_excl,
  DROP CONSTRAINT IF EXISTS bookings_provider_account_active_time_excl;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_rep_active_time_excl
  EXCLUDE USING gist (
    rep_id WITH =,
    (
      CASE
        WHEN status IN ('reschedule_pending', 'cancel_pending')
          AND previous_reserved_starts_at IS NOT NULL
          AND previous_reserved_ends_at IS NOT NULL
        THEN tstzmultirange(
          tstzrange(reserved_starts_at, reserved_ends_at, '[)'),
          tstzrange(
            previous_reserved_starts_at,
            previous_reserved_ends_at,
            '[)'
          )
        )
        ELSE tstzmultirange(
          tstzrange(reserved_starts_at, reserved_ends_at, '[)')
        )
      END
    ) WITH &&
  )
  WHERE (
    status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
    )
  );

ALTER TABLE bookings
  ADD CONSTRAINT bookings_provider_account_active_time_excl
  EXCLUDE USING gist (
    calendar_provider WITH =,
    calendar_external_account_id WITH =,
    (
      CASE
        WHEN status IN ('reschedule_pending', 'cancel_pending')
          AND previous_reserved_starts_at IS NOT NULL
          AND previous_reserved_ends_at IS NOT NULL
        THEN tstzmultirange(
          tstzrange(reserved_starts_at, reserved_ends_at, '[)'),
          tstzrange(
            previous_reserved_starts_at,
            previous_reserved_ends_at,
            '[)'
          )
        )
        ELSE tstzmultirange(
          tstzrange(reserved_starts_at, reserved_ends_at, '[)')
        )
      END
    ) WITH &&
  )
  WHERE (
    calendar_external_account_id IS NOT NULL
    AND status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
    )
  );
