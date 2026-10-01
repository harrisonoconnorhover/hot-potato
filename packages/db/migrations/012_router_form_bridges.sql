CREATE UNIQUE INDEX IF NOT EXISTS router_links_id_organization_idx
  ON router_links (id, organization_id);

CREATE TABLE IF NOT EXISTS router_form_bridges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  router_link_id uuid NOT NULL,
  name text NOT NULL,
  provider text NOT NULL,
  form_id text,
  allowed_origins jsonb NOT NULL,
  attendee_name_fields jsonb NOT NULL,
  attendee_email_field text NOT NULL,
  answer_mappings jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  link_config_version integer NOT NULL CHECK (link_config_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT router_form_bridges_link_organization_fk
    FOREIGN KEY (router_link_id, organization_id)
    REFERENCES router_links(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT router_form_bridges_name_check
    CHECK (char_length(name) BETWEEN 2 AND 120),
  CONSTRAINT router_form_bridges_provider_check
    CHECK (provider IN ('hubspot', 'manual')),
  CONSTRAINT router_form_bridges_form_shape_check CHECK (
    (provider = 'hubspot' AND form_id IS NOT NULL AND char_length(form_id) BETWEEN 1 AND 160)
    OR (provider = 'manual' AND form_id IS NULL)
  ),
  CONSTRAINT router_form_bridges_allowed_origins_check CHECK (
    jsonb_typeof(allowed_origins) = 'array'
    AND jsonb_array_length(allowed_origins) BETWEEN 1 AND 10
    AND NOT jsonb_path_exists(
      allowed_origins,
      '$[*] ? (@.type() != "string")'
    )
  ),
  CONSTRAINT router_form_bridges_attendee_name_fields_check CHECK (
    jsonb_typeof(attendee_name_fields) = 'array'
    AND jsonb_array_length(attendee_name_fields) BETWEEN 1 AND 4
    AND NOT jsonb_path_exists(
      attendee_name_fields,
      '$[*] ? (@.type() != "string")'
    )
  ),
  CONSTRAINT router_form_bridges_attendee_email_field_check
    CHECK (char_length(attendee_email_field) BETWEEN 1 AND 160),
  CONSTRAINT router_form_bridges_answer_mappings_check CHECK (
    jsonb_typeof(answer_mappings) = 'object'
    AND NOT jsonb_path_exists(
      answer_mappings,
      '$.* ? (@.type() != "string")'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS router_form_bridges_org_name_idx
  ON router_form_bridges (organization_id, lower(name));

CREATE INDEX IF NOT EXISTS router_form_bridges_org_link_idx
  ON router_form_bridges (organization_id, router_link_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS router_form_bridges_public_idx
  ON router_form_bridges (id, link_config_version)
  WHERE active = true;
