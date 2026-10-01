CREATE UNIQUE INDEX IF NOT EXISTS routing_rules_one_catch_all_idx
  ON routing_rules (organization_id)
  WHERE conditions = '{}'::jsonb;
