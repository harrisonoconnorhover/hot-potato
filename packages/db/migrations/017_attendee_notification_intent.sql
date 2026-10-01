ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS attendee_notifications_enabled boolean
    NOT NULL DEFAULT true;

DO $migration$
DECLARE
  invalid_job record;
BEGIN
  SELECT id, payload->>'attendeeNotificationsEnabled' AS value
  INTO invalid_job
  FROM jobs
  WHERE type = 'calendar.event.create'
    AND payload ? 'attendeeNotificationsEnabled'
    AND (
      payload->>'attendeeNotificationsEnabled' IS NULL
      OR payload->>'attendeeNotificationsEnabled' NOT IN ('true', 'false')
    )
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Cannot repair attendee notification intent: calendar job %s has invalid attendeeNotificationsEnabled value %s.',
        invalid_job.id,
        coalesce(invalid_job.value, 'null')
      ),
      HINT = 'Set attendeeNotificationsEnabled to true or false, then rerun the migration.';
  END IF;
END
$migration$;

UPDATE bookings booking
SET attendee_notifications_enabled =
      (create_job.payload->>'attendeeNotificationsEnabled')::boolean,
    updated_at = greatest(booking.updated_at, create_job.created_at)
FROM jobs create_job
WHERE create_job.organization_id = booking.organization_id
  AND create_job.type = 'calendar.event.create'
  AND create_job.payload->>'bookingId' = booking.id::text
  AND create_job.payload ? 'attendeeNotificationsEnabled';

UPDATE bookings booking
SET attendee_notifications_enabled = false,
    updated_at = greatest(booking.updated_at, create_job.created_at)
FROM jobs create_job
WHERE create_job.organization_id = booking.organization_id
  AND create_job.type = 'calendar.event.create'
  AND create_job.payload->>'bookingId' = booking.id::text
  AND NOT (create_job.payload ? 'attendeeNotificationsEnabled')
  AND booking.routing_decision_id IS NOT NULL
  AND booking.router_session_id IS NULL;

UPDATE jobs create_job
SET payload = create_job.payload || jsonb_build_object(
      'attendeeNotificationsEnabled',
      booking.attendee_notifications_enabled,
      'attendeeEmail', CASE
        WHEN booking.attendee_notifications_enabled THEN to_jsonb(coalesce(
          nullif(btrim(create_job.payload->>'attendeeEmail'), ''),
          booking.attendee_email
        ))
        ELSE 'null'::jsonb
      END
    )
FROM bookings booking
WHERE create_job.organization_id = booking.organization_id
  AND create_job.type = 'calendar.event.create'
  AND create_job.payload->>'bookingId' = booking.id::text;

UPDATE jobs notification_job
SET status = 'cancelled', completed_at = now(), locked_at = null
FROM bookings booking
WHERE booking.attendee_notifications_enabled = false
  AND notification_job.organization_id = booking.organization_id
  AND notification_job.type IN (
    'email.booking.confirmation',
    'email.booking.rescheduled',
    'email.booking.cancelled',
    'email.booking.reminder'
  )
  AND notification_job.payload->>'bookingId' = booking.id::text
  AND notification_job.status = 'pending';
