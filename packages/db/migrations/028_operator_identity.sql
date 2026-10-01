CREATE TABLE IF NOT EXISTS operator_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login text NOT NULL,
  login_normalized text GENERATED ALWAYS AS (lower(btrim(login))) STORED,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operator_accounts_login_length_check
    CHECK (length(btrim(login)) BETWEEN 3 AND 254),
  CONSTRAINT operator_accounts_display_name_check
    CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  CONSTRAINT operator_accounts_password_hash_check
    CHECK (length(password_hash) BETWEEN 80 AND 512),
  UNIQUE (login_normalized)
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL REFERENCES operator_accounts(id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, operator_id),
  CONSTRAINT organization_memberships_role_check
    CHECK (role IN ('owner', 'admin', 'operator'))
);

CREATE TABLE IF NOT EXISTS operator_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (organization_id, operator_id)
    REFERENCES organization_memberships (organization_id, operator_id)
    ON DELETE CASCADE,
  CONSTRAINT operator_sessions_expiry_check CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS operator_sessions_active_expiry_idx
  ON operator_sessions (expires_at)
  WHERE revoked_at IS NULL;
