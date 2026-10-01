ALTER TABLE reps
  ADD COLUMN IF NOT EXISTS availability_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reps_availability_overrides_object_check'
  ) THEN
    ALTER TABLE reps
      ADD CONSTRAINT reps_availability_overrides_object_check
      CHECK (jsonb_typeof(availability_overrides) = 'object');
  END IF;
END $$;
