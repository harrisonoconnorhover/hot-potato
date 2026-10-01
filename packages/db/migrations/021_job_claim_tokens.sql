ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS claim_token uuid;

CREATE INDEX IF NOT EXISTS jobs_processing_claim_idx
  ON jobs (id, claim_token)
  WHERE status = 'processing' AND claim_token IS NOT NULL;

COMMENT ON COLUMN jobs.claim_token IS
  'Unique worker lease generation. Completion and failure must present the exact token returned by claimJob.';
