CREATE TABLE IF NOT EXISTS rep_calendar_connections (
  rep_id uuid NOT NULL REFERENCES reps(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  encrypted_access_token text NOT NULL,
  encrypted_refresh_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  external_account_id text,
  external_account_name text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rep_id, provider)
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_calendar_booking_external_idx
  ON jobs (organization_id, (payload->>'externalId'))
  WHERE type = 'calendar.event.create';
