UPDATE bookings booking
SET status = 'pending', last_error = null, updated_at = now()
WHERE booking.status = 'failed'
  AND booking.router_session_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM jobs create_job
    WHERE create_job.organization_id = booking.organization_id
      AND create_job.type = 'calendar.event.create'
      AND create_job.payload->>'bookingId' = booking.id::text
      AND create_job.status = 'failed'
  )
  AND EXISTS (
    SELECT 1
    FROM jobs reconciliation_job
    WHERE reconciliation_job.organization_id = booking.organization_id
      AND reconciliation_job.type = 'calendar.event.create.reconcile'
      AND reconciliation_job.payload->>'bookingId' = booking.id::text
      AND reconciliation_job.payload->>'reconciliationIntent' = 'resolve'
      AND reconciliation_job.status IN ('pending', 'processing')
  );

COMMENT ON COLUMN bookings.status IS
  'Booking lifecycle. Uncertain calendar creates stay range-reserving while provider reconciliation is pending.';
