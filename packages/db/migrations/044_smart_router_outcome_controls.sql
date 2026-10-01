ALTER TABLE router_links
  ADD COLUMN IF NOT EXISTS success_redirect_url text,
  ADD COLUMN IF NOT EXISTS success_redirect_delay_seconds smallint NOT NULL DEFAULT 5;

ALTER TABLE router_links
  DROP CONSTRAINT IF EXISTS router_links_success_redirect_url_check,
  ADD CONSTRAINT router_links_success_redirect_url_check CHECK (
    success_redirect_url IS NULL
    OR (
      char_length(success_redirect_url) BETWEEN 8 AND 2048
      AND success_redirect_url !~ '[[:cntrl:]#]'
      AND success_redirect_url !~ '^https?://[^/]*@'
      AND (
        success_redirect_url ~ '^https://'
        OR success_redirect_url ~ '^http://(localhost|127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|\[::1\])(:[0-9]+)?/'
      )
    )
  ),
  DROP CONSTRAINT IF EXISTS router_links_success_redirect_delay_check,
  ADD CONSTRAINT router_links_success_redirect_delay_check CHECK (
    success_redirect_delay_seconds BETWEEN 1 AND 30
  );
