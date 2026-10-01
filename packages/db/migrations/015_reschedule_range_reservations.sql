ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS previous_starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS previous_ends_at timestamptz;

DO $migration$
DECLARE
  pending_booking record;
  lifecycle_job record;
  active_job_count integer;
  requested_start timestamptz;
  requested_end timestamptz;
  previous_start timestamptz;
  previous_end timestamptz;
BEGIN
  FOR pending_booking IN
    SELECT b.id, b.organization_id, b.rep_id, b.external_id,
           b.external_event_id, b.calendar_provider, b.starts_at, b.ends_at,
           o.slug AS organization_slug
    FROM bookings b
    JOIN organizations o ON o.id = b.organization_id
    WHERE b.status = 'reschedule_pending'
  LOOP
    SELECT count(*)::integer
    INTO active_job_count
    FROM jobs j
    WHERE j.type = 'calendar.event.update'
      AND j.payload->>'bookingId' = pending_booking.id::text
      AND j.status IN ('pending', 'processing');

    IF active_job_count <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill reschedule reservation for booking %s: expected one active calendar update job, found %s.',
          pending_booking.id,
          active_job_count
        ),
        HINT = 'Restore exactly one pending or processing calendar.event.update job for this booking, then rerun the migration.';
    END IF;

    SELECT j.id, j.organization_id, j.payload
    INTO lifecycle_job
    FROM jobs j
    WHERE j.type = 'calendar.event.update'
      AND j.payload->>'bookingId' = pending_booking.id::text
      AND j.status IN ('pending', 'processing')
    FOR UPDATE;

    IF lifecycle_job.organization_id IS DISTINCT FROM pending_booking.organization_id
       OR lifecycle_job.payload->>'externalId' IS DISTINCT FROM pending_booking.external_id
       OR lifecycle_job.payload->>'organizationSlug' IS DISTINCT FROM pending_booking.organization_slug
       OR lifecycle_job.payload->>'repId' IS DISTINCT FROM pending_booking.rep_id::text
       OR lifecycle_job.payload->>'provider' IS DISTINCT FROM pending_booking.calendar_provider
       OR lifecycle_job.payload->>'externalEventId' IS DISTINCT FROM pending_booking.external_event_id
       OR pending_booking.external_event_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill reschedule reservation for booking %s: calendar update job %s has mismatched organization, booking, rep, provider, or provider-event identity.',
          pending_booking.id,
          lifecycle_job.id
        ),
        HINT = 'Repair the active calendar.event.update job from the original booking and provider event, then rerun the migration.';
    END IF;

    BEGIN
      requested_start := nullif(
        lifecycle_job.payload->>'startsAt',
        ''
      )::timestamptz;
      requested_end := nullif(
        lifecycle_job.payload->>'endsAt',
        ''
      )::timestamptz;
      previous_start := nullif(
        lifecycle_job.payload->>'previousStartsAt',
        ''
      )::timestamptz;
      previous_end := nullif(
        lifecycle_job.payload->>'previousEndsAt',
        ''
      )::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill reschedule reservation for booking %s: calendar update job %s has invalid requested or previous times.',
          pending_booking.id,
          lifecycle_job.id
        ),
        HINT = 'Repair startsAt, endsAt, previousStartsAt, and previousEndsAt in the active calendar.event.update job, then rerun the migration.';
    END;

    IF requested_start IS NULL OR requested_end IS NULL
       OR requested_end <= requested_start
       OR requested_start IS DISTINCT FROM pending_booking.starts_at
       OR requested_end IS DISTINCT FROM pending_booking.ends_at
       OR previous_start IS NULL OR previous_end IS NULL
       OR previous_end <= previous_start THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot backfill reschedule reservation for booking %s: calendar update job %s does not preserve its exact requested and previous ranges.',
          pending_booking.id,
          lifecycle_job.id
        ),
        HINT = 'Reconcile the booking range and the active update job ranges from provider evidence, then rerun the migration.';
    END IF;

    UPDATE bookings
    SET previous_starts_at = previous_start,
        previous_ends_at = previous_end
    WHERE id = pending_booking.id;
  END LOOP;

  FOR pending_booking IN
    SELECT b.id, b.organization_id, b.rep_id, b.external_id,
           b.external_event_id, b.calendar_provider, o.slug AS organization_slug
    FROM bookings b
    JOIN organizations o ON o.id = b.organization_id
    WHERE b.status = 'cancel_pending'
  LOOP
    SELECT count(*)::integer
    INTO active_job_count
    FROM jobs j
    WHERE j.type = 'calendar.event.cancel'
      AND j.payload->>'bookingId' = pending_booking.id::text
      AND j.status IN ('pending', 'processing');

    IF active_job_count <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot validate pending cancellation for booking %s: expected one active calendar cancellation job, found %s.',
          pending_booking.id,
          active_job_count
        ),
        HINT = 'Restore exactly one pending or processing calendar.event.cancel job for this booking, then rerun the migration.';
    END IF;

    SELECT j.id, j.organization_id, j.payload
    INTO lifecycle_job
    FROM jobs j
    WHERE j.type = 'calendar.event.cancel'
      AND j.payload->>'bookingId' = pending_booking.id::text
      AND j.status IN ('pending', 'processing')
    FOR UPDATE;

    IF lifecycle_job.organization_id IS DISTINCT FROM pending_booking.organization_id
       OR lifecycle_job.payload->>'externalId' IS DISTINCT FROM pending_booking.external_id
       OR lifecycle_job.payload->>'organizationSlug' IS DISTINCT FROM pending_booking.organization_slug
       OR lifecycle_job.payload->>'repId' IS DISTINCT FROM pending_booking.rep_id::text
       OR lifecycle_job.payload->>'provider' IS DISTINCT FROM pending_booking.calendar_provider
       OR lifecycle_job.payload->>'externalEventId' IS DISTINCT FROM pending_booking.external_event_id
       OR pending_booking.external_event_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format(
          'Cannot validate pending cancellation for booking %s: calendar cancellation job %s has mismatched organization, booking, rep, provider, or provider-event identity.',
          pending_booking.id,
          lifecycle_job.id
        ),
        HINT = 'Repair the active calendar.event.cancel job from the original booking and provider event, then rerun the migration.';
    END IF;
  END LOOP;
END
$migration$;

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
  WHERE earlier.status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending'
    )
    AND later.status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending'
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
        'Cannot enable durable reschedule reservations: rep %s has overlapping active bookings %s and %s.',
        conflicting_booking.rep_id,
        conflicting_booking.earlier_booking_id,
        conflicting_booking.later_booking_id
      ),
      HINT = 'Cancel, fail, or complete one of the overlapping bookings, then rerun the migration.';
  END IF;
END
$migration$;

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_rep_active_time_excl;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_previous_time_pair_check CHECK (
    (previous_starts_at IS NULL) = (previous_ends_at IS NULL)
  ),
  ADD CONSTRAINT bookings_reschedule_previous_time_check CHECK (
    (status = 'reschedule_pending') = (previous_starts_at IS NOT NULL)
  ),
  ADD CONSTRAINT bookings_previous_time_order_check CHECK (
    previous_starts_at IS NULL OR previous_ends_at > previous_starts_at
  ),
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
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending'
    )
  );
