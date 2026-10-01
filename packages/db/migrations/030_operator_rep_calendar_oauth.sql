CREATE TABLE IF NOT EXISTS rep_calendar_oauth_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL,
  rep_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  state_hash char(64) NOT NULL UNIQUE,
  return_to text NOT NULL CHECK (return_to IN ('calendar-readiness', 'my-calendar')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CONSTRAINT rep_calendar_oauth_attempts_membership_fk
    FOREIGN KEY (organization_id, operator_id)
    REFERENCES organization_memberships (organization_id, operator_id)
    ON DELETE CASCADE,
  CONSTRAINT rep_calendar_oauth_attempts_rep_fk
    FOREIGN KEY (rep_id, organization_id)
    REFERENCES reps (id, organization_id)
    ON DELETE CASCADE,
  CONSTRAINT rep_calendar_oauth_attempts_state_hash_check
    CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rep_calendar_oauth_attempts_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT rep_calendar_oauth_attempts_used_check
    CHECK (used_at IS NULL OR used_at >= created_at)
);

CREATE INDEX IF NOT EXISTS rep_calendar_oauth_attempts_pending_idx
  ON rep_calendar_oauth_attempts (
    organization_id, operator_id, provider, expires_at
  )
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS rep_calendar_oauth_attempts_cleanup_idx
  ON rep_calendar_oauth_attempts (expires_at)
  WHERE used_at IS NULL;
