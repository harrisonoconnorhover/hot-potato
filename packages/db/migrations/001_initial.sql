CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  weight integer NOT NULL DEFAULT 1 CHECK (weight > 0),
  active boolean NOT NULL DEFAULT true,
  availability jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);

CREATE TABLE IF NOT EXISTS routing_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  strategy text NOT NULL DEFAULT 'weighted_round_robin',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);

CREATE TABLE IF NOT EXISTS routing_pool_members (
  pool_id uuid NOT NULL REFERENCES routing_pools(id) ON DELETE CASCADE,
  rep_id uuid NOT NULL REFERENCES reps(id) ON DELETE CASCADE,
  PRIMARY KEY (pool_id, rep_id)
);

CREATE TABLE IF NOT EXISTS routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  priority integer NOT NULL,
  conditions jsonb NOT NULL,
  pool_id uuid NOT NULL REFERENCES routing_pools(id) ON DELETE RESTRICT,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, priority)
);

CREATE TABLE IF NOT EXISTS assignment_state (
  pool_id uuid NOT NULL REFERENCES routing_pools(id) ON DELETE CASCADE,
  rep_id uuid NOT NULL REFERENCES reps(id) ON DELETE CASCADE,
  assignments integer NOT NULL DEFAULT 0,
  last_assigned_at timestamptz,
  PRIMARY KEY (pool_id, rep_id)
);

CREATE TABLE IF NOT EXISTS routing_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  external_id text,
  lead_email text NOT NULL,
  lead jsonb NOT NULL,
  rule_id uuid NOT NULL REFERENCES routing_rules(id) ON DELETE RESTRICT,
  pool_id uuid NOT NULL REFERENCES routing_pools(id) ON DELETE RESTRICT,
  rep_id uuid NOT NULL REFERENCES reps(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, external_id)
);

CREATE INDEX IF NOT EXISTS routing_decisions_org_created_idx
  ON routing_decisions (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
  id bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  run_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs (status, run_at, id);
