CREATE TABLE IF NOT EXISTS router_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  button_label text NOT NULL DEFAULT 'Find my time',
  no_match_message text NOT NULL DEFAULT 'Thanks — our team will follow up.',
  accent_color text NOT NULL DEFAULT '#f97316',
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  config_version integer NOT NULL DEFAULT 1 CHECK (config_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT router_links_slug_format_check CHECK (
    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  ),
  CONSTRAINT router_links_questions_array_check CHECK (
    jsonb_typeof(questions) = 'array'
  ),
  CONSTRAINT router_links_accent_color_check CHECK (
    accent_color ~ '^#[0-9A-Fa-f]{6}$'
  ),
  UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS router_link_destinations (
  router_link_id uuid NOT NULL REFERENCES router_links(id) ON DELETE CASCADE,
  pool_id uuid NOT NULL REFERENCES routing_pools(id) ON DELETE CASCADE,
  meeting_type_id uuid NOT NULL REFERENCES meeting_types(id) ON DELETE CASCADE,
  PRIMARY KEY (router_link_id, pool_id)
);

CREATE TABLE IF NOT EXISTS router_qualification_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  router_link_id uuid NOT NULL REFERENCES router_links(id) ON DELETE RESTRICT,
  token_hash char(64) NOT NULL,
  request_hash char(64) NOT NULL,
  attendee_name text NOT NULL,
  attendee_email text NOT NULL,
  lead jsonb NOT NULL,
  link_config_version integer NOT NULL CHECK (link_config_version > 0),
  outcome text NOT NULL,
  matched_rule_id uuid REFERENCES routing_rules(id) ON DELETE RESTRICT,
  pool_id uuid REFERENCES routing_pools(id) ON DELETE RESTRICT,
  meeting_type_id uuid REFERENCES meeting_types(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL,
  booked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT router_sessions_outcome_check CHECK (
    outcome IN ('matched', 'no_match')
  ),
  CONSTRAINT router_sessions_match_shape_check CHECK (
    (
      outcome = 'matched'
      AND matched_rule_id IS NOT NULL
      AND pool_id IS NOT NULL
      AND meeting_type_id IS NOT NULL
    )
    OR (
      outcome = 'no_match'
      AND matched_rule_id IS NULL
      AND pool_id IS NULL
      AND meeting_type_id IS NULL
    )
  ),
  UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS router_sessions_expiry_idx
  ON router_qualification_sessions (expires_at)
  WHERE booked_at IS NULL;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS router_session_id uuid
    REFERENCES router_qualification_sessions(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS routing_decision_id uuid
    REFERENCES routing_decisions(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS bookings_router_session_idx
  ON bookings (router_session_id)
  WHERE router_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bookings_routing_decision_idx
  ON bookings (routing_decision_id)
  WHERE routing_decision_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public_rate_limit_buckets (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  scope text NOT NULL,
  key_hash char(64) NOT NULL,
  window_started_at timestamptz NOT NULL,
  window_ends_at timestamptz NOT NULL,
  requests integer NOT NULL DEFAULT 1 CHECK (requests > 0),
  PRIMARY KEY (organization_id, scope, key_hash, window_started_at),
  CONSTRAINT public_rate_limit_window_check CHECK (
    window_ends_at > window_started_at
  )
);

CREATE INDEX IF NOT EXISTS public_rate_limit_expiry_idx
  ON public_rate_limit_buckets (window_ends_at);
