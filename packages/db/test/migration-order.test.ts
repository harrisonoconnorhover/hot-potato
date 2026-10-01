import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function migration(name: string) {
  return readFileSync(
    new URL(`../migrations/${name}`, import.meta.url),
    "utf8",
  );
}

describe("booking-ledger migration ordering", () => {
  it("keeps the legacy job slot guard through the legacy backfill", () => {
    expect(migration("016_legacy_calendar_booking_backfill.sql")).not.toContain(
      "DROP INDEX IF EXISTS jobs_calendar_rep_slot_idx",
    );
  });

  it("retires the legacy guard only after failed ranges are protected", () => {
    const source = migration("020_failed_booking_reservations.sql");
    const replacementGuard = source.indexOf(
      "ADD CONSTRAINT bookings_rep_active_time_excl",
    );
    const legacyDrop = source.indexOf(
      "DROP INDEX IF EXISTS jobs_calendar_rep_slot_idx",
    );

    expect(replacementGuard).toBeGreaterThan(-1);
    expect(legacyDrop).toBeGreaterThan(replacementGuard);
  });

  it("snapshots buffers and rebuilds both durable range guards", () => {
    const source = migration("026_meeting_buffers.sql");

    expect(source).toContain("ADD COLUMN buffer_before_minutes");
    expect(source).toContain("ADD COLUMN buffer_after_minutes");
    expect(source).toContain("bookings_rep_active_time_excl");
    expect(source).toContain("bookings_provider_account_active_time_excl");
    expect(source).toContain("hot_potato_set_booking_reserved_ranges");
    expect(source).toContain("reserved_starts_at");
    expect(source).toContain("reserved_ends_at");
  });

  it("adds explicit attendance outcomes for durable meeting reporting", () => {
    const source = migration("027_booking_reporting.sql");

    expect(source).toContain("ADD COLUMN attendance_outcome");
    expect(source).toContain("ADD COLUMN attendance_recorded_at");
    expect(source).toContain("bookings_attendance_record_shape_check");
    expect(source).toContain("bookings_org_starts_at_idx");
    expect(source).toContain("CREATE TABLE router_funnel_events");
    expect(source).toContain("router_funnel_events_org_submitted_idx");
    expect(source).toContain("FROM router_qualification_sessions");
  });

  it("adds revocable memberships and one-time operator access links", () => {
    const source = migration("029_operator_access_management.sql");

    expect(source).toContain("ADD COLUMN IF NOT EXISTS active boolean");
    expect(source).toContain("ADD COLUMN IF NOT EXISTS user_agent text");
    expect(source).toContain(
      "CREATE TABLE IF NOT EXISTS operator_access_links",
    );
    expect(source).toContain("purpose IN ('invite', 'password_reset')");
    expect(source).toContain("used_at timestamptz");
    expect(source).toContain("revoked_at timestamptz");
  });

  it("binds rep calendar OAuth attempts to membership and representative", () => {
    const source = migration("030_operator_rep_calendar_oauth.sql");

    expect(source).toContain(
      "CREATE TABLE IF NOT EXISTS rep_calendar_oauth_attempts",
    );
    expect(source).toContain("REFERENCES organization_memberships");
    expect(source).toContain("REFERENCES reps (id, organization_id)");
    expect(source).toContain("state_hash char(64) NOT NULL UNIQUE");
    expect(source).toContain(
      "return_to IN ('calendar-readiness', 'my-calendar')",
    );
    expect(source).toContain("rep_calendar_oauth_attempts_pending_idx");
  });

  it("adds first-class representative date availability overrides", () => {
    const source = migration("031_rep_availability_overrides.sql");

    expect(source).toContain("ADD COLUMN IF NOT EXISTS availability_overrides");
    expect(source).toContain("jsonb NOT NULL DEFAULT '{}'::jsonb");
    expect(source).toContain("jsonb_typeof(availability_overrides) = 'object'");
  });

  it("adds organization-scoped reusable availability schedules", () => {
    const source = migration("032_availability_schedules.sql");

    expect(source).toContain(
      "CREATE TABLE IF NOT EXISTS availability_schedules",
    );
    expect(source).toContain("availability_schedules_org_name_idx");
    expect(source).toContain("reps_availability_schedule_org_fk");
    expect(source).toContain(
      "FOREIGN KEY (availability_schedule_id, organization_id)",
    );
  });

  it("allows only one workspace catch-all routing rule", () => {
    const source = migration("033_routing_rule_catch_all.sql");

    expect(source).toContain("routing_rules_one_catch_all_idx");
    expect(source).toContain("ON routing_rules (organization_id)");
    expect(source).toContain("WHERE conditions = '{}'::jsonb");
  });

  it("stores a bounded additional attendee list on the booking ledger", () => {
    const source = migration("034_booking_additional_attendees.sql");

    expect(source).toContain(
      "ADD COLUMN IF NOT EXISTS additional_attendee_emails",
    );
    expect(source).toContain("text[]");
    expect(source).toContain("cardinality(additional_attendee_emails)");
    expect(source).toContain("BETWEEN 0 AND 5");
  });

  it("adds bounded Smart Router success redirects after booking durability work", () => {
    const source = migration("044_smart_router_outcome_controls.sql");

    expect(source).toContain("ADD COLUMN IF NOT EXISTS success_redirect_url");
    expect(source).toContain("success_redirect_delay_seconds");
    expect(source).toContain("router_links_success_redirect_url_check");
    expect(source).toContain("router_links_success_redirect_delay_check");
    expect(source).toContain("success_redirect_url !~ '^https?://[^/]*@'");
  });

  it("adds unique, bounded CRM owner mappings for rotating co-host roles", () => {
    const source = migration("049_cohost_crm_role_writeback.sql");

    expect(source).toContain("ADD COLUMN crm_owner_property text");
    expect(source).toContain(
      "meeting_type_cohost_groups_crm_owner_property_check",
    );
    expect(source).toContain("crm_owner_property <> 'hubspot_owner_id'");
    expect(source).toContain(
      "meeting_type_cohost_groups_crm_owner_property_idx",
    );
    expect(source).toContain("jobs_crm_roles_booking_idx");
    expect(source).toContain("WHERE type = 'crm.roles.writeback'");
  });
});
