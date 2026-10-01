ALTER TABLE bookings
  ADD COLUMN attendance_outcome text NOT NULL DEFAULT 'unknown',
  ADD COLUMN attendance_recorded_at timestamptz,
  ADD CONSTRAINT bookings_attendance_outcome_check CHECK (
    attendance_outcome IN ('unknown', 'attended', 'no_show')
  ),
  ADD CONSTRAINT bookings_attendance_record_shape_check CHECK (
    (
      attendance_outcome = 'unknown'
      AND attendance_recorded_at IS NULL
    ) OR (
      attendance_outcome IN ('attended', 'no_show')
      AND attendance_recorded_at IS NOT NULL
    )
  );

CREATE INDEX bookings_org_starts_at_idx
  ON bookings (organization_id, starts_at DESC);

-- Qualification sessions contain short-lived buyer data and are deleted or
-- redacted. This PII-free ledger preserves only the durable funnel facts an
-- operator needs for conversion reporting.
CREATE TABLE router_funnel_events (
  session_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,
  router_link_id uuid NOT NULL
    REFERENCES router_links(id) ON DELETE RESTRICT,
  outcome text NOT NULL,
  submitted_at timestamptz NOT NULL,
  booked_at timestamptz,
  CONSTRAINT router_funnel_events_outcome_check CHECK (
    outcome IN ('matched', 'no_match')
  )
);

INSERT INTO router_funnel_events (
  session_id, organization_id, router_link_id, outcome, submitted_at, booked_at
)
SELECT id, organization_id, router_link_id, outcome, created_at, booked_at
FROM router_qualification_sessions
ON CONFLICT (session_id) DO NOTHING;

CREATE INDEX router_funnel_events_org_submitted_idx
  ON router_funnel_events (organization_id, submitted_at DESC);

CREATE INDEX router_funnel_events_link_submitted_idx
  ON router_funnel_events (router_link_id, submitted_at DESC);
