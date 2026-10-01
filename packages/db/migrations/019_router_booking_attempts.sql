ALTER TABLE router_qualification_sessions
  ADD COLUMN IF NOT EXISTS booking_attempt_token_hash char(64),
  ADD COLUMN IF NOT EXISTS booking_attempt_starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS booking_attempt_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS booking_attempt_started_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'router_sessions_booking_attempt_shape_check'
      AND conrelid = 'router_qualification_sessions'::regclass
  ) THEN
    ALTER TABLE router_qualification_sessions
      ADD CONSTRAINT router_sessions_booking_attempt_shape_check CHECK (
        (
          booking_attempt_token_hash IS NULL
          AND booking_attempt_starts_at IS NULL
          AND booking_attempt_ends_at IS NULL
          AND booking_attempt_started_at IS NULL
        )
        OR (
          booking_attempt_token_hash IS NOT NULL
          AND booking_attempt_starts_at IS NOT NULL
          AND booking_attempt_ends_at IS NOT NULL
          AND booking_attempt_started_at IS NOT NULL
          AND booking_attempt_ends_at > booking_attempt_starts_at
        )
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS router_sessions_booking_attempt_idx
  ON router_qualification_sessions (booking_attempt_started_at)
  WHERE booking_attempt_started_at IS NOT NULL AND booked_at IS NULL;
