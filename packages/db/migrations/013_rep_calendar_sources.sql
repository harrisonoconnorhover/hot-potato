ALTER TABLE rep_calendar_connections
  ADD COLUMN IF NOT EXISTS calendar_catalog_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS calendar_catalog_error text;

CREATE TABLE IF NOT EXISTS rep_calendar_sources (
  rep_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  provider_calendar_id text NOT NULL
    CHECK (char_length(provider_calendar_id) BETWEEN 1 AND 1024),
  display_name text NOT NULL
    CHECK (char_length(display_name) BETWEEN 1 AND 300),
  is_provider_default boolean NOT NULL DEFAULT false,
  selected_for_conflicts boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz,
  missing_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rep_id, provider, provider_calendar_id),
  FOREIGN KEY (rep_id, provider)
    REFERENCES rep_calendar_connections(rep_id, provider)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS rep_calendar_sources_available_default_idx
  ON rep_calendar_sources (rep_id, provider)
  WHERE is_provider_default AND missing_since IS NULL;

CREATE INDEX IF NOT EXISTS rep_calendar_sources_selected_idx
  ON rep_calendar_sources (rep_id, provider, provider_calendar_id)
  WHERE selected_for_conflicts;

INSERT INTO rep_calendar_sources (
  rep_id, provider, provider_calendar_id, display_name,
  is_provider_default, selected_for_conflicts
)
SELECT connection.rep_id,
       connection.provider,
       CASE connection.provider
         WHEN 'google' THEN 'primary'
         ELSE 'default'
       END,
       CASE connection.provider
         WHEN 'google' THEN 'Primary calendar'
         ELSE 'Default calendar'
       END,
       true,
       connection.check_conflicts OR rep.active_calendar_provider = connection.provider
FROM rep_calendar_connections connection
JOIN reps rep ON rep.id = connection.rep_id
ON CONFLICT (rep_id, provider, provider_calendar_id) DO NOTHING;
