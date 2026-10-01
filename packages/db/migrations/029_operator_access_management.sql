ALTER TABLE organization_memberships
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

ALTER TABLE operator_sessions
  ADD COLUMN IF NOT EXISTS user_agent text;

CREATE TABLE IF NOT EXISTS operator_access_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('invite', 'password_reset')),
  operator_id uuid REFERENCES operator_accounts(id) ON DELETE CASCADE,
  invite_login text,
  invite_login_normalized text
    GENERATED ALWAYS AS (lower(btrim(invite_login))) STORED,
  invite_display_name text,
  invite_role text CHECK (invite_role IN ('owner', 'admin', 'operator')),
  token_hash char(64) NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES operator_accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT operator_access_links_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT operator_access_links_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT operator_access_links_payload_check CHECK (
    (
      purpose = 'invite'
      AND operator_id IS NULL
      AND invite_login IS NOT NULL
      AND length(btrim(invite_login)) BETWEEN 3 AND 254
      AND invite_display_name IS NOT NULL
      AND length(btrim(invite_display_name)) BETWEEN 1 AND 120
      AND invite_role IS NOT NULL
    )
    OR
    (
      purpose = 'password_reset'
      AND operator_id IS NOT NULL
      AND invite_login IS NULL
      AND invite_display_name IS NULL
      AND invite_role IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS operator_access_links_pending_invite_idx
  ON operator_access_links (organization_id, invite_login_normalized)
  WHERE purpose = 'invite' AND used_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS operator_access_links_pending_reset_idx
  ON operator_access_links (organization_id, operator_id)
  WHERE purpose = 'password_reset' AND used_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS operator_access_links_expiry_idx
  ON operator_access_links (expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;
