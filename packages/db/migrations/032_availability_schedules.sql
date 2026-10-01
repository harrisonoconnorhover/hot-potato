CREATE TABLE IF NOT EXISTS availability_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  availability jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_schedules_name_check
    CHECK (
      char_length(btrim(name)) BETWEEN 2 AND 80
      AND name !~ '[[:cntrl:]]'
    ),
  CONSTRAINT availability_schedules_availability_object_check
    CHECK (jsonb_typeof(availability) = 'object'),
  CONSTRAINT availability_schedules_id_org_unique
    UNIQUE (id, organization_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS availability_schedules_org_name_idx
  ON availability_schedules (organization_id, lower(btrim(name)));

ALTER TABLE reps
  ADD COLUMN IF NOT EXISTS availability_schedule_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reps_availability_schedule_org_fk'
  ) THEN
    ALTER TABLE reps
      ADD CONSTRAINT reps_availability_schedule_org_fk
      FOREIGN KEY (availability_schedule_id, organization_id)
      REFERENCES availability_schedules (id, organization_id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS reps_availability_schedule_idx
  ON reps (availability_schedule_id)
  WHERE availability_schedule_id IS NOT NULL;
