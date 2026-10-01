CREATE TABLE IF NOT EXISTS meeting_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rep_id uuid REFERENCES reps(id) ON DELETE CASCADE,
  pool_id uuid REFERENCES routing_pools(id) ON DELETE CASCADE,
  slug text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  duration_minutes integer NOT NULL DEFAULT 30,
  minimum_notice_minutes integer NOT NULL DEFAULT 60,
  booking_window_days integer NOT NULL DEFAULT 14,
  conference_provider text NOT NULL DEFAULT 'none',
  zoom_join_url text,
  reminder_minutes integer NOT NULL DEFAULT 1440,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meeting_types_one_target_check CHECK (
    (rep_id IS NOT NULL AND pool_id IS NULL)
    OR (rep_id IS NULL AND pool_id IS NOT NULL)
  ),
  CONSTRAINT meeting_types_slug_format_check CHECK (
    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  CONSTRAINT meeting_types_duration_check CHECK (
    duration_minutes BETWEEN 15 AND 480
  ),
  CONSTRAINT meeting_types_notice_check CHECK (
    minimum_notice_minutes BETWEEN 0 AND 43200
  ),
  CONSTRAINT meeting_types_window_check CHECK (
    booking_window_days BETWEEN 1 AND 365
  ),
  CONSTRAINT meeting_types_conference_check CHECK (
    conference_provider IN ('none', 'google_meet', 'microsoft_teams', 'zoom')
  ),
  CONSTRAINT meeting_types_reminder_check CHECK (
    reminder_minutes BETWEEN 0 AND 43200
  ),
  UNIQUE (organization_id, slug)
);

INSERT INTO meeting_types (
  organization_id, rep_id, slug, title, description, duration_minutes,
  minimum_notice_minutes, booking_window_days
)
SELECT
  organization_id, id, scheduling_slug, meeting_title, meeting_description,
  meeting_duration_minutes, minimum_notice_minutes, booking_window_days
FROM reps
ON CONFLICT (organization_id, slug) DO NOTHING;

CREATE TABLE IF NOT EXISTS bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_type_id uuid NOT NULL REFERENCES meeting_types(id) ON DELETE RESTRICT,
  rep_id uuid NOT NULL REFERENCES reps(id) ON DELETE RESTRICT,
  external_id text NOT NULL,
  manage_token_hash char(64) NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  attendee_name text NOT NULL,
  attendee_email text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  calendar_provider text NOT NULL,
  conference_provider text NOT NULL DEFAULT 'none',
  conference_url text,
  external_event_id text,
  external_event_web_link text,
  last_error text,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookings_status_check CHECK (
    status IN (
      'pending', 'confirmed', 'reschedule_pending', 'cancel_pending',
      'cancelled', 'failed'
    )
  ),
  CONSTRAINT bookings_calendar_provider_check CHECK (
    calendar_provider IN ('google', 'microsoft')
  ),
  CONSTRAINT bookings_conference_provider_check CHECK (
    conference_provider IN ('none', 'google_meet', 'microsoft_teams', 'zoom')
  ),
  CONSTRAINT bookings_time_check CHECK (ends_at > starts_at),
  UNIQUE (organization_id, external_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS bookings_rep_active_slot_idx
  ON bookings (rep_id, starts_at)
  WHERE status IN (
    'pending', 'confirmed', 'reschedule_pending', 'cancel_pending'
  );

CREATE INDEX IF NOT EXISTS bookings_org_created_idx
  ON bookings (organization_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_booking_reminder_active_idx
  ON jobs ((payload->>'bookingId'))
  WHERE type = 'email.booking.reminder'
    AND status IN ('pending', 'processing');
