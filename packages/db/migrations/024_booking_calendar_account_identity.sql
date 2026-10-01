ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS calendar_external_account_id text,
  ADD COLUMN IF NOT EXISTS source_external_id text;

ALTER TABLE bookings
  ALTER COLUMN manage_token_hash DROP NOT NULL;

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_source_external_id_check;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_source_external_id_check CHECK (
    source_external_id IS NULL
    OR (
      length(source_external_id) BETWEEN 1 AND 200
      AND source_external_id !~ '[[:cntrl:]]'
    )
  );

-- Routed non-Router bookings historically used external_id for both caller
-- idempotency and management. Preserve that caller identity separately, but
-- never infer a bearer credential from an arbitrary legacy value.
LOCK TABLE jobs IN SHARE ROW EXCLUSIVE MODE;

UPDATE bookings
SET source_external_id = external_id,
    manage_token_hash = CASE
      WHEN external_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND manage_token_hash = encode(digest(external_id, 'sha256'), 'hex')
      THEN manage_token_hash
      ELSE NULL
    END
WHERE routing_decision_id IS NOT NULL
  AND router_session_id IS NULL
  AND source_external_id IS NULL;

UPDATE bookings
SET manage_token_hash = NULL
WHERE routing_decision_id IS NOT NULL
  AND router_session_id IS NULL
  AND external_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

DO $migration$
DECLARE
  in_flight_email record;
BEGIN
  SELECT message.id, b.id AS booking_id
  INTO in_flight_email
  FROM jobs message
  JOIN bookings b ON b.id::text = message.payload->>'bookingId'
  WHERE message.type IN (
      'email.booking.confirmation', 'email.booking.rescheduled',
      'email.booking.cancelled', 'email.booking.reminder'
    )
    AND message.status = 'processing'
    AND b.manage_token_hash IS NULL
    AND nullif(message.payload->>'managePath', '') IS NOT NULL
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Cannot revoke unsafe booking management link: email job %s for booking %s is already processing.',
        in_flight_email.id,
        in_flight_email.booking_id
      ),
      HINT = 'Stop the worker, verify whether the email was sent, reset or complete the job deliberately, then rerun migration 024.';
  END IF;
END
$migration$;

UPDATE jobs message
SET payload = message.payload - 'managePath'
FROM bookings b
WHERE b.id::text = message.payload->>'bookingId'
  AND message.type IN (
    'email.booking.confirmation', 'email.booking.rescheduled',
    'email.booking.cancelled', 'email.booking.reminder'
  )
  AND message.status = 'pending'
  AND b.manage_token_hash IS NULL
  AND message.payload ? 'managePath';

CREATE UNIQUE INDEX IF NOT EXISTS bookings_org_source_external_uidx
  ON bookings (organization_id, source_external_id)
  WHERE source_external_id IS NOT NULL;

COMMENT ON COLUMN bookings.source_external_id IS
  'Caller-supplied idempotency key for routed API bookings; never a management credential or provider transaction ID.';

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_calendar_external_account_id_check;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_calendar_external_account_id_check CHECK (
    calendar_external_account_id IS NULL
    OR (
      length(calendar_external_account_id) BETWEEN 1 AND 1024
      AND calendar_external_account_id !~ '[[:cntrl:]]'
    )
  );

COMMENT ON COLUMN bookings.calendar_external_account_id IS
  'Exact provider account that owns this booking lifecycle. NULL means legacy identity is unproven and provider mutation must fail closed.';

-- No pre-024 availability check attested the provider-account identity. A
-- create that provably never started can be withdrawn safely, but must not be
-- rebound to whichever account happens to be connected during this upgrade.
LOCK TABLE rep_calendar_connections IN SHARE MODE;

DO $migration$
DECLARE
  duplicate_connection record;
BEGIN
  SELECT provider, external_account_id, count(*)::integer AS connections
  INTO duplicate_connection
  FROM rep_calendar_connections
  WHERE external_account_id IS NOT NULL
  GROUP BY provider, external_account_id
  HAVING count(*) > 1
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Cannot enforce calendar account ownership: %s account %s is connected to %s representatives.',
        duplicate_connection.provider,
        duplicate_connection.external_account_id,
        duplicate_connection.connections
      ),
      HINT = 'Disconnect the duplicate representative calendar rows after verifying which representative owns the provider account, then rerun migration 024.';
  END IF;
END
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS
  rep_calendar_connections_provider_external_account_uidx
  ON rep_calendar_connections (provider, external_account_id)
  WHERE external_account_id IS NOT NULL;

CREATE TEMP TABLE migration_024_safe_create_withdrawals
ON COMMIT DROP AS
SELECT b.id AS booking_id, j.id AS job_id
FROM bookings b
JOIN jobs j
  ON j.organization_id = b.organization_id
 AND j.type = 'calendar.event.create'
 AND j.payload->>'bookingId' = b.id::text
WHERE b.calendar_external_account_id IS NULL
  AND b.status = 'pending'
  AND j.status = 'pending'
  AND j.attempts = 0
  AND j.locked_at IS NULL
  AND j.claim_token IS NULL
  AND j.completed_at IS NULL
  AND j.result IS NULL
  AND j.last_error IS NULL
  AND j.payload->>'externalId' = b.external_id
  AND j.payload->>'repId' = b.rep_id::text
  AND j.payload->>'provider' = b.calendar_provider
  AND NOT EXISTS (
    SELECT 1
    FROM jobs other
    WHERE other.organization_id = b.organization_id
      AND other.type = 'calendar.event.create'
      AND other.payload->>'bookingId' = b.id::text
      AND other.id <> j.id
  );

CREATE TEMP TABLE migration_024_safe_lifecycle_rollbacks
ON COMMIT DROP AS
SELECT b.id AS booking_id, j.id AS job_id, j.type
FROM bookings b
JOIN jobs j
  ON j.organization_id = b.organization_id
 AND j.type = 'calendar.event.update'
 AND j.payload->>'bookingId' = b.id::text
WHERE b.calendar_external_account_id IS NULL
  AND b.status = 'reschedule_pending'
  AND b.external_event_id IS NOT NULL
  AND b.previous_starts_at IS NOT NULL
  AND b.previous_ends_at IS NOT NULL
  AND j.status = 'pending'
  AND j.attempts = 0
  AND j.locked_at IS NULL
  AND j.claim_token IS NULL
  AND j.completed_at IS NULL
  AND j.result IS NULL
  AND j.last_error IS NULL
  AND j.payload->>'externalId' = b.external_id
  AND j.payload->>'externalEventId' = b.external_event_id
  AND j.payload->>'repId' = b.rep_id::text
  AND j.payload->>'provider' = b.calendar_provider
  AND NOT EXISTS (
    SELECT 1
    FROM jobs other
    WHERE other.organization_id = b.organization_id
      AND other.type = 'calendar.event.update'
      AND other.payload->>'bookingId' = b.id::text
      AND other.id <> j.id
      AND other.status IN ('pending', 'processing', 'failed')
  )
UNION ALL
SELECT b.id AS booking_id, j.id AS job_id, j.type
FROM bookings b
JOIN jobs j
  ON j.organization_id = b.organization_id
 AND j.type = 'calendar.event.cancel'
 AND j.payload->>'bookingId' = b.id::text
WHERE b.calendar_external_account_id IS NULL
  AND b.status = 'cancel_pending'
  AND b.external_event_id IS NOT NULL
  AND b.previous_starts_at IS NULL
  AND b.previous_ends_at IS NULL
  AND j.status = 'pending'
  AND j.attempts = 0
  AND j.locked_at IS NULL
  AND j.claim_token IS NULL
  AND j.completed_at IS NULL
  AND j.result IS NULL
  AND j.last_error IS NULL
  AND j.payload->>'externalId' = b.external_id
  AND j.payload->>'externalEventId' = b.external_event_id
  AND j.payload->>'repId' = b.rep_id::text
  AND j.payload->>'provider' = b.calendar_provider
  AND NOT EXISTS (
    SELECT 1
    FROM jobs other
    WHERE other.organization_id = b.organization_id
      AND other.type = 'calendar.event.cancel'
      AND other.payload->>'bookingId' = b.id::text
      AND other.id <> j.id
      AND other.status IN ('pending', 'processing', 'failed')
  );

DO $migration$
DECLARE
  uncertain_create record;
BEGIN
  SELECT b.id AS booking_id, j.id AS job_id, j.status, j.attempts
  INTO uncertain_create
  FROM bookings b
  JOIN jobs j
    ON j.organization_id = b.organization_id
   AND j.type = 'calendar.event.create'
   AND j.payload->>'bookingId' = b.id::text
  WHERE b.calendar_external_account_id IS NULL
    AND j.status IN ('pending', 'processing')
    AND NOT EXISTS (
      SELECT 1
      FROM migration_024_safe_create_withdrawals safe
      WHERE safe.booking_id = b.id AND safe.job_id = j.id
    )
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Cannot bind calendar account for booking %s: calendar create job %s is %s after %s attempt(s).',
        uncertain_create.booking_id,
        uncertain_create.job_id,
        uncertain_create.status,
        uncertain_create.attempts
      ),
      HINT = 'Reconcile the exact provider account and possible event first. Only a provably unstarted pending create can be withdrawn automatically.';
  END IF;
END
$migration$;

DO $migration$
DECLARE
  stranded record;
BEGIN
  SELECT b.id, b.status, j.id AS job_id,
         coalesce(j.type,
           CASE WHEN b.status = 'reschedule_pending'
             THEN 'calendar.event.update'
             ELSE 'calendar.event.cancel'
           END
         ) AS type,
         j.status AS job_status, j.attempts
  INTO stranded
  FROM bookings b
  LEFT JOIN LATERAL (
    SELECT candidate.id, candidate.type, candidate.status, candidate.attempts
    FROM jobs candidate
    WHERE candidate.organization_id = b.organization_id
      AND candidate.payload->>'bookingId' = b.id::text
      AND candidate.type = CASE WHEN b.status = 'reschedule_pending'
        THEN 'calendar.event.update'
        ELSE 'calendar.event.cancel'
      END
      AND candidate.status IN ('pending', 'processing', 'failed')
    ORDER BY candidate.id DESC
    LIMIT 1
  ) j ON true
  WHERE b.calendar_external_account_id IS NULL
    AND b.status IN ('reschedule_pending', 'cancel_pending')
    AND NOT EXISTS (
      SELECT 1
      FROM migration_024_safe_lifecycle_rollbacks safe
      WHERE safe.booking_id = b.id
        AND (j.id IS NULL OR safe.job_id = j.id)
    )
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Cannot bind calendar account for booking %s: %s job %s is %s after %s attempt(s).',
        stranded.id,
        stranded.type,
        coalesce(stranded.job_id::text, 'missing'),
        coalesce(stranded.job_status, 'missing'),
        coalesce(stranded.attempts, 0)
      ),
      HINT = 'Reconcile the exact provider account and event first, then bind the booking with positive provider evidence before rerunning migration 024.';
  END IF;
END
$migration$;

UPDATE jobs j
SET status = 'cancelled', completed_at = now(), locked_at = NULL,
    claim_token = NULL,
    last_error = 'The unstarted legacy calendar create was withdrawn because its provider-account identity was never attested.'
FROM migration_024_safe_create_withdrawals withdrawal
WHERE j.id = withdrawal.job_id
  AND j.status = 'pending';

UPDATE bookings b
SET status = 'cancelled', cancelled_at = coalesce(cancelled_at, now()),
    last_error = 'The unstarted legacy booking was safely withdrawn. Choose a new time using the current verified calendar connection.',
    updated_at = now()
FROM migration_024_safe_create_withdrawals withdrawal
WHERE b.id = withdrawal.booking_id
  AND b.status = 'pending'
  AND b.calendar_external_account_id IS NULL;

UPDATE jobs j
SET status = 'cancelled', completed_at = now(), locked_at = NULL,
    claim_token = NULL,
    last_error = 'Calendar account identity is unproven. The queued provider change was withdrawn without contacting the provider.'
FROM migration_024_safe_lifecycle_rollbacks rollback
WHERE j.id = rollback.job_id
  AND j.status = 'pending';

UPDATE bookings b
SET status = 'confirmed', starts_at = b.previous_starts_at,
    ends_at = b.previous_ends_at,
    previous_starts_at = NULL, previous_ends_at = NULL,
    last_error = 'Calendar account identity is unproven. The unstarted reschedule was withdrawn; verify the original provider event before another change.',
    updated_at = now()
FROM migration_024_safe_lifecycle_rollbacks rollback
WHERE b.id = rollback.booking_id
  AND rollback.type = 'calendar.event.update'
  AND b.status = 'reschedule_pending';

UPDATE bookings b
SET status = 'confirmed',
    last_error = 'Calendar account identity is unproven. The unstarted cancellation was withdrawn; verify the original provider event before another change.',
    updated_at = now()
FROM migration_024_safe_lifecycle_rollbacks rollback
WHERE b.id = rollback.booking_id
  AND rollback.type = 'calendar.event.cancel'
  AND b.status = 'cancel_pending';

-- Restore only the exact still-actionable reminder cancelled by the same
-- lifecycle transaction. PostgreSQL now() is transaction-stable, so its
-- completed_at exactly matches that update/cancel job's created_at. Never
-- synthesize a reminder from mutable meeting-type settings.
UPDATE jobs reminder
SET status = 'pending', completed_at = NULL, locked_at = NULL,
    claim_token = NULL, last_error = NULL,
    payload = jsonb_set(
      reminder.payload,
      '{managePath}',
      CASE
        WHEN b.manage_token_hash IS NOT NULL
          AND b.external_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND b.manage_token_hash = encode(digest(b.external_id, 'sha256'), 'hex')
        THEN to_jsonb('/schedule/manage/' || b.external_id)
        ELSE 'null'::jsonb
      END,
      true
    )
FROM migration_024_safe_lifecycle_rollbacks rollback
JOIN jobs lifecycle ON lifecycle.id = rollback.job_id
JOIN bookings b ON b.id = rollback.booking_id
WHERE reminder.organization_id = b.organization_id
  AND reminder.type = 'email.booking.reminder'
  AND reminder.payload->>'bookingId' = b.id::text
  AND reminder.status = 'cancelled'
  AND reminder.completed_at = lifecycle.created_at
  AND reminder.run_at > now() + interval '1 minute'
  AND b.status = 'confirmed'
  AND b.attendee_notifications_enabled
  AND NOT EXISTS (
    SELECT 1 FROM jobs active_reminder
    WHERE active_reminder.type = 'email.booking.reminder'
      AND active_reminder.payload->>'bookingId' = b.id::text
      AND active_reminder.status IN ('pending', 'processing')
      AND active_reminder.id <> reminder.id
  );

-- A pre-024 reconciliation has no trustworthy account from which to perform a
-- negative lookup. Stop it instead of hot-looping, and keep the booking/range
-- reserved until explicit provider proof repairs the binding.
DO $migration$
DECLARE
  in_flight_reconciliation record;
BEGIN
  SELECT reconciliation.id, b.id AS booking_id
  INTO in_flight_reconciliation
  FROM jobs reconciliation
  JOIN bookings b ON b.id::text = reconciliation.payload->>'bookingId'
  WHERE reconciliation.type = 'calendar.event.create.reconcile'
    AND reconciliation.status = 'processing'
    AND b.calendar_external_account_id IS NULL
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Cannot stop provider reconciliation job %s for booking %s while it is processing.',
        in_flight_reconciliation.id,
        in_flight_reconciliation.booking_id
      ),
      HINT = 'Stop and drain the worker, reconcile its provider result, then rerun migration 024. A live provider lookup must not lose its completion claim.';
  END IF;
END
$migration$;

WITH stopped_reconciliation AS (
  UPDATE jobs reconciliation
  SET status = 'failed', completed_at = now(), locked_at = NULL,
      claim_token = NULL,
      last_error = 'Calendar account identity is unproven. Reconcile and bind the exact provider account before retrying.'
  FROM bookings b
  WHERE reconciliation.type = 'calendar.event.create.reconcile'
    AND reconciliation.payload->>'bookingId' = b.id::text
    AND reconciliation.status = 'pending'
    AND b.calendar_external_account_id IS NULL
  RETURNING b.id AS booking_id
)
UPDATE bookings b
SET status = 'failed',
    last_error = 'Calendar account identity is unproven. The possible provider event remains reserved until positive provider proof is supplied.',
    updated_at = now()
FROM stopped_reconciliation stopped
WHERE b.id = stopped.booking_id
  AND b.calendar_external_account_id IS NULL
  AND b.status IN ('pending', 'cancel_pending', 'failed');

-- Cancelling an uncertain reschedule must reserve both the original and
-- requested ranges until provider deletion is confirmed.
ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_rep_active_time_excl,
  DROP CONSTRAINT IF EXISTS bookings_reschedule_previous_time_check;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_reschedule_previous_time_check CHECK (
    (
      status = 'reschedule_pending'
      AND previous_starts_at IS NOT NULL
      AND previous_ends_at IS NOT NULL
    )
    OR (
      status = 'cancel_pending'
      AND (
        (previous_starts_at IS NULL AND previous_ends_at IS NULL)
        OR (previous_starts_at IS NOT NULL AND previous_ends_at IS NOT NULL)
      )
    )
    OR (
      status NOT IN ('reschedule_pending', 'cancel_pending')
      AND previous_starts_at IS NULL
      AND previous_ends_at IS NULL
    )
  );

ALTER TABLE bookings
  ADD CONSTRAINT bookings_rep_active_time_excl
  EXCLUDE USING gist (
    rep_id WITH =,
    (
      CASE
        WHEN status IN ('reschedule_pending', 'cancel_pending')
          AND previous_starts_at IS NOT NULL
          AND previous_ends_at IS NOT NULL
        THEN tstzmultirange(
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

DO $migration$
DECLARE
  conflicting_booking record;
BEGIN
  WITH active_booking AS (
    SELECT id, calendar_provider, calendar_external_account_id,
      CASE
        WHEN status IN ('reschedule_pending', 'cancel_pending')
          AND previous_starts_at IS NOT NULL
          AND previous_ends_at IS NOT NULL
        THEN tstzmultirange(
          tstzrange(starts_at, ends_at, '[)'),
          tstzrange(previous_starts_at, previous_ends_at, '[)')
        )
        ELSE tstzmultirange(tstzrange(starts_at, ends_at, '[)'))
      END AS reserved_ranges
    FROM bookings
    WHERE calendar_external_account_id IS NOT NULL
      AND status IN (
        'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
      )
  )
  SELECT earlier.calendar_provider, earlier.calendar_external_account_id,
         earlier.id AS earlier_booking_id, later.id AS later_booking_id
  INTO conflicting_booking
  FROM active_booking earlier
  JOIN active_booking later
    ON later.id > earlier.id
   AND later.calendar_provider = earlier.calendar_provider
   AND later.calendar_external_account_id =
       earlier.calendar_external_account_id
   AND later.reserved_ranges && earlier.reserved_ranges
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Cannot enforce provider-account booking ranges: %s account %s has overlapping bookings %s and %s.',
        conflicting_booking.calendar_provider,
        conflicting_booking.calendar_external_account_id,
        conflicting_booking.earlier_booking_id,
        conflicting_booking.later_booking_id
      ),
      HINT = 'Reconcile or cancel one overlapping booking, or correct its proven provider-account identity, then rerun migration 024.';
  END IF;
END
$migration$;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_provider_account_active_time_excl
  EXCLUDE USING gist (
    calendar_provider WITH =,
    calendar_external_account_id WITH =,
    (
      CASE
        WHEN status IN ('reschedule_pending', 'cancel_pending')
          AND previous_starts_at IS NOT NULL
          AND previous_ends_at IS NOT NULL
        THEN tstzmultirange(
          tstzrange(starts_at, ends_at, '[)'),
          tstzrange(previous_starts_at, previous_ends_at, '[)')
        )
        ELSE tstzmultirange(tstzrange(starts_at, ends_at, '[)'))
      END
    ) WITH &&
  )
  WHERE (
    calendar_external_account_id IS NOT NULL
    AND status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
    )
  );
