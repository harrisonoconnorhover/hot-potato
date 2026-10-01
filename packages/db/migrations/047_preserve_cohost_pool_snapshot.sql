ALTER TABLE booking_cohosts
  DROP CONSTRAINT booking_cohosts_source_pool_pair_check,
  ADD CONSTRAINT booking_cohosts_source_pool_snapshot_check CHECK (
    source_pool_id IS NULL OR source_pool_name IS NOT NULL
  );
