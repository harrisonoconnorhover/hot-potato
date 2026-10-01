UPDATE jobs create_job
SET status = 'failed',
    locked_at = null,
    claim_token = null,
    last_error = coalesce(
      create_job.last_error,
      'Legacy cancelled calendar creation requires provider reconciliation.'
    )
FROM bookings booking
WHERE booking.organization_id = create_job.organization_id
  AND booking.id::text = create_job.payload->>'bookingId'
  AND booking.status = 'failed'
  AND booking.router_session_id IS NULL
  AND create_job.type = 'calendar.event.create'
  AND create_job.status = 'cancelled';

DO $migration$
DECLARE
  inconsistent_booking record;
BEGIN
  SELECT
    booking.id,
    booking.external_id,
    count(create_job.id)::integer AS create_jobs,
    count(create_job.id) FILTER (
      WHERE create_job.status = 'failed'
    )::integer AS failed_create_jobs
  INTO inconsistent_booking
  FROM bookings booking
  LEFT JOIN jobs create_job
    ON create_job.organization_id = booking.organization_id
   AND create_job.type = 'calendar.event.create'
   AND create_job.payload->>'bookingId' = booking.id::text
  WHERE booking.status = 'failed'
    AND booking.router_session_id IS NULL
  GROUP BY booking.id, booking.external_id
  HAVING count(create_job.id) <> 1
     OR count(create_job.id) FILTER (
          WHERE create_job.status = 'failed'
        ) <> 1
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Cannot queue provider reconciliation for failed booking %s (%s): found %s linked calendar create jobs, %s terminal failed.',
        inconsistent_booking.id,
        inconsistent_booking.external_id,
        inconsistent_booking.create_jobs,
        inconsistent_booking.failed_create_jobs
      ),
      HINT = 'Repair the bookingId link and terminal status of the one calendar.event.create job for this booking, then rerun the migration.';
  END IF;
END
$migration$;

WITH reconciliation_candidates AS MATERIALIZED (
  SELECT
    booking.id AS booking_id,
    booking.organization_id,
    create_job.payload || jsonb_build_object(
      'bookingId', booking.id::text,
      'externalId', booking.external_id,
      'organizationSlug', organization.slug,
      'repId', booking.rep_id::text,
      'provider', booking.calendar_provider,
      'startsAt', booking.starts_at,
      'endsAt', booking.ends_at,
      'reminderMinutes', meeting_type.reminder_minutes,
      'reconciliationForJobId', create_job.id,
      'reconciliationIntent', 'resolve'
    ) AS payload
  FROM bookings booking
  JOIN organizations organization
    ON organization.id = booking.organization_id
  JOIN meeting_types meeting_type
    ON meeting_type.id = booking.meeting_type_id
  JOIN jobs create_job
    ON create_job.organization_id = booking.organization_id
   AND create_job.type = 'calendar.event.create'
   AND create_job.payload->>'bookingId' = booking.id::text
   AND create_job.status = 'failed'
  WHERE booking.status = 'failed'
    AND booking.router_session_id IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM jobs reconciliation_job
      WHERE reconciliation_job.organization_id = booking.organization_id
        AND reconciliation_job.type = 'calendar.event.create.reconcile'
        AND reconciliation_job.payload->>'bookingId' = booking.id::text
    )
), queued AS (
  INSERT INTO jobs (organization_id, type, payload, run_at)
  SELECT
    candidate.organization_id,
    'calendar.event.create.reconcile',
    candidate.payload,
    now() + interval '5 seconds'
  FROM reconciliation_candidates candidate
  RETURNING (payload->>'bookingId')::uuid AS booking_id
)
UPDATE bookings booking
SET status = 'pending', last_error = null, updated_at = now()
FROM queued
WHERE booking.id = queued.booking_id
  AND booking.status = 'failed'
  AND booking.router_session_id IS NULL;

COMMENT ON COLUMN bookings.status IS
  'Booking lifecycle. Failed calendar creates remain range-reserving until provider reconciliation confirms or safely closes them.';
