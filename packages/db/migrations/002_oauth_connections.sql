CREATE TABLE IF NOT EXISTS oauth_connections (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('hubspot', 'google')),
  encrypted_access_token text NOT NULL,
  encrypted_refresh_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  external_account_id text,
  external_account_name text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, provider)
);

ALTER TABLE routing_decisions
  ADD COLUMN IF NOT EXISTS availability_source text NOT NULL DEFAULT 'weekly_schedule';

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS result jsonb;
