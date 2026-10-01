ALTER TABLE oauth_connections
  DROP CONSTRAINT IF EXISTS oauth_connections_provider_check;

ALTER TABLE oauth_connections
  ADD CONSTRAINT oauth_connections_provider_check
  CHECK (provider IN ('hubspot', 'google', 'microsoft'));
