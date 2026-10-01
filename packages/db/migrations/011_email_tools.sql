CREATE UNIQUE INDEX IF NOT EXISTS reps_id_organization_idx
  ON reps (id, organization_id);

CREATE TABLE IF NOT EXISTS email_tool_access_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rep_id uuid NOT NULL,
  client_type text NOT NULL,
  label text NOT NULL,
  token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT email_tool_access_keys_rep_organization_fk
    FOREIGN KEY (rep_id, organization_id)
    REFERENCES reps(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT email_tool_access_keys_client_type_check
    CHECK (client_type IN ('gmail', 'outlook')),
  CONSTRAINT email_tool_access_keys_label_check
    CHECK (char_length(label) BETWEEN 1 AND 120),
  CONSTRAINT email_tool_access_keys_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_tool_access_keys_last_used_check
    CHECK (last_used_at IS NULL OR last_used_at >= created_at),
  CONSTRAINT email_tool_access_keys_revoked_check
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX IF NOT EXISTS email_tool_access_keys_rep_created_idx
  ON email_tool_access_keys (organization_id, rep_id, created_at DESC);
