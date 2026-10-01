CREATE UNIQUE INDEX IF NOT EXISTS email_tool_access_keys_identity_scope_idx
  ON email_tool_access_keys (id, organization_id, rep_id);

CREATE TABLE IF NOT EXISTS outlook_email_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rep_id uuid NOT NULL,
  bootstrap_key_id uuid NOT NULL UNIQUE,
  tenant_id uuid NOT NULL,
  subject text NOT NULL,
  asserted_email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outlook_email_identities_rep_organization_fk
    FOREIGN KEY (rep_id, organization_id)
    REFERENCES reps(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT outlook_email_identities_key_scope_fk
    FOREIGN KEY (bootstrap_key_id, organization_id, rep_id)
    REFERENCES email_tool_access_keys(id, organization_id, rep_id)
    ON DELETE CASCADE,
  CONSTRAINT outlook_email_identities_principal_unique
    UNIQUE (tenant_id, subject),
  CONSTRAINT outlook_email_identities_subject_check
    CHECK (char_length(subject) BETWEEN 1 AND 255),
  CONSTRAINT outlook_email_identities_email_check
    CHECK (char_length(asserted_email) BETWEEN 3 AND 320),
  CONSTRAINT outlook_email_identities_last_used_check
    CHECK (last_used_at >= created_at)
);

CREATE INDEX IF NOT EXISTS outlook_email_identities_rep_idx
  ON outlook_email_identities (organization_id, rep_id, created_at DESC);
