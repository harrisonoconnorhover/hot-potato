CREATE UNIQUE INDEX IF NOT EXISTS meeting_types_id_organization_idx
  ON meeting_types (id, organization_id);

CREATE TABLE IF NOT EXISTS email_tool_recent_assets (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rep_id uuid NOT NULL,
  purpose text NOT NULL,
  asset_kind text NOT NULL,
  meeting_type_id uuid,
  router_link_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, rep_id, purpose),
  CONSTRAINT email_tool_recent_assets_rep_organization_fk
    FOREIGN KEY (rep_id, organization_id)
    REFERENCES reps(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT email_tool_recent_assets_meeting_organization_fk
    FOREIGN KEY (meeting_type_id, organization_id)
    REFERENCES meeting_types(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT email_tool_recent_assets_router_organization_fk
    FOREIGN KEY (router_link_id, organization_id)
    REFERENCES router_links(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT email_tool_recent_assets_purpose_check
    CHECK (purpose IN ('link', 'times')),
  CONSTRAINT email_tool_recent_assets_asset_kind_check
    CHECK (asset_kind IN ('meeting_type', 'router_link')),
  CONSTRAINT email_tool_recent_assets_asset_shape_check
    CHECK (
      (
        asset_kind = 'meeting_type'
        AND meeting_type_id IS NOT NULL
        AND router_link_id IS NULL
      )
      OR (
        asset_kind = 'router_link'
        AND meeting_type_id IS NULL
        AND router_link_id IS NOT NULL
      )
    ),
  CONSTRAINT email_tool_recent_assets_times_meeting_check
    CHECK (purpose <> 'times' OR asset_kind = 'meeting_type')
);
