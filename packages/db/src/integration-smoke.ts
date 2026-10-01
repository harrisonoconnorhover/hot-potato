import { createHash, randomUUID } from "node:crypto";
import { createDatabase } from "./client.js";
import {
  BookingChangeCutoffError,
  CalendarAccountIdentityError,
  CalendarSlotUnavailableError,
  HotPotatoRepository,
  InviteeBookingLimitError,
  OAuthConnectionConflictError,
  RouterFormBridgeValidationError,
  RouterLinkConflictError,
  RouterLinkSessionExpiredError,
  RouterLinkValidationError,
} from "./repository.js";
import type { BookingCandidateQuote } from "./types.js";

const repository = new HotPotatoRepository();
const testDatabase = createDatabase();
const temporaryOrganizationSlug = `routing-studio-${randomUUID()}`;
const secondaryOrganizationSlug = `email-tools-${randomUUID()}`;
const temporaryRepEmail = `routing-studio-${randomUUID()}@example.com`;
const legacyMigrationFixtureMode = process.env.HOT_POTATO_LEGACY_FIXTURE_MODE;
const legacyMigrationFixtureSlug =
  process.env.HOT_POTATO_LEGACY_FIXTURE_SLUG ?? "legacy-booking-backfill";
const legacyPublicFailedExternalId = "9b6331d1-72bf-48c6-a3de-9298d2c46683";
const early024UnsafeExternalId = "early-024-caller-key";
const early024SafeCreateExternalId = "c1e4fcca-610e-4bf6-babb-a24d887de538";
const early024ProviderAccountId = "early-024-provider-account";
const integrationAccountSuffix = randomUUID();
const integrationOrganizationAccountAId = `org-account-a-${integrationAccountSuffix}`;
const integrationOrganizationAccountBId = `org-account-b-${integrationAccountSuffix}`;
const integrationGoogleAccountId = `integration-calendar-${integrationAccountSuffix}`;
const integrationGoogleReplacementAccountId = `integration-calendar-replacement-${integrationAccountSuffix}`;
const integrationOutlookAccountId = `integration-outlook-calendar-${integrationAccountSuffix}`;
const integrationOutlookReplacementAccountId = `integration-outlook-calendar-replacement-${integrationAccountSuffix}`;
const integrationQuoteRaceAccountId = `quote-race-reconnected-account-${integrationAccountSuffix}`;
const integrationUnprovenAccountBId = `unproven-account-b-${integrationAccountSuffix}`;
const integrationIdentifiedAccountBId = `identified-account-b-${integrationAccountSuffix}`;
const integrationRetryAccountBId = `retry-account-b-${integrationAccountSuffix}`;

async function claimJobForIntegration(
  id: number,
  attempts?: number,
): Promise<string> {
  const claimToken = randomUUID();
  const [claimed] =
    attempts === undefined
      ? await testDatabase`
          UPDATE jobs
          SET status = 'processing', attempts = attempts + 1,
              locked_at = now(), claim_token = ${claimToken}
          WHERE id = ${id}
          RETURNING claim_token
        `
      : await testDatabase`
          UPDATE jobs
          SET status = 'processing', attempts = ${attempts},
              locked_at = now(), claim_token = ${claimToken}
          WHERE id = ${id}
          RETURNING claim_token
        `;
  if (!claimed) throw new Error(`Integration job ${id} was not found.`);
  return String(claimed.claimToken);
}

async function seedEarly024UpgradeFixture(): Promise<void> {
  await testDatabase.begin(async (transaction) => {
    const [startingState] = await transaction`
      SELECT
        (SELECT count(*)::integer FROM organizations) AS organizations,
        EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE name = '024_booking_calendar_account_identity.sql'
        ) AS migration_024_applied,
        EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE name = '025_complete_booking_account_hardening.sql'
        ) AS migration_025_applied,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'bookings'
            AND column_name = 'source_external_id'
        ) AS source_column_exists
    `;
    if (
      Number(startingState?.organizations) !== 0 ||
      !startingState?.migration024Applied ||
      !startingState.migration025Applied ||
      !startingState.sourceColumnExists
    ) {
      throw new Error(
        "The early-024 upgrade seed requires a dedicated empty database with migrations 024 and 025 already applied.",
      );
    }

    const [organization] = await transaction`
      INSERT INTO organizations (slug, name)
      VALUES (${legacyMigrationFixtureSlug}, 'Early 024 upgrade fixture')
      RETURNING id
    `;
    const [primaryRep] = await transaction`
      INSERT INTO reps (
        organization_id, name, email, timezone, scheduling_slug,
        active_calendar_provider
      ) VALUES (
        ${organization!.id}, 'Early 024 Primary', 'early-024-primary@example.com',
        'UTC', 'early-024-primary', 'google'
      )
      RETURNING id
    `;
    const [secondaryRep] = await transaction`
      INSERT INTO reps (
        organization_id, name, email, timezone, scheduling_slug,
        active_calendar_provider
      ) VALUES (
        ${organization!.id}, 'Early 024 Secondary',
        'early-024-secondary@example.com', 'UTC', 'early-024-secondary',
        'google'
      )
      RETURNING id
    `;
    await transaction`
      INSERT INTO rep_calendar_connections (
        rep_id, provider, encrypted_access_token, encrypted_refresh_token,
        expires_at, scopes, external_account_id, external_account_name
      ) VALUES (
        ${primaryRep!.id}, 'google', 'early-access-token',
        'early-refresh-token', '2035-01-01T00:00:00.000Z',
        ${["https://www.googleapis.com/auth/calendar.events"]},
        ${early024ProviderAccountId}, 'Early provider account'
      )
    `;
    const [primaryMeetingType] = await transaction`
      INSERT INTO meeting_types (
        organization_id, rep_id, slug, title, duration_minutes,
        minimum_notice_minutes, booking_window_days, conference_provider,
        reminder_minutes
      ) VALUES (
        ${organization!.id}, ${primaryRep!.id}, 'early-024-primary',
        'Early primary meeting', 30, 0, 365, 'none', 0
      )
      RETURNING id
    `;
    const [secondaryMeetingType] = await transaction`
      INSERT INTO meeting_types (
        organization_id, rep_id, slug, title, duration_minutes,
        minimum_notice_minutes, booking_window_days, conference_provider,
        reminder_minutes
      ) VALUES (
        ${organization!.id}, ${secondaryRep!.id}, 'early-024-secondary',
        'Early secondary meeting', 30, 0, 365, 'none', 0
      )
      RETURNING id
    `;
    const [pool] = await transaction`
      INSERT INTO routing_pools (organization_id, slug, name)
      VALUES (${organization!.id}, 'early-024-pool', 'Early 024 pool')
      RETURNING id
    `;
    await transaction`
      INSERT INTO routing_pool_members (pool_id, rep_id)
      VALUES (${pool!.id}, ${primaryRep!.id})
    `;
    const [rule] = await transaction`
      INSERT INTO routing_rules (
        organization_id, name, priority, conditions, pool_id
      ) VALUES (
        ${organization!.id}, 'Early 024 rule', 10, '{}'::jsonb, ${pool!.id}
      )
      RETURNING id
    `;
    const [decision] = await transaction`
      INSERT INTO routing_decisions (
        organization_id, external_id, lead_email, lead, rule_id, pool_id,
        rep_id, reason
      ) VALUES (
        ${organization!.id}, 'early-024-decision',
        'early-024-buyer@example.com',
        ${transaction.json({
          name: "Early 024 Buyer",
          email: "early-024-buyer@example.com",
        })},
        ${rule!.id}, ${pool!.id}, ${primaryRep!.id}, 'Early 024 fixture'
      )
      RETURNING id
    `;
    const [unsafeBooking] = await transaction`
      INSERT INTO bookings (
        organization_id, meeting_type_id, rep_id, routing_decision_id,
        external_id, source_external_id, manage_token_hash, status,
        attendee_name, attendee_email, starts_at, ends_at, calendar_provider,
        calendar_external_account_id, conference_provider, external_event_id
      ) VALUES (
        ${organization!.id}, ${primaryMeetingType!.id}, ${primaryRep!.id},
        ${decision!.id}, ${early024UnsafeExternalId}, NULL,
        ${createHash("sha256").update(early024UnsafeExternalId).digest("hex")},
        'confirmed', 'Early 024 Buyer', 'early-024-buyer@example.com',
        '2032-02-01T10:00:00.000Z', '2032-02-01T10:30:00.000Z',
        'google', ${early024ProviderAccountId}, 'none',
        'early-024-provider-event'
      )
      RETURNING id
    `;
    await transaction`
      INSERT INTO jobs (organization_id, type, payload, status)
      VALUES (
        ${organization!.id}, 'email.booking.confirmation',
        ${transaction.json({
          bookingId: String(unsafeBooking!.id),
          to: "early-024-buyer@example.com",
          managePath: `/schedule/manage/${early024UnsafeExternalId}`,
          marker: "early-024-unsafe-manage-path",
        })},
        'pending'
      )
    `;
    const [safeCreateBooking] = await transaction`
      INSERT INTO bookings (
        organization_id, meeting_type_id, rep_id, external_id,
        source_external_id, manage_token_hash, status, attendee_name,
        attendee_email, starts_at, ends_at, calendar_provider,
        calendar_external_account_id, conference_provider
      ) VALUES (
        ${organization!.id}, ${primaryMeetingType!.id}, ${primaryRep!.id},
        ${early024SafeCreateExternalId}, NULL,
        ${createHash("sha256")
          .update(early024SafeCreateExternalId)
          .digest("hex")},
        'pending', 'Early Safe Create', 'early-safe-create@example.com',
        '2032-02-01T11:00:00.000Z', '2032-02-01T11:30:00.000Z',
        'google', NULL, 'none'
      )
      RETURNING id
    `;
    await transaction`
      INSERT INTO jobs (organization_id, type, payload, status)
      VALUES (
        ${organization!.id}, 'calendar.event.create',
        ${transaction.json({
          bookingId: String(safeCreateBooking!.id),
          externalId: early024SafeCreateExternalId,
          organizationSlug: legacyMigrationFixtureSlug,
          schedulingSlug: "early-024-primary",
          publicBooking: true,
          repId: String(primaryRep!.id),
          provider: "google",
          startsAt: "2032-02-01T11:00:00.000Z",
          endsAt: "2032-02-01T11:30:00.000Z",
          attendeeName: "Early Safe Create",
          attendeeEmail: "early-safe-create@example.com",
        })},
        'pending'
      )
    `;

    // Reproduce the exact shape recorded by the early 024: account identity
    // and the revised per-rep exclusion exist, while the later hardening does
    // not. This mode is intentionally restricted to a dedicated empty database.
    await transaction`
      ALTER TABLE bookings
        DROP CONSTRAINT IF EXISTS bookings_provider_account_active_time_excl,
        DROP CONSTRAINT IF EXISTS bookings_source_external_id_check
    `;
    await transaction`
      DROP INDEX IF EXISTS
        rep_calendar_connections_provider_external_account_uidx
    `;
    await transaction`
      DROP INDEX IF EXISTS bookings_org_source_external_uidx
    `;
    await transaction`
      ALTER TABLE bookings
        DROP COLUMN IF EXISTS source_external_id,
        ALTER COLUMN manage_token_hash SET NOT NULL
    `;
    await transaction`
      DELETE FROM schema_migrations
      WHERE name = '025_complete_booking_account_hardening.sql'
    `;

    const [earlyShape] = await transaction`
      SELECT
        EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE name = '024_booking_calendar_account_identity.sql'
        ) AS migration_024_applied,
        EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE name = '025_complete_booking_account_hardening.sql'
        ) AS migration_025_applied,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'bookings'
            AND column_name = 'calendar_external_account_id'
        ) AS account_column_exists,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'bookings'
            AND column_name = 'source_external_id'
        ) AS source_column_exists,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'bookings'::regclass
            AND conname = 'bookings_rep_active_time_excl'
        ) AS rep_exclusion_exists,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'bookings'::regclass
            AND conname = 'bookings_provider_account_active_time_excl'
        ) AS provider_exclusion_exists,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'bookings'
            AND column_name = 'manage_token_hash' AND is_nullable = 'NO'
        ) AS manage_token_required
    `;
    if (
      !earlyShape?.migration024Applied ||
      earlyShape.migration025Applied ||
      !earlyShape.accountColumnExists ||
      earlyShape.sourceColumnExists ||
      !earlyShape.repExclusionExists ||
      earlyShape.providerExclusionExists ||
      !earlyShape.manageTokenRequired
    ) {
      throw new Error(
        "The early-024 schema fixture was not reproduced exactly.",
      );
    }

    // Keep this selected value used in the fixture schema so TypeScript and
    // future fixture edits cannot silently drop the second-rep probe target.
    if (!secondaryMeetingType?.id) {
      throw new Error("The early-024 secondary meeting type was not created.");
    }
  });
}

async function verifyEarly024UpgradeFixture(): Promise<void> {
  try {
    const [schema] = await testDatabase`
      SELECT
        EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE name = '025_complete_booking_account_hardening.sql'
        ) AS migration_025_applied,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'bookings'
            AND column_name = 'source_external_id'
        ) AS source_column_exists,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'bookings'
            AND column_name = 'manage_token_hash' AND is_nullable = 'YES'
        ) AS manage_token_nullable,
        to_regclass('public.bookings_org_source_external_uidx')
          AS source_index,
        to_regclass(
          'public.rep_calendar_connections_provider_external_account_uidx'
        ) AS account_index,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'bookings'::regclass
            AND conname = 'bookings_rep_active_time_excl'
        ) AS rep_exclusion_exists,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'bookings'::regclass
            AND conname = 'bookings_provider_account_active_time_excl'
        ) AS provider_exclusion_exists
    `;
    if (
      !schema?.migration025Applied ||
      !schema.sourceColumnExists ||
      !schema.manageTokenNullable ||
      !schema.sourceIndex ||
      !schema.accountIndex ||
      !schema.repExclusionExists ||
      !schema.providerExclusionExists
    ) {
      throw new Error(
        "Migration 025 did not complete the early-024 schema hardening.",
      );
    }

    const [unsafeBooking] = await testDatabase`
      SELECT b.id, b.status, b.source_external_id, b.manage_token_hash,
             message.status AS message_status,
             message.payload ? 'managePath' AS message_has_manage_path
      FROM organizations organization
      JOIN bookings b ON b.organization_id = organization.id
      JOIN jobs message
        ON message.organization_id = organization.id
       AND message.type = 'email.booking.confirmation'
       AND message.payload->>'bookingId' = b.id::text
       AND message.payload->>'marker' = 'early-024-unsafe-manage-path'
      WHERE organization.slug = ${legacyMigrationFixtureSlug}
        AND b.external_id = ${early024UnsafeExternalId}
    `;
    if (
      unsafeBooking?.status !== "confirmed" ||
      unsafeBooking.sourceExternalId !== early024UnsafeExternalId ||
      unsafeBooking.manageTokenHash !== null ||
      unsafeBooking.messageStatus !== "pending" ||
      unsafeBooking.messageHasManagePath
    ) {
      throw new Error(
        "Migration 025 did not separate caller idempotency from the unsafe legacy management token.",
      );
    }

    const [safeCreate] = await testDatabase`
      SELECT b.status AS booking_status, b.calendar_external_account_id,
             b.manage_token_hash, create_job.status AS job_status
      FROM organizations organization
      JOIN bookings b ON b.organization_id = organization.id
      JOIN jobs create_job
        ON create_job.organization_id = organization.id
       AND create_job.type = 'calendar.event.create'
       AND create_job.payload->>'bookingId' = b.id::text
      WHERE organization.slug = ${legacyMigrationFixtureSlug}
        AND b.external_id = ${early024SafeCreateExternalId}
    `;
    if (
      safeCreate?.bookingStatus !== "cancelled" ||
      safeCreate.jobStatus !== "cancelled" ||
      safeCreate.calendarExternalAccountId !== null ||
      safeCreate.manageTokenHash !==
        createHash("sha256").update(early024SafeCreateExternalId).digest("hex")
    ) {
      throw new Error(
        "Migration 025 did not safely withdraw the unstarted account-unbound create.",
      );
    }

    let duplicateSourceCode: string | undefined;
    try {
      await testDatabase`
        INSERT INTO bookings (
          organization_id, meeting_type_id, rep_id, external_id,
          source_external_id, manage_token_hash, status, attendee_name,
          attendee_email, starts_at, ends_at, calendar_provider,
          conference_provider
        )
        SELECT organization.id, meeting_type.id, rep.id,
               'early-024-source-duplicate-probe',
               ${early024UnsafeExternalId}, NULL, 'cancelled',
               'Source Duplicate', 'source-duplicate@example.com',
               '2032-02-03T10:00:00.000Z', '2032-02-03T10:30:00.000Z',
               'google', 'none'
        FROM organizations organization
        JOIN reps rep
          ON rep.organization_id = organization.id
         AND rep.scheduling_slug = 'early-024-secondary'
        JOIN meeting_types meeting_type
          ON meeting_type.organization_id = organization.id
         AND meeting_type.rep_id = rep.id
        WHERE organization.slug = ${legacyMigrationFixtureSlug}
      `;
    } catch (error) {
      duplicateSourceCode = (error as { code?: string }).code;
    }

    let duplicateAccountCode: string | undefined;
    try {
      await testDatabase`
        INSERT INTO rep_calendar_connections (
          rep_id, provider, encrypted_access_token, encrypted_refresh_token,
          expires_at, scopes, external_account_id, external_account_name
        )
        SELECT rep.id, 'google', 'duplicate-access', 'duplicate-refresh',
               '2035-01-01T00:00:00.000Z',
               ${["https://www.googleapis.com/auth/calendar.events"]},
               ${early024ProviderAccountId}, 'Duplicate account probe'
        FROM organizations organization
        JOIN reps rep
          ON rep.organization_id = organization.id
         AND rep.scheduling_slug = 'early-024-secondary'
        WHERE organization.slug = ${legacyMigrationFixtureSlug}
      `;
    } catch (error) {
      duplicateAccountCode = (error as { code?: string }).code;
    }

    let providerOverlapCode: string | undefined;
    try {
      await testDatabase`
        INSERT INTO bookings (
          organization_id, meeting_type_id, rep_id, external_id,
          source_external_id, manage_token_hash, status, attendee_name,
          attendee_email, starts_at, ends_at, calendar_provider,
          calendar_external_account_id, conference_provider
        )
        SELECT organization.id, meeting_type.id, rep.id,
               'early-024-provider-overlap-probe',
               'early-024-provider-overlap-probe', NULL, 'confirmed',
               'Provider Overlap', 'provider-overlap@example.com',
               '2032-02-01T10:15:00.000Z', '2032-02-01T10:45:00.000Z',
               'google', ${early024ProviderAccountId}, 'none'
        FROM organizations organization
        JOIN reps rep
          ON rep.organization_id = organization.id
         AND rep.scheduling_slug = 'early-024-secondary'
        JOIN meeting_types meeting_type
          ON meeting_type.organization_id = organization.id
         AND meeting_type.rep_id = rep.id
        WHERE organization.slug = ${legacyMigrationFixtureSlug}
      `;
    } catch (error) {
      providerOverlapCode = (error as { code?: string }).code;
    }

    if (
      duplicateSourceCode !== "23505" ||
      duplicateAccountCode !== "23505" ||
      providerOverlapCode !== "23P01"
    ) {
      throw new Error(
        "Migration 025 did not enforce source, provider-owner, and provider-range uniqueness after upgrading early 024.",
      );
    }
  } finally {
    await testDatabase`
      DELETE FROM organizations WHERE slug = ${legacyMigrationFixtureSlug}
    `;
  }
}

async function seedLegacyMigrationFixture(
  fixture:
    | "valid"
    | "malformed"
    | "linked-mismatch"
    | "malformed-reschedule"
    | "malformed-cancel"
    | "uncertain-create"
    | "processing-reconciliation"
    | "duplicate-account",
): Promise<void> {
  await testDatabase.begin(async (transaction) => {
    await transaction`
      DELETE FROM organizations WHERE slug = ${legacyMigrationFixtureSlug}
    `;
    const [organization] = await transaction`
      INSERT INTO organizations (slug, name)
      VALUES (${legacyMigrationFixtureSlug}, 'Legacy booking migration fixture')
      RETURNING id
    `;
    const [rep] = await transaction`
      INSERT INTO reps (
        organization_id, name, email, timezone, scheduling_slug,
        active_calendar_provider
      ) VALUES (
        ${organization!.id}, 'Legacy Fixture Rep',
        'legacy-fixture-rep@example.com', 'UTC', 'legacy-fixture-rep',
        'google'
      )
      RETURNING id
    `;
    await transaction`
      INSERT INTO rep_calendar_connections (
        rep_id, provider, encrypted_access_token, encrypted_refresh_token,
        expires_at, scopes, external_account_id, external_account_name
      ) VALUES (
        ${rep!.id}, 'google', 'fixture-access-token', 'fixture-refresh-token',
        '2035-01-01T00:00:00.000Z',
        ${["https://www.googleapis.com/auth/calendar.events"]},
        'legacy-fixture-calendar', 'Legacy fixture calendar'
      )
    `;
    const [meetingType] = await transaction`
      INSERT INTO meeting_types (
        organization_id, rep_id, slug, title, description,
        duration_minutes, minimum_notice_minutes, booking_window_days,
        conference_provider, reminder_minutes
      ) VALUES (
        ${organization!.id}, ${rep!.id}, 'legacy-fixture-rep',
        'Current default meeting', 'Current description must not rewrite history.',
        30, 0, 365, 'google_meet', 60
      )
      RETURNING id
    `;

    if (fixture === "malformed") {
      await transaction`
        INSERT INTO jobs (organization_id, type, payload)
        VALUES (
          ${organization!.id}, 'calendar.event.create',
          ${transaction.json({
            externalId: "legacy-malformed-active",
            organizationSlug: legacyMigrationFixtureSlug,
            schedulingSlug: "legacy-fixture-rep",
            publicBooking: true,
            repId: String(rep!.id),
            repEmail: "legacy-fixture-rep@example.com",
            provider: "google",
            startsAt: "2031-01-01T09:00:00.000Z",
            subject: "Malformed legacy booking",
            attendeeName: "Malformed Attendee",
            attendeeEmail: "malformed-attendee@example.com",
          })}
        )
      `;
      return;
    }

    if (fixture === "uncertain-create") {
      await transaction`
        INSERT INTO jobs (
          organization_id, type, payload, status, attempts, locked_at
        ) VALUES (
          ${organization!.id}, 'calendar.event.create',
          ${transaction.json({
            externalId: "legacy-uncertain-create",
            organizationSlug: legacyMigrationFixtureSlug,
            schedulingSlug: "legacy-fixture-rep",
            publicBooking: true,
            repId: String(rep!.id),
            repEmail: "legacy-fixture-rep@example.com",
            provider: "google",
            startsAt: "2031-01-03T09:00:00.000Z",
            endsAt: "2031-01-03T09:30:00.000Z",
            subject: "Uncertain legacy create",
            attendeeName: "Uncertain Create",
            attendeeEmail: "uncertain-create@example.com",
          })},
          'processing', 1, now()
        )
      `;
      return;
    }

    if (fixture === "processing-reconciliation") {
      const reconciliationExternalId = "5c8e996c-301a-45e2-aa58-88dbfd8957bd";
      const [booking] = await transaction`
        INSERT INTO bookings (
          organization_id, meeting_type_id, rep_id, external_id,
          manage_token_hash, status, attendee_name, attendee_email,
          starts_at, ends_at, calendar_provider, conference_provider,
          last_error
        ) VALUES (
          ${organization!.id}, ${meetingType!.id}, ${rep!.id},
          ${reconciliationExternalId},
          ${createHash("sha256").update(reconciliationExternalId).digest("hex")},
          'pending', 'Processing Reconciliation',
          'processing-reconciliation@example.com',
          '2031-01-04T09:00:00.000Z', '2031-01-04T09:30:00.000Z',
          'google', 'none', NULL
        )
        RETURNING id
      `;
      const [createJob] = await transaction`
        INSERT INTO jobs (
          organization_id, type, payload, status, attempts, last_error
        ) VALUES (
          ${organization!.id}, 'calendar.event.create',
          ${transaction.json({
            bookingId: String(booking!.id),
            externalId: reconciliationExternalId,
            organizationSlug: legacyMigrationFixtureSlug,
            schedulingSlug: "legacy-fixture-rep",
            publicBooking: true,
            repId: String(rep!.id),
            provider: "google",
            startsAt: "2031-01-04T09:00:00.000Z",
            endsAt: "2031-01-04T09:30:00.000Z",
            attendeeName: "Processing Reconciliation",
            attendeeEmail: "processing-reconciliation@example.com",
          })},
          'failed', 5, 'provider outcome uncertain'
        )
        RETURNING id
      `;
      const claimToken = randomUUID();
      await transaction`
        INSERT INTO jobs (
          organization_id, type, payload, status, attempts,
          locked_at, claim_token
        ) VALUES (
          ${organization!.id}, 'calendar.event.create.reconcile',
          ${transaction.json({
            bookingId: String(booking!.id),
            externalId: reconciliationExternalId,
            organizationSlug: legacyMigrationFixtureSlug,
            repId: String(rep!.id),
            provider: "google",
            startsAt: "2031-01-04T09:00:00.000Z",
            endsAt: "2031-01-04T09:30:00.000Z",
            reconciliationForJobId: Number(createJob!.id),
            reconciliationIntent: "resolve",
          })},
          'processing', 1, now(), ${claimToken}
        )
      `;
      return;
    }

    if (fixture === "duplicate-account") {
      const [duplicateRep] = await transaction`
        INSERT INTO reps (
          organization_id, name, email, timezone, scheduling_slug,
          active_calendar_provider
        ) VALUES (
          ${organization!.id}, 'Duplicate Account Rep',
          'duplicate-account-rep@example.com', 'UTC',
          'duplicate-account-rep', 'google'
        )
        RETURNING id
      `;
      await transaction`
        INSERT INTO rep_calendar_connections (
          rep_id, provider, encrypted_access_token, encrypted_refresh_token,
          expires_at, scopes, external_account_id, external_account_name
        ) VALUES (
          ${duplicateRep!.id}, 'google', 'duplicate-access-token',
          'duplicate-refresh-token', '2035-01-01T00:00:00.000Z',
          ${["https://www.googleapis.com/auth/calendar.events"]},
          'legacy-fixture-calendar', 'Duplicate fixture calendar'
        )
      `;
      return;
    }

    if (fixture === "linked-mismatch") {
      const linkedExternalId = "legacy-linked-provider-mismatch";
      const [booking] = await transaction`
        INSERT INTO bookings (
          organization_id, meeting_type_id, rep_id, external_id,
          manage_token_hash, status, attendee_name, attendee_email,
          starts_at, ends_at, calendar_provider, conference_provider,
          external_event_id
        ) VALUES (
          ${organization!.id}, ${meetingType!.id}, ${rep!.id},
          ${linkedExternalId},
          ${createHash("sha256").update(linkedExternalId).digest("hex")},
          'confirmed', 'Linked Mismatch', 'linked-mismatch@example.com',
          '2031-01-01T09:00:00.000Z', '2031-01-01T09:30:00.000Z',
          'google', 'none', 'booking-provider-event'
        )
        RETURNING id
      `;
      await transaction`
        INSERT INTO jobs (
          organization_id, type, payload, status, result, completed_at
        ) VALUES (
          ${organization!.id}, 'calendar.event.create',
          ${transaction.json({
            bookingId: String(booking!.id),
            externalId: linkedExternalId,
            organizationSlug: legacyMigrationFixtureSlug,
            schedulingSlug: "legacy-fixture-rep",
            publicBooking: true,
            repId: String(rep!.id),
            repName: "Legacy Fixture Rep",
            repEmail: "legacy-fixture-rep@example.com",
            repTimezone: "UTC",
            provider: "google",
            startsAt: "2031-01-01T09:00:00.000Z",
            endsAt: "2031-01-01T09:30:00.000Z",
            subject: "Linked provider mismatch",
            description: "",
            attendeeName: "Linked Mismatch",
            attendeeEmail: "linked-mismatch@example.com",
            conferenceProvider: "none",
            conferenceUrl: null,
            reminderMinutes: 0,
          })},
          'completed',
          ${transaction.json({ externalEventId: "job-provider-event" })},
          now()
        )
      `;
      return;
    }

    if (fixture === "malformed-reschedule" || fixture === "malformed-cancel") {
      const isReschedule = fixture === "malformed-reschedule";
      const lifecycleExternalId = isReschedule
        ? "legacy-malformed-reschedule"
        : "legacy-malformed-cancel";
      const [booking] = await transaction`
        INSERT INTO bookings (
          organization_id, meeting_type_id, rep_id, external_id,
          manage_token_hash, status, attendee_name, attendee_email,
          starts_at, ends_at, calendar_provider, conference_provider,
          external_event_id
        ) VALUES (
          ${organization!.id}, ${meetingType!.id}, ${rep!.id},
          ${lifecycleExternalId},
          ${createHash("sha256").update(lifecycleExternalId).digest("hex")},
          ${isReschedule ? "reschedule_pending" : "cancel_pending"},
          'Malformed Lifecycle', 'malformed-lifecycle@example.com',
          '2031-01-02T10:00:00.000Z', '2031-01-02T10:30:00.000Z',
          'google', 'none', 'expected-provider-event'
        )
        RETURNING id
      `;
      await transaction`
        INSERT INTO jobs (organization_id, type, payload, status)
        VALUES (
          ${organization!.id},
          ${isReschedule ? "calendar.event.update" : "calendar.event.cancel"},
          ${transaction.json({
            bookingId: String(booking!.id),
            externalId: lifecycleExternalId,
            externalEventId: "wrong-provider-event",
            organizationSlug: legacyMigrationFixtureSlug,
            repId: String(rep!.id),
            provider: "google",
            ...(isReschedule
              ? {
                  startsAt: "2031-01-02T10:00:00.000Z",
                  endsAt: "2031-01-02T10:30:00.000Z",
                  previousStartsAt: "2031-01-02T09:00:00.000Z",
                  previousEndsAt: "2031-01-02T09:30:00.000Z",
                }
              : {}),
          })},
          'pending'
        )
      `;
      return;
    }

    const [pool] = await transaction`
      INSERT INTO routing_pools (organization_id, slug, name)
      VALUES (${organization!.id}, 'legacy-fixture-pool', 'Legacy fixture pool')
      RETURNING id
    `;
    await transaction`
      INSERT INTO routing_pool_members (pool_id, rep_id)
      VALUES (${pool!.id}, ${rep!.id})
    `;
    const [rule] = await transaction`
      INSERT INTO routing_rules (
        organization_id, name, priority, conditions, pool_id
      ) VALUES (
        ${organization!.id}, 'Legacy fixture rule', 10, '{}'::jsonb, ${pool!.id}
      )
      RETURNING id
    `;
    const [pendingDecision] = await transaction`
      INSERT INTO routing_decisions (
        organization_id, external_id, lead_email, lead, rule_id, pool_id,
        rep_id, reason
      ) VALUES (
        ${organization!.id}, 'legacy-pending-decision',
        'dashboard-lead@example.com',
        ${transaction.json({
          name: "Dashboard Lead",
          email: "dashboard-lead@example.com",
        })},
        ${rule!.id}, ${pool!.id}, ${rep!.id}, 'Legacy pending fixture'
      )
      RETURNING id
    `;
    const [completedDecision] = await transaction`
      INSERT INTO routing_decisions (
        organization_id, external_id, lead_email, lead, rule_id, pool_id,
        rep_id, reason
      ) VALUES (
        ${organization!.id}, 'legacy-completed-decision',
        'completed-lead@example.com',
        ${transaction.json({
          name: "Completed Lead",
          email: "completed-lead@example.com",
        })},
        ${rule!.id}, ${pool!.id}, ${rep!.id}, 'Legacy completed fixture'
      )
      RETURNING id
    `;

    await transaction`
      INSERT INTO jobs (organization_id, type, payload, status)
      VALUES (
        ${organization!.id}, 'calendar.event.create',
        ${transaction.json({
          externalId: " legacy-dashboard-pending ",
          organizationSlug: legacyMigrationFixtureSlug,
          decisionId: String(pendingDecision!.id),
          repId: String(rep!.id),
          repEmail: "legacy-fixture-rep@example.com",
          provider: "google",
          startsAt: "2031-01-01T10:00:00.000Z",
          endsAt: "2031-01-01T10:30:00.000Z",
          subject: "Legacy dashboard pending",
          attendeeEmail: "dashboard-override@example.com",
        })},
        'pending'
      )
    `;
    const peerOrganizationSlug = `${legacyMigrationFixtureSlug}-peer`;
    const [peerOrganization] = await transaction`
      INSERT INTO organizations (slug, name)
      VALUES (${peerOrganizationSlug}, 'Legacy fixture peer')
      RETURNING id
    `;
    const [peerRep] = await transaction`
      INSERT INTO reps (
        organization_id, name, email, timezone, scheduling_slug,
        active_calendar_provider
      ) VALUES (
        ${peerOrganization!.id}, 'Legacy Fixture Peer Rep',
        'legacy-fixture-peer@example.com', 'UTC',
        'legacy-fixture-peer', 'google'
      )
      RETURNING id
    `;
    await transaction`
      INSERT INTO rep_calendar_connections (
        rep_id, provider, encrypted_access_token, encrypted_refresh_token,
        expires_at, scopes, external_account_id, external_account_name
      ) VALUES (
        ${peerRep!.id}, 'google', 'peer-access-token', 'peer-refresh-token',
        '2035-01-01T00:00:00.000Z',
        ${["https://www.googleapis.com/auth/calendar.events"]},
        'legacy-fixture-peer-calendar', 'Legacy fixture peer calendar'
      )
    `;
    await transaction`
      INSERT INTO meeting_types (
        organization_id, rep_id, slug, title, description,
        duration_minutes, minimum_notice_minutes, booking_window_days,
        conference_provider, reminder_minutes
      ) VALUES (
        ${peerOrganization!.id}, ${peerRep!.id}, 'legacy-fixture-peer',
        'Peer default meeting', '', 30, 0, 365, 'none', 0
      )
    `;
    const [peerPool] = await transaction`
      INSERT INTO routing_pools (organization_id, slug, name)
      VALUES (${peerOrganization!.id}, 'peer-pool', 'Peer pool')
      RETURNING id
    `;
    await transaction`
      INSERT INTO routing_pool_members (pool_id, rep_id)
      VALUES (${peerPool!.id}, ${peerRep!.id})
    `;
    const [peerRule] = await transaction`
      INSERT INTO routing_rules (
        organization_id, name, priority, conditions, pool_id
      ) VALUES (
        ${peerOrganization!.id}, 'Peer rule', 10, '{}'::jsonb,
        ${peerPool!.id}
      )
      RETURNING id
    `;
    const [peerDecision] = await transaction`
      INSERT INTO routing_decisions (
        organization_id, external_id, lead_email, lead, rule_id, pool_id,
        rep_id, reason
      ) VALUES (
        ${peerOrganization!.id}, 'peer-dashboard-decision',
        'peer-dashboard@example.com',
        ${transaction.json({
          name: "Peer Dashboard Lead",
          email: "peer-dashboard@example.com",
        })},
        ${peerRule!.id}, ${peerPool!.id}, ${peerRep!.id}, 'Peer fixture'
      )
      RETURNING id
    `;
    await transaction`
      INSERT INTO jobs (organization_id, type, payload, status)
      VALUES (
        ${peerOrganization!.id}, 'calendar.event.create',
        ${transaction.json({
          externalId: " legacy-dashboard-pending ",
          organizationSlug: peerOrganizationSlug,
          decisionId: String(peerDecision!.id),
          repId: String(peerRep!.id),
          repEmail: "legacy-fixture-peer@example.com",
          provider: "google",
          startsAt: "2031-01-03T10:00:00.000Z",
          endsAt: "2031-01-03T10:30:00.000Z",
          subject: "Peer legacy dashboard pending",
        })},
        'pending'
      )
    `;
    await transaction`
      INSERT INTO jobs (organization_id, type, payload, status)
      VALUES (
        ${organization!.id}, 'calendar.event.create',
        ${transaction.json({
          externalId: "legacy-public-processing",
          organizationSlug: legacyMigrationFixtureSlug,
          schedulingSlug: "legacy-fixture-rep",
          publicBooking: true,
          repId: String(rep!.id),
          repEmail: "legacy-fixture-rep@example.com",
          provider: "google",
          startsAt: "2031-01-01T11:00:00.000Z",
          endsAt: "2031-01-01T11:30:00.000Z",
          subject: "Legacy public processing",
          description: "Original public description.",
          attendeeName: "Public Processing",
          attendeeEmail: "public-processing@example.com",
        })},
        'pending'
      )
    `;
    await transaction`
      INSERT INTO jobs (
        organization_id, type, payload, status, result, completed_at
      ) VALUES (
        ${organization!.id}, 'calendar.event.create',
        ${transaction.json({
          externalId: "legacy-dashboard-completed",
          organizationSlug: legacyMigrationFixtureSlug,
          decisionId: String(completedDecision!.id),
          repId: String(rep!.id),
          repEmail: "legacy-fixture-rep@example.com",
          provider: "google",
          startsAt: "2031-01-01T12:00:00.000Z",
          endsAt: "2031-01-01T12:30:00.000Z",
          subject: "Legacy dashboard completed",
        })},
        'completed',
        ${transaction.json({
          externalEventId: "legacy-provider-event",
          webLink: "https://calendar.example.com/legacy-provider-event",
          conferenceUrl: "https://meet.google.com/legacy-provider-room",
        })},
        now()
      )
    `;
    await transaction`
      INSERT INTO jobs (
        organization_id, type, payload, status, attempts, last_error
      ) VALUES (
        ${organization!.id}, 'calendar.event.create',
        ${transaction.json({
          externalId: legacyPublicFailedExternalId,
          organizationSlug: legacyMigrationFixtureSlug,
          schedulingSlug: "legacy-fixture-rep",
          publicBooking: true,
          repId: String(rep!.id),
          repEmail: "legacy-fixture-rep@example.com",
          provider: "google",
          startsAt: "2031-01-01T13:00:00.000Z",
          endsAt: "2031-01-01T13:30:00.000Z",
          subject: "Legacy public failed",
          description: "Original failed description.",
          attendeeName: "Public Failed",
          attendeeEmail: "public-failed@example.com",
        })},
        'failed', 5, 'legacy provider failure'
      )
    `;
    await transaction`
      INSERT INTO jobs (
        organization_id, type, payload, status, attempts, last_error
      ) VALUES (
        ${organization!.id}, 'calendar.event.create',
        ${transaction.json({
          externalId: "legacy-public-cancelled-absent",
          organizationSlug: legacyMigrationFixtureSlug,
          schedulingSlug: "legacy-fixture-rep",
          publicBooking: true,
          repId: String(rep!.id),
          repEmail: "legacy-fixture-rep@example.com",
          provider: "google",
          startsAt: "2031-01-01T14:00:00.000Z",
          endsAt: "2031-01-01T14:30:00.000Z",
          subject: "Legacy public cancelled absent",
          description: "Original absent cancelled description.",
          attendeeName: "Public Cancelled Absent",
          attendeeEmail: "public-cancelled-absent@example.com",
        })},
        'cancelled', 0, 'legacy cancelled before provider outcome'
      )
    `;
    await transaction`
      INSERT INTO jobs (
        organization_id, type, payload, status, attempts, last_error
      ) VALUES (
        ${organization!.id}, 'calendar.event.create',
        ${transaction.json({
          externalId: "legacy-public-cancelled-found",
          organizationSlug: legacyMigrationFixtureSlug,
          schedulingSlug: "legacy-fixture-rep",
          publicBooking: true,
          repId: String(rep!.id),
          repEmail: "legacy-fixture-rep@example.com",
          provider: "google",
          startsAt: "2031-01-01T15:00:00.000Z",
          endsAt: "2031-01-01T15:30:00.000Z",
          subject: "Legacy public cancelled found",
          description: "Original found cancelled description.",
          attendeeName: "Public Cancelled Found",
          attendeeEmail: "public-cancelled-found@example.com",
        })},
        'cancelled', 0, 'legacy cancelled before provider outcome'
      )
    `;
    await transaction`
      INSERT INTO jobs (
        organization_id, type, payload, status, attempts, last_error
      ) VALUES (
        ${organization!.id}, 'calendar.event.create',
        ${transaction.json({
          externalId: "legacy-public-cancelled-past",
          organizationSlug: legacyMigrationFixtureSlug,
          schedulingSlug: "legacy-fixture-rep",
          publicBooking: true,
          repId: String(rep!.id),
          repEmail: "legacy-fixture-rep@example.com",
          provider: "google",
          startsAt: "2020-01-01T15:00:00.000Z",
          endsAt: "2020-01-01T15:30:00.000Z",
          subject: "Legacy public cancelled past",
          description: "Historical provider outcome reconciliation.",
          attendeeName: "Public Cancelled Past",
          attendeeEmail: "public-cancelled-past@example.com",
        })},
        'cancelled', 0, 'legacy cancelled before provider outcome'
      )
    `;

    const [safeRescheduleDecision] = await transaction`
      INSERT INTO routing_decisions (
        organization_id, external_id, lead_email, lead, rule_id, pool_id,
        rep_id, reason
      ) VALUES (
        ${organization!.id}, 'legacy-safe-reschedule-decision',
        'safe-reschedule@example.com',
        ${transaction.json({
          name: "Safe Reschedule",
          email: "safe-reschedule@example.com",
        })},
        ${rule!.id}, ${pool!.id}, ${rep!.id},
        'Legacy safe reschedule fixture'
      )
      RETURNING id
    `;
    const safeRescheduleExternalId = "legacy-safe-reschedule";
    const safeRescheduleEventId = "legacy-safe-reschedule-event";
    const [safeRescheduleBooking] = await transaction`
      INSERT INTO bookings (
        organization_id, meeting_type_id, rep_id, routing_decision_id,
        external_id,
        manage_token_hash, status, attendee_name, attendee_email,
        starts_at, ends_at, previous_starts_at, previous_ends_at,
        calendar_provider, conference_provider, external_event_id
      ) VALUES (
        ${organization!.id}, ${meetingType!.id}, ${rep!.id},
        ${safeRescheduleDecision!.id},
        ${safeRescheduleExternalId},
        ${createHash("sha256").update(safeRescheduleExternalId).digest("hex")},
        'reschedule_pending', 'Safe Reschedule',
        'safe-reschedule@example.com',
        '2031-01-02T10:00:00.000Z', '2031-01-02T10:30:00.000Z',
        '2031-01-02T09:30:00.000Z', '2031-01-02T10:00:00.000Z',
        'google', 'none', ${safeRescheduleEventId}
      )
      RETURNING id
    `;
    const safeRescheduleBasePayload = {
      bookingId: String(safeRescheduleBooking!.id),
      externalId: safeRescheduleExternalId,
      externalEventId: safeRescheduleEventId,
      organizationSlug: legacyMigrationFixtureSlug,
      schedulingSlug: "legacy-fixture-rep",
      repId: String(rep!.id),
      repName: "Legacy Fixture Rep",
      repEmail: "legacy-fixture-rep@example.com",
      repTimezone: "UTC",
      provider: "google",
      subject: "Legacy safe reschedule",
      description: "",
      attendeeName: "Safe Reschedule",
      attendeeEmail: "safe-reschedule@example.com",
      conferenceProvider: "none",
      conferenceUrl: null,
      reminderMinutes: 0,
    };
    await transaction`
      INSERT INTO jobs (
        organization_id, type, payload, status, result, completed_at
      ) VALUES (
        ${organization!.id}, 'calendar.event.create',
        ${transaction.json({
          ...safeRescheduleBasePayload,
          startsAt: "2031-01-02T09:00:00.000Z",
          endsAt: "2031-01-02T09:30:00.000Z",
        })},
        'completed', ${transaction.json({ externalEventId: safeRescheduleEventId })},
        now() - interval '2 hours'
      )
    `;
    await transaction`
      INSERT INTO jobs (
        organization_id, type, payload, status, result, completed_at
      ) VALUES (
        ${organization!.id}, 'calendar.event.update',
        ${transaction.json({
          ...safeRescheduleBasePayload,
          startsAt: "2031-01-02T09:30:00.000Z",
          endsAt: "2031-01-02T10:00:00.000Z",
          previousStartsAt: "2031-01-02T09:00:00.000Z",
          previousEndsAt: "2031-01-02T09:30:00.000Z",
        })},
        'completed', ${transaction.json({ externalEventId: safeRescheduleEventId })},
        now() - interval '1 hour'
      )
    `;
    await transaction`
      INSERT INTO jobs (organization_id, type, payload, status)
      VALUES (
        ${organization!.id}, 'calendar.event.update',
        ${transaction.json({
          ...safeRescheduleBasePayload,
          startsAt: "2031-01-02T10:00:00.000Z",
          endsAt: "2031-01-02T10:30:00.000Z",
          previousStartsAt: "2031-01-02T09:30:00.000Z",
          previousEndsAt: "2031-01-02T10:00:00.000Z",
        })},
        'pending'
      )
    `;
    await transaction`
      INSERT INTO jobs (organization_id, type, payload, status)
      VALUES (
        ${organization!.id}, 'email.booking.confirmation',
        ${transaction.json({
          bookingId: String(safeRescheduleBooking!.id),
          to: "safe-reschedule@example.com",
          managePath: `/schedule/manage/${safeRescheduleExternalId}`,
          marker: "revoke-unsafe-manage-path",
        })},
        'pending'
      )
    `;

    const safeCancelExternalId = "f1249cbc-6eeb-4da7-a0bb-bf98ca46d2cc";
    const safeCancelEventId = "legacy-safe-cancel-event";
    const [safeCancelBooking] = await transaction`
      INSERT INTO bookings (
        organization_id, meeting_type_id, rep_id, external_id,
        manage_token_hash, status, attendee_name, attendee_email,
        starts_at, ends_at, calendar_provider, conference_provider,
        external_event_id
      ) VALUES (
        ${organization!.id}, ${meetingType!.id}, ${rep!.id},
        ${safeCancelExternalId},
        ${createHash("sha256").update(safeCancelExternalId).digest("hex")},
        'cancel_pending', 'Safe Cancel', 'safe-cancel@example.com',
        '2031-01-02T11:00:00.000Z', '2031-01-02T11:30:00.000Z',
        'google', 'none', ${safeCancelEventId}
      )
      RETURNING id
    `;
    const safeCancelPayload = {
      bookingId: String(safeCancelBooking!.id),
      externalId: safeCancelExternalId,
      externalEventId: safeCancelEventId,
      organizationSlug: legacyMigrationFixtureSlug,
      schedulingSlug: "legacy-fixture-rep",
      repId: String(rep!.id),
      repName: "Legacy Fixture Rep",
      repEmail: "legacy-fixture-rep@example.com",
      repTimezone: "UTC",
      provider: "google",
      startsAt: "2031-01-02T11:00:00.000Z",
      endsAt: "2031-01-02T11:30:00.000Z",
      subject: "Legacy safe cancel",
      description: "",
      attendeeName: "Safe Cancel",
      attendeeEmail: "safe-cancel@example.com",
      conferenceProvider: "none",
      conferenceUrl: null,
      reminderMinutes: 60,
    };
    await transaction`
      INSERT INTO jobs (
        organization_id, type, payload, status, result, completed_at
      ) VALUES (
        ${organization!.id}, 'calendar.event.create',
        ${transaction.json(safeCancelPayload)}, 'completed',
        ${transaction.json({ externalEventId: safeCancelEventId })},
        '2030-01-01T00:00:00.000Z'
      )
    `;
    await transaction`
      INSERT INTO jobs (
        organization_id, type, payload, status, created_at
      ) VALUES (
        ${organization!.id}, 'calendar.event.cancel',
        ${transaction.json(safeCancelPayload)}, 'pending',
        '2030-01-02T00:00:00.000Z'
      )
    `;
    await transaction`
      INSERT INTO jobs (
        organization_id, type, payload, status, run_at,
        created_at, completed_at
      ) VALUES (
        ${organization!.id}, 'email.booking.reminder',
        ${transaction.json({
          bookingId: String(safeCancelBooking!.id),
          to: "safe-cancel@example.com",
          marker: "preserve-exact-reminder",
          managePath: `/schedule/manage/${safeCancelExternalId}`,
        })},
        'cancelled', '2031-01-02T10:00:00.000Z',
        '2029-12-31T00:00:00.000Z', '2030-01-02T00:00:00.000Z'
      )
    `;
  });
}

async function verifyLegacyMigrationFixture(): Promise<void> {
  try {
    const rows = await testDatabase`
      SELECT j.id AS job_id, j.status AS job_status,
             j.last_error AS job_last_error, j.payload,
             b.id AS booking_id, b.external_id, b.status AS booking_status,
             b.source_external_id, b.manage_token_hash,
             b.routing_decision_id, b.attendee_name, b.attendee_email,
             b.attendee_notifications_enabled,
             b.calendar_provider, b.calendar_external_account_id,
             b.conference_provider, b.external_event_id,
             b.external_event_web_link, b.last_error,
             mt.slug AS meeting_type_slug, mt.rep_id AS meeting_type_rep_id,
             r.id AS rep_id
      FROM organizations o
      JOIN jobs j ON j.organization_id = o.id
      JOIN bookings b ON b.id::text = j.payload->>'bookingId'
      JOIN meeting_types mt ON mt.id = b.meeting_type_id
      JOIN reps r ON r.id = b.rep_id
      WHERE o.slug = ${legacyMigrationFixtureSlug}
        AND j.type = 'calendar.event.create'
      ORDER BY j.id
    `;
    if (rows.length !== 9) {
      throw new Error(
        "Legacy migration did not preserve all nine calendar-create states.",
      );
    }
    const byExternalId = new Map(
      rows.map((row) => [String(row.externalId), row]),
    );
    const pending = byExternalId.get(" legacy-dashboard-pending ");
    const processing = byExternalId.get("legacy-public-processing");
    const completed = byExternalId.get("legacy-dashboard-completed");
    const failed = byExternalId.get(legacyPublicFailedExternalId);
    const failedAbsent = byExternalId.get("legacy-public-cancelled-absent");
    const cancelledFound = byExternalId.get("legacy-public-cancelled-found");
    const cancelledPast = byExternalId.get("legacy-public-cancelled-past");
    const safeReschedule = byExternalId.get("legacy-safe-reschedule");
    const safeCancel = byExternalId.get("f1249cbc-6eeb-4da7-a0bb-bf98ca46d2cc");
    const pendingPayload = pending?.payload as
      | Record<string, unknown>
      | undefined;
    const processingPayload = processing?.payload as
      | Record<string, unknown>
      | undefined;
    const completedPayload = completed?.payload as
      | Record<string, unknown>
      | undefined;
    const failedPayload = failed?.payload as
      | Record<string, unknown>
      | undefined;
    const failedAbsentPayload = failedAbsent?.payload as
      | Record<string, unknown>
      | undefined;
    const cancelledFoundPayload = cancelledFound?.payload as
      | Record<string, unknown>
      | undefined;
    const cancelledPastPayload = cancelledPast?.payload as
      | Record<string, unknown>
      | undefined;
    if (
      pending?.jobStatus !== "cancelled" ||
      pending.bookingStatus !== "cancelled" ||
      !pending.routingDecisionId ||
      pending.attendeeEmail !== "dashboard-override@example.com" ||
      pending.attendeeNotificationsEnabled !== true ||
      pending.calendarExternalAccountId !== null ||
      pending.sourceExternalId !== " legacy-dashboard-pending " ||
      pending.manageTokenHash !== null ||
      pending.conferenceProvider !== "none" ||
      pendingPayload?.externalId !== " legacy-dashboard-pending " ||
      pendingPayload.conferenceProvider !== "none" ||
      pendingPayload.reminderMinutes !== 0 ||
      pendingPayload.attendeeNotificationsEnabled !== true ||
      pendingPayload.attendeeEmail !== "dashboard-override@example.com" ||
      pendingPayload.calendarExternalAccountId !== undefined ||
      String(pendingPayload.bookingId) !== String(pending.bookingId)
    ) {
      throw new Error(
        "Unstarted legacy dashboard work was not withdrawn without account inference.",
      );
    }
    const [peerDashboardKey] = await testDatabase`
      SELECT b.status AS booking_status, b.external_id,
             b.source_external_id, b.manage_token_hash,
             create_job.status AS job_status
      FROM organizations o
      JOIN bookings b ON b.organization_id = o.id
      JOIN jobs create_job
        ON create_job.organization_id = b.organization_id
       AND create_job.type = 'calendar.event.create'
       AND create_job.payload->>'bookingId' = b.id::text
      WHERE o.slug = ${`${legacyMigrationFixtureSlug}-peer`}
        AND b.source_external_id = ' legacy-dashboard-pending '
    `;
    if (
      peerDashboardKey?.bookingStatus !== "cancelled" ||
      peerDashboardKey.jobStatus !== "cancelled" ||
      peerDashboardKey.externalId !== " legacy-dashboard-pending " ||
      peerDashboardKey.sourceExternalId !== " legacy-dashboard-pending " ||
      peerDashboardKey.manageTokenHash !== null
    ) {
      throw new Error(
        "The same arbitrary dashboard idempotency key did not migrate independently across organizations.",
      );
    }
    if (
      processing?.jobStatus !== "cancelled" ||
      processing.bookingStatus !== "cancelled" ||
      processing.calendarExternalAccountId !== null ||
      processing.routingDecisionId !== null ||
      processing.attendeeName !== "Public Processing" ||
      processing.attendeeEmail !== "public-processing@example.com" ||
      processing.attendeeNotificationsEnabled !== true ||
      processing.meetingTypeSlug !== "legacy-fixture-rep" ||
      String(processing.meetingTypeRepId) !== String(processing.repId) ||
      processingPayload?.description !== "Original public description." ||
      processingPayload.conferenceProvider !== "none" ||
      processingPayload.reminderMinutes !== 0 ||
      processingPayload.attendeeNotificationsEnabled !== true ||
      processingPayload.attendeeEmail !== "public-processing@example.com" ||
      processingPayload.calendarExternalAccountId !== undefined
    ) {
      throw new Error(
        "Unstarted legacy public create was not withdrawn safely.",
      );
    }
    if (
      completed?.jobStatus !== "completed" ||
      completed.bookingStatus !== "confirmed" ||
      !completed.routingDecisionId ||
      completed.attendeeEmail !== "completed-lead@example.com" ||
      completed.attendeeNotificationsEnabled !== false ||
      completedPayload?.attendeeNotificationsEnabled !== false ||
      completedPayload.attendeeEmail !== null ||
      completed.calendarExternalAccountId !== null ||
      completed.sourceExternalId !== "legacy-dashboard-completed" ||
      completed.manageTokenHash !== null ||
      completed.externalEventId !== "legacy-provider-event" ||
      completed.externalEventWebLink !==
        "https://calendar.example.com/legacy-provider-event"
    ) {
      throw new Error("Completed legacy provider evidence was not preserved.");
    }
    if (
      failed?.jobStatus !== "failed" ||
      failed.bookingStatus !== "failed" ||
      failed.routingDecisionId !== null ||
      failed.attendeeNotificationsEnabled !== true ||
      failedPayload?.attendeeNotificationsEnabled !== true ||
      failedPayload.attendeeEmail !== "public-failed@example.com" ||
      failed.calendarExternalAccountId !== null ||
      failed.sourceExternalId !== null ||
      failed.manageTokenHash !==
        createHash("sha256")
          .update(legacyPublicFailedExternalId)
          .digest("hex") ||
      !String(failed.lastError).includes(
        "Calendar account identity is unproven",
      ) ||
      failed.jobLastError !== "legacy provider failure"
    ) {
      throw new Error("Failed legacy booking lifecycle was not preserved.");
    }
    if (
      failedAbsent?.jobStatus !== "failed" ||
      failedAbsent.bookingStatus !== "failed" ||
      failedAbsent.routingDecisionId !== null ||
      failedAbsent.attendeeNotificationsEnabled !== true ||
      failedAbsentPayload?.attendeeNotificationsEnabled !== true ||
      failedAbsentPayload.attendeeEmail !==
        "public-cancelled-absent@example.com" ||
      failedAbsent.calendarExternalAccountId !== null ||
      !String(failedAbsent.lastError).includes(
        "Calendar account identity is unproven",
      ) ||
      failedAbsent.jobLastError !== "legacy cancelled before provider outcome"
    ) {
      throw new Error(
        "Failed legacy booking absence reconciliation was not initialized safely.",
      );
    }
    if (
      cancelledFound?.jobStatus !== "failed" ||
      cancelledFound.bookingStatus !== "failed" ||
      cancelledFound.routingDecisionId !== null ||
      cancelledFound.attendeeNotificationsEnabled !== true ||
      cancelledFoundPayload?.attendeeNotificationsEnabled !== true ||
      cancelledFoundPayload.attendeeEmail !==
        "public-cancelled-found@example.com" ||
      cancelledFound.calendarExternalAccountId !== null ||
      !String(cancelledFound.lastError).includes(
        "Calendar account identity is unproven",
      ) ||
      cancelledFound.jobLastError !== "legacy cancelled before provider outcome"
    ) {
      throw new Error(
        "Legacy cancelled create was not normalized into safe reconciliation.",
      );
    }
    if (
      cancelledPast?.jobStatus !== "failed" ||
      cancelledPast.bookingStatus !== "failed" ||
      cancelledPastPayload?.attendeeNotificationsEnabled !== true ||
      cancelledPastPayload.attendeeEmail !==
        "public-cancelled-past@example.com" ||
      cancelledPast.calendarExternalAccountId !== null ||
      !String(cancelledPast.lastError).includes(
        "Calendar account identity is unproven",
      ) ||
      cancelledPast.jobLastError !== "legacy cancelled before provider outcome"
    ) {
      throw new Error(
        "Historical cancelled create was not initialized for reconciliation.",
      );
    }
    if (
      safeReschedule?.jobStatus !== "completed" ||
      safeReschedule.bookingStatus !== "confirmed" ||
      safeReschedule.calendarExternalAccountId !== null ||
      safeReschedule.externalEventId !== "legacy-safe-reschedule-event"
    ) {
      throw new Error(
        "An unstarted legacy reschedule was not rolled back without inferring its calendar account.",
      );
    }

    const [safeRescheduleLifecycle] = await testDatabase`
      SELECT b.starts_at, b.ends_at, b.previous_starts_at, b.previous_ends_at,
             b.last_error,
        count(update_job.id) FILTER (
          WHERE update_job.status = 'completed'
        )::integer AS completed_updates,
        count(update_job.id) FILTER (
          WHERE update_job.status = 'cancelled'
        )::integer AS cancelled_updates,
        max(update_job.last_error) FILTER (
          WHERE update_job.status = 'cancelled'
        ) AS cancelled_update_error,
        (SELECT count(*)::integer FROM jobs reminder
         WHERE reminder.type = 'email.booking.reminder'
           AND reminder.payload->>'bookingId' = b.id::text
           AND reminder.status IN ('pending', 'processing')) AS active_reminders,
        (SELECT min(reminder.run_at) FROM jobs reminder
         WHERE reminder.type = 'email.booking.reminder'
           AND reminder.payload->>'bookingId' = b.id::text
           AND reminder.status IN ('pending', 'processing')) AS reminder_run_at,
        (SELECT message.payload->>'managePath' FROM jobs message
         WHERE message.type = 'email.booking.confirmation'
           AND message.payload->>'bookingId' = b.id::text
           AND message.payload->>'marker' = 'revoke-unsafe-manage-path'
         LIMIT 1) AS queued_manage_path,
        (SELECT count(*)::integer FROM jobs message
         WHERE message.type = 'email.booking.confirmation'
           AND message.payload->>'bookingId' = b.id::text
           AND message.payload->>'marker' = 'revoke-unsafe-manage-path'
           AND message.status = 'pending') AS queued_messages
      FROM bookings b
      JOIN jobs update_job
        ON update_job.type = 'calendar.event.update'
       AND update_job.payload->>'bookingId' = b.id::text
      WHERE b.id = ${String(safeReschedule!.bookingId)}
      GROUP BY b.id
    `;
    if (
      new Date(String(safeRescheduleLifecycle?.startsAt)).getTime() !==
        new Date("2031-01-02T09:30:00.000Z").getTime() ||
      new Date(String(safeRescheduleLifecycle?.endsAt)).getTime() !==
        new Date("2031-01-02T10:00:00.000Z").getTime() ||
      safeRescheduleLifecycle?.previousStartsAt !== null ||
      safeRescheduleLifecycle.previousEndsAt !== null ||
      Number(safeRescheduleLifecycle.completedUpdates) !== 1 ||
      Number(safeRescheduleLifecycle.cancelledUpdates) !== 1 ||
      Number(safeRescheduleLifecycle.activeReminders) !== 0 ||
      safeRescheduleLifecycle.reminderRunAt !== null ||
      Number(safeRescheduleLifecycle.queuedMessages) !== 1 ||
      safeRescheduleLifecycle.queuedManagePath !== null ||
      !String(safeRescheduleLifecycle.lastError).includes(
        "Calendar account identity is unproven",
      ) ||
      !String(safeRescheduleLifecycle.cancelledUpdateError).includes(
        "withdrawn without contacting the provider",
      )
    ) {
      throw new Error(
        "Migration 024 did not ignore the historical completed update and safely withdraw only the current pending update.",
      );
    }

    const [safeCancelLifecycle] = await testDatabase`
      SELECT b.status, b.last_error,
             cancel_job.status AS cancel_status,
             reminder.status AS reminder_status,
             reminder.run_at AS reminder_run_at,
             reminder.payload AS reminder_payload,
             reminder.completed_at AS reminder_completed_at
      FROM bookings b
      JOIN jobs cancel_job
        ON cancel_job.type = 'calendar.event.cancel'
       AND cancel_job.payload->>'bookingId' = b.id::text
      JOIN jobs reminder
        ON reminder.type = 'email.booking.reminder'
       AND reminder.payload->>'bookingId' = b.id::text
      WHERE b.id = ${String(safeCancel!.bookingId)}
    `;
    const safeCancelReminderPayload = safeCancelLifecycle?.reminderPayload as
      | Record<string, unknown>
      | undefined;
    if (
      safeCancel?.bookingStatus !== "confirmed" ||
      safeCancelLifecycle?.status !== "confirmed" ||
      safeCancel?.manageTokenHash !==
        createHash("sha256")
          .update("f1249cbc-6eeb-4da7-a0bb-bf98ca46d2cc")
          .digest("hex") ||
      safeCancelLifecycle.cancelStatus !== "cancelled" ||
      safeCancelLifecycle.reminderStatus !== "pending" ||
      safeCancelLifecycle.reminderCompletedAt !== null ||
      new Date(String(safeCancelLifecycle.reminderRunAt)).getTime() !==
        new Date("2031-01-02T10:00:00.000Z").getTime() ||
      safeCancelReminderPayload?.marker !== "preserve-exact-reminder" ||
      safeCancelReminderPayload.managePath !==
        "/schedule/manage/f1249cbc-6eeb-4da7-a0bb-bf98ca46d2cc" ||
      !String(safeCancelLifecycle.lastError).includes(
        "Calendar account identity is unproven",
      )
    ) {
      throw new Error(
        "Migration 024 did not restore only the exact reminder cancelled by the withdrawn lifecycle request.",
      );
    }

    const failedReconciliations = await testDatabase`
      SELECT id, status, payload, last_error
      FROM jobs
      WHERE type = 'calendar.event.create.reconcile'
        AND payload->>'bookingId' = ${String(failed!.bookingId)}
      ORDER BY id
    `;
    const failedReconciliationPayload = failedReconciliations[0]?.payload as
      | Record<string, unknown>
      | undefined;
    if (
      failedReconciliations.length !== 1 ||
      failedReconciliations[0]?.status !== "failed" ||
      !String(failedReconciliations[0]?.lastError).includes(
        "Calendar account identity is unproven",
      ) ||
      failedReconciliationPayload?.calendarExternalAccountId !== undefined ||
      failedReconciliationPayload?.reconciliationIntent !== "resolve" ||
      Number(failedReconciliationPayload.reconciliationForJobId) !==
        Number(failed.jobId) ||
      failedReconciliationPayload.organizationSlug !==
        legacyMigrationFixtureSlug ||
      failedReconciliationPayload.externalId !== legacyPublicFailedExternalId ||
      String(failedReconciliationPayload.repId) !== String(failed.repId) ||
      failedReconciliationPayload.provider !== "google" ||
      new Date(String(failedReconciliationPayload.startsAt)).getTime() !==
        new Date("2031-01-01T13:00:00.000Z").getTime() ||
      new Date(String(failedReconciliationPayload.endsAt)).getTime() !==
        new Date("2031-01-01T13:30:00.000Z").getTime()
    ) {
      throw new Error(
        "Unbound legacy reconciliation was not stopped for explicit provider proof.",
      );
    }

    const absentReconciliations = await testDatabase`
      SELECT id, status, payload, last_error
      FROM jobs
      WHERE type = 'calendar.event.create.reconcile'
        AND payload->>'bookingId' = ${String(failedAbsent!.bookingId)}
      ORDER BY id
    `;
    const absentReconciliationPayload = absentReconciliations[0]?.payload as
      | Record<string, unknown>
      | undefined;
    if (
      absentReconciliations.length !== 1 ||
      absentReconciliations[0]?.status !== "failed" ||
      !String(absentReconciliations[0]?.lastError).includes(
        "Calendar account identity is unproven",
      ) ||
      absentReconciliationPayload?.calendarExternalAccountId !== undefined ||
      absentReconciliationPayload?.reconciliationIntent !== "resolve" ||
      Number(absentReconciliationPayload.reconciliationForJobId) !==
        Number(failedAbsent.jobId) ||
      absentReconciliationPayload.organizationSlug !==
        legacyMigrationFixtureSlug ||
      absentReconciliationPayload.externalId !==
        "legacy-public-cancelled-absent"
    ) {
      throw new Error(
        "Unbound absence reconciliation was not stopped before a provider lookup.",
      );
    }

    const cancelledFoundReconciliations = await testDatabase`
      SELECT id, status, payload, last_error
      FROM jobs
      WHERE type = 'calendar.event.create.reconcile'
        AND payload->>'bookingId' = ${String(cancelledFound!.bookingId)}
      ORDER BY id
    `;
    const cancelledFoundReconciliationPayload = cancelledFoundReconciliations[0]
      ?.payload as Record<string, unknown> | undefined;
    if (
      cancelledFoundReconciliations.length !== 1 ||
      cancelledFoundReconciliations[0]?.status !== "failed" ||
      !String(cancelledFoundReconciliations[0]?.lastError).includes(
        "Calendar account identity is unproven",
      ) ||
      cancelledFoundReconciliationPayload?.calendarExternalAccountId !==
        undefined ||
      cancelledFoundReconciliationPayload?.reconciliationIntent !== "resolve" ||
      Number(cancelledFoundReconciliationPayload.reconciliationForJobId) !==
        Number(cancelledFound.jobId) ||
      cancelledFoundReconciliationPayload.externalId !==
        "legacy-public-cancelled-found"
    ) {
      throw new Error(
        "Unbound cancelled-create reconciliation was not stopped safely.",
      );
    }

    const cancelledPastReconciliations = await testDatabase`
      SELECT id, status, payload, last_error
      FROM jobs
      WHERE type = 'calendar.event.create.reconcile'
        AND payload->>'bookingId' = ${String(cancelledPast!.bookingId)}
      ORDER BY id
    `;
    if (
      cancelledPastReconciliations.length !== 1 ||
      cancelledPastReconciliations[0]?.status !== "failed" ||
      !String(cancelledPastReconciliations[0]?.lastError).includes(
        "Calendar account identity is unproven",
      ) ||
      (cancelledPastReconciliations[0]?.payload as Record<string, unknown>)
        .reconciliationIntent !== "resolve"
    ) {
      throw new Error(
        "Historical unbound reconciliation was not stopped safely.",
      );
    }

    const failedRepairContext =
      await repository.legacyBookingCalendarAccountRepairContext(
        legacyPublicFailedExternalId,
      );
    if (
      failedRepairContext?.status !== "failed" ||
      failedRepairContext.currentCalendarExternalAccountId !==
        "legacy-fixture-calendar" ||
      failedRepairContext.externalEventId !== null ||
      failedRepairContext.transactionId !== legacyPublicFailedExternalId
    ) {
      throw new Error(
        "A stopped uncertain create did not expose provider lookup repair context.",
      );
    }
    const failedProofBound = await repository.bindLegacyBookingCalendarAccount(
      legacyPublicFailedExternalId,
      {
        calendarExternalAccountId: "legacy-fixture-calendar",
        externalEventId: "legacy-reconciled-provider-event",
        startsAt: new Date("2031-01-01T13:00:00.000Z"),
        endsAt: new Date("2031-01-01T13:30:00.000Z"),
      },
    );
    const [failedRepairEvidence] = await testDatabase`
      SELECT b.status, b.calendar_external_account_id, b.external_event_id,
             reconciliation.status AS reconciliation_status,
             reconciliation.payload->>'calendarExternalAccountId' AS job_account_id
      FROM bookings b
      JOIN jobs reconciliation
        ON reconciliation.type = 'calendar.event.create.reconcile'
       AND reconciliation.payload->>'bookingId' = b.id::text
      WHERE b.id = ${String(failed!.bookingId)}
    `;
    if (
      !failedProofBound ||
      failedRepairEvidence?.status !== "pending" ||
      failedRepairEvidence.calendarExternalAccountId !==
        "legacy-fixture-calendar" ||
      failedRepairEvidence.externalEventId !==
        "legacy-reconciled-provider-event" ||
      failedRepairEvidence.reconciliationStatus !== "pending" ||
      failedRepairEvidence.jobAccountId !== "legacy-fixture-calendar"
    ) {
      throw new Error(
        "Positive event proof did not atomically bind and resume the stopped reconciliation.",
      );
    }

    // Simulate a separate positive provider-account audit for the remaining
    // fixtures. Migration 024 must never infer this identity.
    const providerAuditedBookingIds = [
      String(failedAbsent!.bookingId),
      String(cancelledFound!.bookingId),
      String(cancelledPast!.bookingId),
    ];
    await testDatabase.begin(async (transaction) => {
      await transaction`
        UPDATE bookings
        SET calendar_external_account_id = 'legacy-fixture-calendar',
            status = 'pending', last_error = NULL,
            updated_at = now()
        WHERE id = ANY(${providerAuditedBookingIds}::uuid[])
          AND calendar_external_account_id IS NULL
      `;
      await transaction`
        UPDATE jobs
        SET payload = jsonb_set(
          payload,
          '{calendarExternalAccountId}',
          to_jsonb('legacy-fixture-calendar'::text),
          true
        )
        WHERE payload->>'bookingId' = ANY(${providerAuditedBookingIds}::text[])
          AND type IN (
            'calendar.event.create', 'calendar.event.create.reconcile'
          )
      `;
    });

    const foundReconciliationId = Number(failedReconciliations[0]!.id);
    const foundReconciliationClaim = await claimJobForIntegration(
      foundReconciliationId,
    );
    const foundCompleted = await repository.completeJob(
      foundReconciliationId,
      foundReconciliationClaim,
      {
        found: true,
        externalEventId: "legacy-reconciled-provider-event",
        webLink:
          "https://calendar.example.com/legacy-reconciled-provider-event",
        conferenceUrl: "https://meet.google.com/legacy-reconciled-room",
      },
    );
    const [foundEvidence] = await testDatabase`
      SELECT b.status AS booking_status, b.external_event_id,
             b.external_event_web_link, b.conference_url,
             create_job.status AS create_job_status,
             reconcile_job.status AS reconciliation_status,
        (SELECT count(*)::integer FROM jobs message_job
         WHERE message_job.type = 'email.booking.confirmation'
           AND message_job.payload->>'bookingId' = b.id::text) AS confirmations,
        (SELECT message_job.payload->>'managePath' FROM jobs message_job
         WHERE message_job.type = 'email.booking.confirmation'
           AND message_job.payload->>'bookingId' = b.id::text
         ORDER BY message_job.id DESC LIMIT 1) AS confirmation_manage_path
      FROM bookings b
      JOIN jobs create_job ON create_job.id = ${Number(failed.jobId)}
      JOIN jobs reconcile_job ON reconcile_job.id = ${foundReconciliationId}
      WHERE b.id = ${String(failed.bookingId)}
    `;
    if (
      !foundCompleted ||
      foundEvidence?.bookingStatus !== "confirmed" ||
      foundEvidence.externalEventId !== "legacy-reconciled-provider-event" ||
      foundEvidence.externalEventWebLink !==
        "https://calendar.example.com/legacy-reconciled-provider-event" ||
      foundEvidence.conferenceUrl !==
        "https://meet.google.com/legacy-reconciled-room" ||
      foundEvidence.createJobStatus !== "completed" ||
      foundEvidence.reconciliationStatus !== "completed" ||
      Number(foundEvidence.confirmations) !== 1
    ) {
      throw new Error(
        "Migrated failed booking did not reconcile found provider evidence into one confirmed lifecycle.",
      );
    }

    const cancelledFoundReconciliationId = Number(
      cancelledFoundReconciliations[0]!.id,
    );
    const cancelledFoundClaim = await claimJobForIntegration(
      cancelledFoundReconciliationId,
    );
    const cancelledFoundCompleted = await repository.completeJob(
      cancelledFoundReconciliationId,
      cancelledFoundClaim,
      {
        found: true,
        externalEventId: "legacy-cancelled-provider-event",
        webLink: "https://calendar.example.com/legacy-cancelled-provider-event",
        conferenceUrl: null,
      },
    );
    const [cancelledFoundEvidence] = await testDatabase`
      SELECT b.status AS booking_status, b.external_event_id,
             create_job.status AS create_job_status,
             reconcile_job.status AS reconciliation_status,
        (SELECT count(*)::integer FROM jobs message_job
         WHERE message_job.type = 'email.booking.confirmation'
           AND message_job.payload->>'bookingId' = b.id::text) AS confirmations,
        (SELECT message_job.payload->>'managePath' FROM jobs message_job
         WHERE message_job.type = 'email.booking.confirmation'
           AND message_job.payload->>'bookingId' = b.id::text
         LIMIT 1) AS confirmation_manage_path
      FROM bookings b
      JOIN jobs create_job ON create_job.id = ${Number(cancelledFound.jobId)}
      JOIN jobs reconcile_job
        ON reconcile_job.id = ${cancelledFoundReconciliationId}
      WHERE b.id = ${String(cancelledFound.bookingId)}
    `;
    if (
      !cancelledFoundCompleted ||
      cancelledFoundEvidence?.bookingStatus !== "confirmed" ||
      cancelledFoundEvidence.externalEventId !==
        "legacy-cancelled-provider-event" ||
      cancelledFoundEvidence.createJobStatus !== "completed" ||
      cancelledFoundEvidence.reconciliationStatus !== "completed" ||
      Number(cancelledFoundEvidence.confirmations) !== 1 ||
      cancelledFoundEvidence.confirmationManagePath !== null
    ) {
      throw new Error(
        "Legacy cancelled create did not reconcile found provider evidence.",
      );
    }

    const cancelledPastReconciliationId = Number(
      cancelledPastReconciliations[0]!.id,
    );
    const cancelledPastClaim = await claimJobForIntegration(
      cancelledPastReconciliationId,
    );
    const cancelledPastCompleted = await repository.completeJob(
      cancelledPastReconciliationId,
      cancelledPastClaim,
      {
        found: true,
        externalEventId: "legacy-cancelled-past-provider-event",
        webLink:
          "https://calendar.example.com/legacy-cancelled-past-provider-event",
        conferenceUrl: null,
      },
    );
    const [cancelledPastEvidence] = await testDatabase`
      SELECT b.status AS booking_status, b.external_event_id,
             create_job.status AS create_job_status,
             reconcile_job.status AS reconciliation_status,
        (SELECT count(*)::integer FROM jobs message_job
         WHERE message_job.type IN (
           'email.booking.confirmation', 'email.booking.reminder'
         ) AND message_job.payload->>'bookingId' = b.id::text) AS notifications
      FROM bookings b
      JOIN jobs create_job ON create_job.id = ${Number(cancelledPast.jobId)}
      JOIN jobs reconcile_job
        ON reconcile_job.id = ${cancelledPastReconciliationId}
      WHERE b.id = ${String(cancelledPast.bookingId)}
    `;
    if (
      !cancelledPastCompleted ||
      cancelledPastEvidence?.bookingStatus !== "confirmed" ||
      cancelledPastEvidence.externalEventId !==
        "legacy-cancelled-past-provider-event" ||
      cancelledPastEvidence.createJobStatus !== "completed" ||
      cancelledPastEvidence.reconciliationStatus !== "completed" ||
      Number(cancelledPastEvidence.notifications) !== 0
    ) {
      throw new Error(
        "Historical provider reconciliation queued a stale attendee notification.",
      );
    }

    const absentReconciliationId = Number(absentReconciliations[0]!.id);
    const firstAbsenceClaim = await claimJobForIntegration(
      absentReconciliationId,
    );
    await repository.completeJob(absentReconciliationId, firstAbsenceClaim, {
      found: false,
    });
    const [firstAbsence] = await testDatabase`
      SELECT b.status AS booking_status, reconcile_job.status,
             reconcile_job.result
      FROM bookings b
      JOIN jobs reconcile_job ON reconcile_job.id = ${absentReconciliationId}
      WHERE b.id = ${String(failedAbsent.bookingId)}
    `;
    if (
      firstAbsence?.bookingStatus !== "pending" ||
      firstAbsence.status !== "pending" ||
      Number(
        (firstAbsence.result as { negativeChecks?: number } | null)
          ?.negativeChecks,
      ) !== 1
    ) {
      throw new Error(
        "One negative provider check released a migrated failed booking.",
      );
    }
    await testDatabase`
      UPDATE jobs
      SET created_at = now() - interval '3 minutes', run_at = now(),
          result = jsonb_build_object(
            'negativeChecks', 1,
            'lastCheckedAt', now() - interval '1 minute'
          )
      WHERE id = ${absentReconciliationId}
    `;
    const secondAbsenceClaim = await claimJobForIntegration(
      absentReconciliationId,
    );
    await repository.completeJob(absentReconciliationId, secondAbsenceClaim, {
      found: false,
    });
    const [absenceReleased] = await testDatabase`
      SELECT b.status AS booking_status, b.cancelled_at,
             create_job.status AS create_job_status,
             create_job.result AS create_job_result,
             reconcile_job.status AS reconciliation_status,
        (SELECT count(*)::integer FROM jobs message_job
         WHERE message_job.type IN (
           'email.booking.confirmation', 'email.booking.cancelled'
         ) AND message_job.payload->>'bookingId' = b.id::text) AS messages
      FROM bookings b
      JOIN jobs create_job ON create_job.id = ${Number(failedAbsent.jobId)}
      JOIN jobs reconcile_job ON reconcile_job.id = ${absentReconciliationId}
      WHERE b.id = ${String(failedAbsent.bookingId)}
    `;
    if (
      absenceReleased?.bookingStatus !== "cancelled" ||
      !absenceReleased.cancelledAt ||
      absenceReleased.createJobStatus !== "failed" ||
      (
        absenceReleased.createJobResult as {
          reconciledAbsent?: boolean;
        } | null
      )?.reconciledAbsent !== true ||
      absenceReleased.reconciliationStatus !== "completed" ||
      Number(absenceReleased.messages) !== 0
    ) {
      throw new Error(
        "Two separated negative checks did not safely close the migrated failed booking.",
      );
    }

    const idempotent = await repository.enqueueCalendarBooking({
      organizationSlug: legacyMigrationFixtureSlug,
      externalId: " legacy-dashboard-pending ",
      decisionId: String(pending!.routingDecisionId),
      startsAt: new Date("2031-01-01T10:00:00.000Z"),
      endsAt: new Date("2031-01-01T10:30:00.000Z"),
      subject: "Legacy dashboard pending",
      provider: "google",
      calendarQuote: {
        repId: String(pending!.repId),
        calendarProvider: "google",
        calendarExternalAccountId: "legacy-fixture-calendar",
        conflictCalendars: [
          {
            provider: "google",
            calendarExternalAccountId: "legacy-fixture-calendar",
            calendarId: "primary",
          },
        ],
      },
    });
    if (
      idempotent.id !== Number(pending!.jobId) ||
      String(idempotent.status) !== "cancelled"
    ) {
      throw new Error("Withdrawn dashboard booking was not idempotent.");
    }

    let overlapCode: string | undefined;
    try {
      await testDatabase`
        INSERT INTO bookings (
          organization_id, meeting_type_id, rep_id, external_id,
          manage_token_hash, attendee_name, attendee_email, starts_at, ends_at,
          calendar_provider, conference_provider
        )
        SELECT b.organization_id, b.meeting_type_id, b.rep_id,
               'legacy-overlap-probe',
               ${createHash("sha256").update("legacy-overlap-probe").digest("hex")},
               'Overlap Probe', 'overlap-probe@example.com',
               '2031-01-01T10:15:00.000Z', '2031-01-01T10:45:00.000Z',
               b.calendar_provider, 'none'
        FROM bookings b
        WHERE b.id = ${pending!.bookingId}
      `;
    } catch (error) {
      overlapCode = (error as { code?: string }).code;
    }
    if (overlapCode !== undefined) {
      throw new Error(
        "A safely withdrawn unstarted legacy booking did not release its range.",
      );
    }

    const [indexEvidence] = await testDatabase`
      SELECT to_regclass('public.jobs_calendar_rep_slot_idx') AS legacy_index
    `;
    if (indexEvidence?.legacyIndex !== null) {
      throw new Error("Legacy job slot index was not dropped after backfill.");
    }
  } finally {
    await testDatabase`
      DELETE FROM organizations
      WHERE slug = ANY(${[
        legacyMigrationFixtureSlug,
        `${legacyMigrationFixtureSlug}-peer`,
      ]})
    `;
  }
}

async function verifyMalformedLegacyMigrationFixture(): Promise<void> {
  try {
    const [evidence] = await testDatabase`
      SELECT
        to_regclass('public.jobs_calendar_rep_slot_idx') AS legacy_index,
        EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE name = '016_legacy_calendar_booking_backfill.sql'
        ) AS migration_applied,
        (SELECT count(*)::int
         FROM bookings b
         JOIN organizations o ON o.id = b.organization_id
         WHERE o.slug = ${legacyMigrationFixtureSlug}) AS bookings,
        (SELECT count(*)::int
         FROM jobs j
         JOIN organizations o ON o.id = j.organization_id
         WHERE o.slug = ${legacyMigrationFixtureSlug}
           AND j.payload ? 'bookingId') AS linked_jobs
    `;
    if (
      !evidence?.legacyIndex ||
      evidence.migrationApplied ||
      Number(evidence.bookings) !== 0 ||
      Number(evidence.linkedJobs) !== 0
    ) {
      throw new Error(
        "Malformed legacy migration did not roll back with its index intact.",
      );
    }
  } finally {
    await testDatabase`
      DELETE FROM organizations WHERE slug = ${legacyMigrationFixtureSlug}
    `;
  }
}

async function verifyLinkedMismatchMigrationFixture(): Promise<void> {
  try {
    const [evidence] = await testDatabase`
      SELECT
        to_regclass('public.jobs_calendar_rep_slot_idx') AS legacy_index,
        EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE name = '016_legacy_calendar_booking_backfill.sql'
        ) AS migration_applied,
        b.external_event_id,
        j.result->>'externalEventId' AS job_external_event_id,
        j.payload->>'bookingId' AS job_booking_id,
        b.id AS booking_id
      FROM organizations o
      JOIN bookings b ON b.organization_id = o.id
      JOIN jobs j
        ON j.organization_id = o.id
       AND j.type = 'calendar.event.create'
       AND j.payload->>'bookingId' = b.id::text
      WHERE o.slug = ${legacyMigrationFixtureSlug}
        AND b.external_id = 'legacy-linked-provider-mismatch'
    `;
    if (
      !evidence?.legacyIndex ||
      evidence.migrationApplied ||
      evidence.externalEventId !== "booking-provider-event" ||
      evidence.jobExternalEventId !== "job-provider-event" ||
      String(evidence.jobBookingId) !== String(evidence.bookingId)
    ) {
      throw new Error(
        "Linked provider-ID mismatch did not roll back with evidence and index intact.",
      );
    }
  } finally {
    await testDatabase`
      DELETE FROM organizations WHERE slug = ${legacyMigrationFixtureSlug}
    `;
  }
}

async function verifyMalformedLifecycleMigrationFixture(
  lifecycle: "reschedule" | "cancel",
): Promise<void> {
  try {
    const externalId = `legacy-malformed-${lifecycle}`;
    const jobType = `calendar.event.${lifecycle === "reschedule" ? "update" : "cancel"}`;
    const [evidence] = await testDatabase`
      SELECT
        to_regclass('public.jobs_calendar_rep_slot_idx') AS legacy_index,
        EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE name = '014_durable_booking_ledger.sql'
        ) AS durable_migration_applied,
        EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE name = '015_reschedule_range_reservations.sql'
        ) AS reschedule_migration_applied,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'bookings'
            AND column_name = 'previous_starts_at'
        ) AS previous_column_exists,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'bookings_rep_active_time_excl'
            AND conrelid = 'bookings'::regclass
        ) AS durable_constraint_exists,
        b.status AS booking_status, b.external_event_id,
        j.status AS job_status, j.payload->>'externalEventId' AS job_event_id
      FROM organizations o
      JOIN bookings b ON b.organization_id = o.id
      JOIN jobs j ON j.organization_id = o.id
        AND j.type = ${jobType}
        AND j.payload->>'bookingId' = b.id::text
      WHERE o.slug = ${legacyMigrationFixtureSlug}
        AND b.external_id = ${externalId}
    `;
    if (
      !evidence?.legacyIndex ||
      !evidence.durableMigrationApplied ||
      evidence.rescheduleMigrationApplied ||
      evidence.previousColumnExists ||
      !evidence.durableConstraintExists ||
      evidence.bookingStatus !==
        (lifecycle === "reschedule"
          ? "reschedule_pending"
          : "cancel_pending") ||
      evidence.externalEventId !== "expected-provider-event" ||
      evidence.jobStatus !== "pending" ||
      evidence.jobEventId !== "wrong-provider-event"
    ) {
      throw new Error(
        `Malformed pending ${lifecycle} did not roll back migration 015 intact.`,
      );
    }
  } finally {
    await testDatabase`
      DELETE FROM organizations WHERE slug = ${legacyMigrationFixtureSlug}
    `;
  }
}

async function verifyUncertainCreateMigrationFixture(): Promise<void> {
  try {
    const [evidence] = await testDatabase`
      SELECT
        EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE name = '023_failed_reconciliation_state_repair.sql'
        ) AS prior_migrations_applied,
        EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE name = '024_booking_calendar_account_identity.sql'
        ) AS account_migration_applied,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'bookings'
            AND column_name = 'calendar_external_account_id'
        ) AS account_column_exists,
        b.status AS booking_status, j.status AS job_status, j.attempts,
        j.payload->>'bookingId' AS job_booking_id, b.id AS booking_id
      FROM organizations o
      JOIN bookings b ON b.organization_id = o.id
      JOIN jobs j ON j.organization_id = o.id
        AND j.type = 'calendar.event.create'
        AND j.payload->>'bookingId' = b.id::text
      WHERE o.slug = ${legacyMigrationFixtureSlug}
        AND b.external_id = 'legacy-uncertain-create'
    `;
    if (
      !evidence?.priorMigrationsApplied ||
      evidence.accountMigrationApplied ||
      evidence.accountColumnExists ||
      evidence.bookingStatus !== "pending" ||
      evidence.jobStatus !== "processing" ||
      Number(evidence.attempts) !== 1 ||
      String(evidence.jobBookingId) !== String(evidence.bookingId)
    ) {
      throw new Error(
        "An already-attempted calendar create did not roll migration 024 back intact.",
      );
    }
  } finally {
    await testDatabase`
      DELETE FROM organizations WHERE slug = ${legacyMigrationFixtureSlug}
    `;
  }
}

async function verifyProcessingReconciliationMigrationFixture(): Promise<void> {
  try {
    const [evidence] = await testDatabase`
      SELECT
        EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE name = '023_failed_reconciliation_state_repair.sql'
        ) AS prior_migrations_applied,
        EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE name = '024_booking_calendar_account_identity.sql'
        ) AS account_migration_applied,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'bookings'
            AND column_name = 'calendar_external_account_id'
        ) AS account_column_exists,
        b.status AS booking_status, reconciliation.status,
        reconciliation.attempts, reconciliation.claim_token,
        reconciliation.payload->>'bookingId' AS job_booking_id,
        b.id AS booking_id
      FROM organizations o
      JOIN bookings b ON b.organization_id = o.id
      JOIN jobs reconciliation ON reconciliation.organization_id = o.id
        AND reconciliation.type = 'calendar.event.create.reconcile'
        AND reconciliation.payload->>'bookingId' = b.id::text
      WHERE o.slug = ${legacyMigrationFixtureSlug}
        AND b.external_id = '5c8e996c-301a-45e2-aa58-88dbfd8957bd'
    `;
    if (
      !evidence?.priorMigrationsApplied ||
      evidence.accountMigrationApplied ||
      evidence.accountColumnExists ||
      evidence.bookingStatus !== "pending" ||
      evidence.status !== "processing" ||
      Number(evidence.attempts) !== 1 ||
      !evidence.claimToken ||
      String(evidence.jobBookingId) !== String(evidence.bookingId)
    ) {
      throw new Error(
        "An in-flight provider reconciliation did not roll migration 024 back intact.",
      );
    }
  } finally {
    await testDatabase`
      DELETE FROM organizations WHERE slug = ${legacyMigrationFixtureSlug}
    `;
  }
}

async function verifyDuplicateAccountMigrationFixture(): Promise<void> {
  try {
    const [evidence] = await testDatabase`
      SELECT
        EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE name = '023_failed_reconciliation_state_repair.sql'
        ) AS prior_migrations_applied,
        EXISTS (
          SELECT 1 FROM schema_migrations
          WHERE name = '024_booking_calendar_account_identity.sql'
        ) AS account_migration_applied,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'bookings'
            AND column_name = 'calendar_external_account_id'
        ) AS account_column_exists,
        count(*)::integer AS duplicate_connections
      FROM rep_calendar_connections connection
      JOIN reps rep ON rep.id = connection.rep_id
      JOIN organizations organization ON organization.id = rep.organization_id
      WHERE organization.slug = ${legacyMigrationFixtureSlug}
        AND connection.provider = 'google'
        AND connection.external_account_id = 'legacy-fixture-calendar'
    `;
    if (
      !evidence?.priorMigrationsApplied ||
      evidence.accountMigrationApplied ||
      evidence.accountColumnExists ||
      Number(evidence.duplicateConnections) !== 2
    ) {
      throw new Error(
        "Duplicate provider-account ownership did not roll migration 024 back intact.",
      );
    }
  } finally {
    await testDatabase`
      DELETE FROM organizations WHERE slug = ${legacyMigrationFixtureSlug}
    `;
  }
}

if (legacyMigrationFixtureMode) {
  try {
    if (legacyMigrationFixtureMode === "seed-early-024-upgrade") {
      await seedEarly024UpgradeFixture();
    } else if (legacyMigrationFixtureMode === "verify-early-024-upgrade") {
      await verifyEarly024UpgradeFixture();
    } else if (legacyMigrationFixtureMode === "seed-valid") {
      await seedLegacyMigrationFixture("valid");
    } else if (legacyMigrationFixtureMode === "verify-valid") {
      await verifyLegacyMigrationFixture();
    } else if (legacyMigrationFixtureMode === "seed-malformed") {
      await seedLegacyMigrationFixture("malformed");
    } else if (legacyMigrationFixtureMode === "verify-malformed") {
      await verifyMalformedLegacyMigrationFixture();
    } else if (legacyMigrationFixtureMode === "seed-linked-mismatch") {
      await seedLegacyMigrationFixture("linked-mismatch");
    } else if (legacyMigrationFixtureMode === "verify-linked-mismatch") {
      await verifyLinkedMismatchMigrationFixture();
    } else if (legacyMigrationFixtureMode === "seed-malformed-reschedule") {
      await seedLegacyMigrationFixture("malformed-reschedule");
    } else if (legacyMigrationFixtureMode === "verify-malformed-reschedule") {
      await verifyMalformedLifecycleMigrationFixture("reschedule");
    } else if (legacyMigrationFixtureMode === "seed-malformed-cancel") {
      await seedLegacyMigrationFixture("malformed-cancel");
    } else if (legacyMigrationFixtureMode === "verify-malformed-cancel") {
      await verifyMalformedLifecycleMigrationFixture("cancel");
    } else if (legacyMigrationFixtureMode === "seed-uncertain-create") {
      await seedLegacyMigrationFixture("uncertain-create");
    } else if (legacyMigrationFixtureMode === "verify-uncertain-create") {
      await verifyUncertainCreateMigrationFixture();
    } else if (
      legacyMigrationFixtureMode === "seed-processing-reconciliation"
    ) {
      await seedLegacyMigrationFixture("processing-reconciliation");
    } else if (
      legacyMigrationFixtureMode === "verify-processing-reconciliation"
    ) {
      await verifyProcessingReconciliationMigrationFixture();
    } else if (legacyMigrationFixtureMode === "seed-duplicate-account") {
      await seedLegacyMigrationFixture("duplicate-account");
    } else if (legacyMigrationFixtureMode === "verify-duplicate-account") {
      await verifyDuplicateAccountMigrationFixture();
    } else {
      throw new Error(
        `Unknown HOT_POTATO_LEGACY_FIXTURE_MODE: ${legacyMigrationFixtureMode}`,
      );
    }
    console.log(
      `Legacy migration fixture ${legacyMigrationFixtureMode} passed.`,
    );
  } finally {
    await testDatabase.end();
    await repository.close();
  }
  process.exit(0);
}

try {
  const request = {
    organizationSlug: "acme",
    externalId: `smoke-${randomUUID()}`,
    lead: {
      email: "integration-test@example.com",
      company: { employee_count: 900, state: "NY" },
    },
    now: new Date("2026-08-24T16:00:00.000Z"),
  } as const;
  const decision = await repository.route(request);
  const repeated = await repository.route(request);
  const found = await repository.decisionByExternalId(
    request.organizationSlug,
    request.externalId,
  );
  const dashboard = await repository.dashboard("acme");
  const previewAssignmentsBefore = dashboard.pools.flatMap((pool) =>
    pool.members.map((rep) => `${pool.id}:${rep.id}:${rep.assignments}`),
  );
  const previewDecisionIdsBefore = dashboard.decisions.map((item) => item.id);
  const preview = await repository.routingPreview({
    organizationSlug: "acme",
    lead: request.lead,
    evaluatedAt: request.now,
  });
  const dashboardAfterPreview = await repository.dashboard("acme");
  const connections = await repository.connectionStatuses("acme");
  const poolSchedule = await repository.publicSchedule(
    "acme",
    "enterprise-intro",
  );

  if (!dashboard.decisions.some((item) => item.id === decision.id)) {
    throw new Error(
      "Persisted decision was not returned by the dashboard query.",
    );
  }
  if (
    preview.outcome !== "matched" ||
    preview.selectedRule?.name !== "Enterprise Northeast" ||
    !preview.selectedRep
  ) {
    throw new Error(
      "Side-effect-free routing preview did not explain a winner.",
    );
  }
  if (
    JSON.stringify(previewDecisionIdsBefore) !==
      JSON.stringify(dashboardAfterPreview.decisions.map((item) => item.id)) ||
    JSON.stringify(previewAssignmentsBefore) !==
      JSON.stringify(
        dashboardAfterPreview.pools.flatMap((pool) =>
          pool.members.map((rep) => `${pool.id}:${rep.id}:${rep.assignments}`),
        ),
      )
  ) {
    throw new Error("Routing preview changed a decision or assignment count.");
  }
  if (decision.ruleName !== "Enterprise Northeast") {
    throw new Error(`Unexpected matched rule: ${decision.ruleName}`);
  }
  if (decision.id !== repeated.id) {
    throw new Error("Repeated external ID created more than one decision.");
  }
  if (decision.id !== found?.id) {
    throw new Error("Decision lookup did not return the idempotent result.");
  }
  if (
    connections.map((connection) => connection.provider).join(",") !==
    "hubspot,google,microsoft"
  ) {
    throw new Error("Connection status did not include all three providers.");
  }
  const connectedCalendars = connections.filter(
    (connection) =>
      connection.connected &&
      (connection.provider === "google" || connection.provider === "microsoft"),
  );
  if (
    connectedCalendars.length > 0 &&
    connectedCalendars.filter((connection) => connection.active).length !== 1
  ) {
    throw new Error("Exactly one connected calendar provider must be active.");
  }
  if (!poolSchedule || poolSchedule.targetType !== "pool") {
    throw new Error("Seeded pool scheduling link was not resolved.");
  }
  if (
    !dashboard.meetingTypes.some(
      (item) => item.id === poolSchedule.meetingTypeId,
    )
  ) {
    throw new Error("Dashboard did not include the seeded meeting type.");
  }
  if (
    !dashboard.reps.every((rep) =>
      dashboard.meetingTypes.some(
        (meetingType) =>
          meetingType.targetType === "rep" && meetingType.targetId === rep.id,
      ),
    )
  ) {
    throw new Error(
      "Every seeded representative needs a default meeting type.",
    );
  }
  const editableRep = dashboard.reps[0];
  const editablePool = dashboard.pools[0];
  const editableRule = dashboard.rules.find((item) => item.active);
  if (!editableRep || !editablePool || !editableRule) {
    throw new Error("Seeded routing configuration was not returned.");
  }
  await repository.saveRoutingRep({
    organizationSlug: "acme",
    id: editableRep.id,
    name: editableRep.name,
    email: editableRep.email,
    timezone: editableRep.timezone,
    weight: editableRep.weight,
    active: editableRep.active,
    schedulingSlug: editableRep.schedulingSlug,
  });
  await repository.saveRoutingPool({
    organizationSlug: "acme",
    id: editablePool.id,
    name: editablePool.name,
    slug: editablePool.slug,
    memberIds: editablePool.members.map((member) => member.id),
  });
  await repository.saveRoutingRule({
    organizationSlug: "acme",
    id: editableRule.id,
    name: editableRule.name,
    priority: editableRule.priority,
    conditions: editableRule.conditions,
    poolId: editableRule.poolId,
    active: editableRule.active,
  });
  const dashboardAfterSave = await repository.dashboard("acme");
  if (
    !dashboardAfterSave.reps.some((item) => item.id === editableRep.id) ||
    !dashboardAfterSave.pools.some((item) => item.id === editablePool.id) ||
    !dashboardAfterSave.rules.some((item) => item.id === editableRule.id)
  ) {
    throw new Error("Saved routing configuration did not survive reload.");
  }

  await testDatabase`
    INSERT INTO organizations (slug, name)
    VALUES (${temporaryOrganizationSlug}, 'Routing Studio integration')
  `;
  await repository.saveOAuthConnection({
    organizationSlug: temporaryOrganizationSlug,
    provider: "hubspot",
    encryptedAccessToken: "org-account-a-access",
    encryptedRefreshToken: "org-account-a-refresh",
    expiresAt: new Date("2027-08-24T00:00:00.000Z"),
    scopes: ["oauth"],
    externalAccountId: integrationOrganizationAccountAId,
    externalAccountName: "Organization account A",
    metadata: { generation: "a" },
  });
  const staleOrganizationConnection = await repository.getOAuthConnection(
    temporaryOrganizationSlug,
    "hubspot",
  );
  if (!staleOrganizationConnection) {
    throw new Error("Organization OAuth connection was not saved.");
  }
  await repository.saveOAuthConnection({
    ...staleOrganizationConnection,
    encryptedAccessToken: "org-account-b-access",
    encryptedRefreshToken: "org-account-b-refresh",
    externalAccountId: integrationOrganizationAccountBId,
    externalAccountName: "Organization account B",
    metadata: { generation: "b" },
  });
  let staleOrganizationRefreshRejected = false;
  try {
    await repository.saveOAuthConnection(
      {
        ...staleOrganizationConnection,
        encryptedAccessToken: "late-account-a-access",
        encryptedRefreshToken: "late-account-a-refresh",
        metadata: { generation: "late-a" },
      },
      {
        expectedExternalAccountId:
          staleOrganizationConnection.externalAccountId,
        expectedEncryptedRefreshToken:
          staleOrganizationConnection.encryptedRefreshToken,
      },
    );
  } catch (error) {
    staleOrganizationRefreshRejected =
      error instanceof OAuthConnectionConflictError;
  }
  const organizationConnectionAfterRace = await repository.getOAuthConnection(
    temporaryOrganizationSlug,
    "hubspot",
  );
  if (
    !staleOrganizationRefreshRejected ||
    organizationConnectionAfterRace?.externalAccountId !==
      integrationOrganizationAccountBId ||
    organizationConnectionAfterRace.encryptedRefreshToken !==
      "org-account-b-refresh" ||
    organizationConnectionAfterRace.metadata.generation !== "b"
  ) {
    throw new Error(
      "A stale organization OAuth refresh overwrote a newer reconnect.",
    );
  }
  const createdRepId = await repository.saveRoutingRep({
    organizationSlug: temporaryOrganizationSlug,
    name: "Test Representative",
    email: temporaryRepEmail,
    timezone: "UTC",
    weight: 2,
    active: true,
    schedulingSlug: "test-representative",
  });
  const [operatorAccount] = await testDatabase`
    INSERT INTO operator_accounts (
      login, display_name, password_hash
    ) VALUES (
      ${temporaryRepEmail}, 'Test Representative',
      ${`scrypt$${"x".repeat(100)}`}
    )
    RETURNING id
  `;
  const [operatorOrganization] = await testDatabase`
    SELECT id FROM organizations WHERE slug = ${temporaryOrganizationSlug}
  `;
  await testDatabase`
    INSERT INTO organization_memberships (
      organization_id, operator_id, role
    ) VALUES (
      ${operatorOrganization!.id}, ${operatorAccount!.id}, 'operator'
    )
  `;
  const operatorCalendarProfile = await repository.operatorRepCalendarProfile(
    temporaryOrganizationSlug,
    String(operatorAccount!.id),
  );
  const operatorCalendarAllowed = await repository.operatorCanManageRepCalendar(
    {
      organizationId: String(operatorOrganization!.id),
      operatorId: String(operatorAccount!.id),
      repId: createdRepId,
    },
  );
  if (
    operatorCalendarProfile?.rep.id !== createdRepId ||
    operatorCalendarProfile.rep.email !== temporaryRepEmail ||
    !operatorCalendarAllowed
  ) {
    throw new Error(
      "An operator was not scoped to the single active representative matching their login.",
    );
  }
  const operatorHoursUpdated = await repository.updateOperatorRepWorkingHours({
    organizationId: String(operatorOrganization!.id),
    operatorId: String(operatorAccount!.id),
    repId: createdRepId,
    timezone: "America/Chicago",
    availability: {
      monday: [
        { start: "09:00", end: "12:00" },
        { start: "13:00", end: "17:00" },
      ],
    },
    availabilityOverrides: {
      "2026-09-07": [],
      "2026-09-08": [
        { start: "10:00", end: "12:00" },
        { start: "14:00", end: "16:00" },
      ],
    },
    dailyMeetingLimit: null,
    weeklyMeetingLimit: null,
  });
  const operatorProfileAfterHours = await repository.operatorRepCalendarProfile(
    temporaryOrganizationSlug,
    String(operatorAccount!.id),
  );
  if (
    !operatorHoursUpdated ||
    operatorProfileAfterHours?.rep.timezone !== "America/Chicago" ||
    operatorProfileAfterHours.rep.availability.monday?.length !== 2 ||
    operatorProfileAfterHours.rep.availabilityOverrides["2026-09-07"]
      ?.length !== 0 ||
    operatorProfileAfterHours.rep.availabilityOverrides["2026-09-08"]
      ?.length !== 2
  ) {
    throw new Error(
      "An operator could not atomically update their own representative availability.",
    );
  }
  const operatorScheduleDenied = await repository.saveAvailabilitySchedule({
    organizationId: String(operatorOrganization!.id),
    operatorId: String(operatorAccount!.id),
    name: "Denied operator schedule",
    availability: {},
  });
  if (operatorScheduleDenied !== null) {
    throw new Error(
      "An operator created an administrator-only reusable schedule.",
    );
  }
  await testDatabase`
    UPDATE organization_memberships
    SET role = 'admin'
    WHERE organization_id = ${operatorOrganization!.id}
      AND operator_id = ${operatorAccount!.id}
  `;
  const availabilityScheduleId = await repository.saveAvailabilitySchedule({
    organizationId: String(operatorOrganization!.id),
    operatorId: String(operatorAccount!.id),
    name: "Revenue coverage",
    availability: {
      monday: [{ start: "08:00", end: "12:00" }],
    },
  });
  await testDatabase`
    UPDATE organization_memberships
    SET role = 'operator'
    WHERE organization_id = ${operatorOrganization!.id}
      AND operator_id = ${operatorAccount!.id}
  `;
  if (!availabilityScheduleId) {
    throw new Error("An administrator could not create a reusable schedule.");
  }
  const reusableScheduleAssigned =
    await repository.updateOperatorRepWorkingHours({
      organizationId: String(operatorOrganization!.id),
      operatorId: String(operatorAccount!.id),
      repId: createdRepId,
      timezone: "America/Chicago",
      availability: {
        tuesday: [{ start: "01:00", end: "02:00" }],
      },
      availabilityOverrides:
        operatorProfileAfterHours.rep.availabilityOverrides,
      availabilityScheduleId,
      dailyMeetingLimit: null,
      weeklyMeetingLimit: null,
    });
  const profileAfterScheduleAssignment =
    await repository.operatorRepCalendarProfile(
      temporaryOrganizationSlug,
      String(operatorAccount!.id),
    );
  if (
    !reusableScheduleAssigned ||
    profileAfterScheduleAssignment?.rep.availabilityScheduleId !==
      availabilityScheduleId ||
    profileAfterScheduleAssignment.rep.availabilityScheduleName !==
      "Revenue coverage" ||
    profileAfterScheduleAssignment.rep.availability.monday?.[0]?.start !==
      "08:00" ||
    profileAfterScheduleAssignment.rep.availability.tuesday !== undefined ||
    profileAfterScheduleAssignment.rep.availabilityOverrides["2026-09-07"]
      ?.length !== 0 ||
    profileAfterScheduleAssignment.availabilitySchedules[0]
      ?.assignedRepCount !== 1
  ) {
    throw new Error(
      "A reusable schedule was not assigned as the authoritative weekly availability while preserving date overrides.",
    );
  }
  await testDatabase`
    UPDATE organization_memberships
    SET role = 'admin'
    WHERE organization_id = ${operatorOrganization!.id}
      AND operator_id = ${operatorAccount!.id}
  `;
  const propagatedScheduleId = await repository.saveAvailabilitySchedule({
    organizationId: String(operatorOrganization!.id),
    operatorId: String(operatorAccount!.id),
    id: availabilityScheduleId,
    name: "Revenue coverage",
    availability: {
      thursday: [{ start: "10:00", end: "16:00" }],
    },
  });
  const profileAfterSchedulePropagation =
    await repository.operatorRepCalendarProfile(
      temporaryOrganizationSlug,
      String(operatorAccount!.id),
    );
  const reusableScheduleDeleted = await repository.deleteAvailabilitySchedule({
    organizationId: String(operatorOrganization!.id),
    operatorId: String(operatorAccount!.id),
    id: availabilityScheduleId,
  });
  const profileAfterScheduleDelete =
    await repository.operatorRepCalendarProfile(
      temporaryOrganizationSlug,
      String(operatorAccount!.id),
    );
  await testDatabase`
    UPDATE organization_memberships
    SET role = 'operator'
    WHERE organization_id = ${operatorOrganization!.id}
      AND operator_id = ${operatorAccount!.id}
  `;
  if (
    propagatedScheduleId !== availabilityScheduleId ||
    profileAfterSchedulePropagation?.rep.availability.thursday?.[0]?.end !==
      "16:00" ||
    !reusableScheduleDeleted ||
    profileAfterScheduleDelete?.rep.availabilityScheduleId !== null ||
    profileAfterScheduleDelete.rep.availabilityScheduleName !== null ||
    profileAfterScheduleDelete.rep.availability.thursday?.[0]?.end !==
      "16:00" ||
    profileAfterScheduleDelete.availabilitySchedules.length !== 0
  ) {
    throw new Error(
      "Reusable schedule propagation or safe detach-on-delete failed.",
    );
  }
  const supersededStateHash = createHash("sha256")
    .update(`superseded-${randomUUID()}`)
    .digest("hex");
  const activeStateHash = createHash("sha256")
    .update(`active-${randomUUID()}`)
    .digest("hex");
  const attemptBase = {
    organizationId: String(operatorOrganization!.id),
    operatorId: String(operatorAccount!.id),
    repId: createdRepId,
    provider: "google" as const,
    returnTo: "my-calendar" as const,
    expiresAt: new Date(Date.now() + 10 * 60_000),
  };
  await repository.createRepCalendarOAuthAttempt({
    ...attemptBase,
    stateHash: supersededStateHash,
  });
  await repository.createRepCalendarOAuthAttempt({
    ...attemptBase,
    stateHash: activeStateHash,
  });
  const supersededAttempt = await repository.consumeRepCalendarOAuthAttempt({
    organizationId: attemptBase.organizationId,
    operatorId: attemptBase.operatorId,
    provider: "google",
    stateHash: supersededStateHash,
  });
  const consumedAttempt = await repository.consumeRepCalendarOAuthAttempt({
    organizationId: attemptBase.organizationId,
    operatorId: attemptBase.operatorId,
    provider: "google",
    stateHash: activeStateHash,
  });
  const replayedAttempt = await repository.consumeRepCalendarOAuthAttempt({
    organizationId: attemptBase.organizationId,
    operatorId: attemptBase.operatorId,
    provider: "google",
    stateHash: activeStateHash,
  });
  if (
    supersededAttempt !== null ||
    consumedAttempt?.repId !== createdRepId ||
    consumedAttempt.returnTo !== "my-calendar" ||
    replayedAttempt !== null
  ) {
    throw new Error(
      "Representative calendar OAuth attempts were not superseded and consumed exactly once.",
    );
  }
  const ambiguousRepId = await repository.saveRoutingRep({
    organizationSlug: temporaryOrganizationSlug,
    name: "Ambiguous Test Representative",
    email: temporaryRepEmail.toUpperCase(),
    timezone: "UTC",
    weight: 1,
    active: true,
    schedulingSlug: `ambiguous-${randomUUID()}`,
  });
  const ambiguousCalendarProfile = await repository.operatorRepCalendarProfile(
    temporaryOrganizationSlug,
    String(operatorAccount!.id),
  );
  const ambiguousCalendarAllowed =
    await repository.operatorCanManageRepCalendar({
      organizationId: String(operatorOrganization!.id),
      operatorId: String(operatorAccount!.id),
      repId: createdRepId,
    });
  const ambiguousHoursUpdated = await repository.updateOperatorRepWorkingHours({
    organizationId: String(operatorOrganization!.id),
    operatorId: String(operatorAccount!.id),
    repId: createdRepId,
    timezone: "UTC",
    availability: {
      tuesday: [{ start: "01:00", end: "02:00" }],
    },
    availabilityOverrides: {
      "2026-09-09": [{ start: "01:00", end: "02:00" }],
    },
    dailyMeetingLimit: null,
    weeklyMeetingLimit: null,
  });
  const [hoursAfterAmbiguousUpdate] = await testDatabase`
    SELECT timezone, availability, availability_overrides
    FROM reps WHERE id = ${createdRepId}
  `;
  const overridesAfterAmbiguousUpdate =
    (hoursAfterAmbiguousUpdate?.availabilityOverrides ?? {}) as Record<
      string,
      unknown[]
    >;
  if (
    ambiguousCalendarProfile !== null ||
    ambiguousCalendarAllowed ||
    ambiguousHoursUpdated ||
    hoursAfterAmbiguousUpdate?.timezone !== "America/Chicago" ||
    (
      hoursAfterAmbiguousUpdate.availability as {
        thursday?: Array<{ end?: string }>;
      }
    ).thursday?.[0]?.end !== "16:00" ||
    overridesAfterAmbiguousUpdate["2026-09-07"]?.length !== 0 ||
    overridesAfterAmbiguousUpdate["2026-09-08"]?.length !== 2 ||
    Object.prototype.hasOwnProperty.call(
      overridesAfterAmbiguousUpdate,
      "2026-09-09",
    )
  ) {
    throw new Error(
      "Representative calendar and availability authorization did not fail closed on an ambiguous normalized email.",
    );
  }
  await testDatabase`DELETE FROM reps WHERE id = ${ambiguousRepId}`;
  const operatorHoursRestored = await repository.updateOperatorRepWorkingHours({
    organizationId: String(operatorOrganization!.id),
    operatorId: String(operatorAccount!.id),
    repId: createdRepId,
    timezone: operatorCalendarProfile.rep.timezone,
    availability: operatorCalendarProfile.rep.availability,
    availabilityOverrides: operatorCalendarProfile.rep.availabilityOverrides,
    availabilityScheduleId: null,
    dailyMeetingLimit: operatorCalendarProfile.rep.dailyMeetingLimit,
    weeklyMeetingLimit: operatorCalendarProfile.rep.weeklyMeetingLimit,
  });
  if (!operatorHoursRestored) {
    throw new Error(
      "Representative availability was not restored after the ambiguity test.",
    );
  }
  const createdPoolId = await repository.saveRoutingPool({
    organizationSlug: temporaryOrganizationSlug,
    name: "Qualified inbound",
    slug: "qualified-inbound",
    memberIds: [createdRepId],
  });
  const createdRuleId = await repository.saveRoutingRule({
    organizationSlug: temporaryOrganizationSlug,
    name: "Qualified company",
    priority: 10,
    conditions: {
      "company.employee_count": { gte: 50 },
      "company.state": { in: ["NY"] },
    },
    poolId: createdPoolId,
    active: true,
  });
  await repository.saveRoutingRule({
    organizationSlug: temporaryOrganizationSlug,
    name: "Large company without partner code",
    priority: 20,
    conditions: {
      "company.employee_count": { gte: 1_000 },
      "company.partner_code": { exists: false },
    },
    poolId: createdPoolId,
    active: true,
  });
  const createdMeetingTypeId = await repository.saveMeetingType({
    organizationSlug: temporaryOrganizationSlug,
    slug: "qualified-team",
    title: "Qualified team introduction",
    description: "Meet the best representative for your company.",
    durationMinutes: 30,
    minimumNoticeMinutes: 0,
    bookingWindowDays: 14,
    conferenceProvider: "none",
    reminderMinutes: 0,
    active: true,
    targetType: "pool",
    targetId: createdPoolId,
  });
  const routerQuestion = {
    field: "company.employee_count",
    label: "Company size",
    type: "number" as const,
    required: true,
    placeholder: "75",
    helpText: "An estimate is fine.",
    options: [],
  };
  const routerStateQuestion = {
    field: "company.state",
    label: "Company state",
    type: "select" as const,
    required: true,
    placeholder: "Choose a state",
    helpText: "This keeps sibling nested answers intact.",
    options: ["NY", "CA"],
  };
  let excessiveQuestionsRejected = false;
  try {
    await repository.saveRouterLink({
      organizationSlug: temporaryOrganizationSlug,
      name: "Oversized questionnaire",
      slug: "oversized-questionnaire",
      title: "Oversized questionnaire",
      description: "This draft exceeds the public request budget.",
      buttonLabel: "Find my time",
      noMatchMessage: "Thanks — our team will follow up.",
      accentColor: "#f97316",
      active: false,
      questions: Array.from({ length: 21 }, (_, index) => ({
        ...routerQuestion,
        field: `company.test_field_${index}`,
        label: `Test field ${index}`,
      })),
      destinations: [],
    });
  } catch (error) {
    excessiveQuestionsRejected = error instanceof RouterLinkValidationError;
  }
  if (!excessiveQuestionsRejected) {
    throw new Error("Smart Link accepted more than 20 questions.");
  }
  let attendeeNameQuestionRejected = false;
  try {
    await repository.saveRouterLink({
      organizationSlug: temporaryOrganizationSlug,
      name: "Reserved attendee identity question",
      slug: "reserved-attendee-identity-question",
      title: "Reserved attendee identity question",
      description: "This draft attempts to overwrite attendee identity.",
      buttonLabel: "Find my time",
      noMatchMessage: "Thanks — our team will follow up.",
      accentColor: "#f97316",
      active: false,
      questions: [{ ...routerQuestion, field: "attendee_name" }],
      destinations: [],
    });
  } catch (error) {
    attendeeNameQuestionRejected = error instanceof RouterLinkValidationError;
  }
  if (!attendeeNameQuestionRejected) {
    throw new Error("Smart Link accepted attendee_name as a routing question.");
  }
  let emptyDestinationRejected = false;
  try {
    await repository.saveRouterLink({
      organizationSlug: temporaryOrganizationSlug,
      name: "Unavailable destination router",
      slug: "unavailable-destination-router",
      title: "Unavailable destination router",
      description: "The pool has no connected representative calendar.",
      buttonLabel: "Find my time",
      noMatchMessage: "Thanks — our team will follow up.",
      accentColor: "#f97316",
      active: true,
      questions: [routerQuestion, routerStateQuestion],
      destinations: [
        { poolId: createdPoolId, meetingTypeId: createdMeetingTypeId },
      ],
    });
  } catch (error) {
    emptyDestinationRejected = error instanceof RouterLinkValidationError;
  }
  if (!emptyDestinationRejected) {
    throw new Error(
      "Published Smart Link accepted an unavailable destination.",
    );
  }
  await repository.saveRepCalendarConnection({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "google",
    encryptedAccessToken: "integration-access-token",
    encryptedRefreshToken: "integration-refresh-token",
    expiresAt: new Date("2027-08-24T00:00:00.000Z"),
    scopes: [
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    ],
    externalAccountId: integrationGoogleAccountId,
    externalAccountName: "Integration calendar",
    metadata: {},
  });
  const duplicateAccountRepId = await repository.saveRoutingRep({
    organizationSlug: temporaryOrganizationSlug,
    name: "Duplicate Calendar Representative",
    email: `duplicate-calendar-${randomUUID()}@example.com`,
    timezone: "UTC",
    weight: 1,
    active: false,
    schedulingSlug: `duplicate-calendar-${randomUUID()}`,
  });
  let duplicateCalendarAccountRejected = false;
  try {
    await repository.saveRepCalendarConnection({
      organizationSlug: temporaryOrganizationSlug,
      repId: duplicateAccountRepId,
      provider: "google",
      encryptedAccessToken: "duplicate-account-access-token",
      encryptedRefreshToken: "duplicate-account-refresh-token",
      expiresAt: new Date("2027-08-24T00:00:00.000Z"),
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      externalAccountId: integrationGoogleAccountId,
      externalAccountName: "Duplicate integration calendar",
      metadata: {},
    });
  } catch (error) {
    duplicateCalendarAccountRejected =
      error instanceof CalendarAccountIdentityError;
  }
  const duplicateAccountConnection = await repository.getRepCalendarConnection(
    temporaryOrganizationSlug,
    duplicateAccountRepId,
    "google",
  );
  if (!duplicateCalendarAccountRejected || duplicateAccountConnection) {
    throw new Error(
      "One provider account was attached to more than one representative.",
    );
  }
  await repository.setActiveRepCalendarProvider(
    temporaryOrganizationSlug,
    createdRepId,
    "google",
  );
  const newGoogleConnection = await repository.getRepCalendarConnection(
    temporaryOrganizationSlug,
    createdRepId,
    "google",
  );
  if (!newGoogleConnection?.checkConflicts) {
    throw new Error("A new rep calendar did not default to conflict checks.");
  }
  await repository.saveRepCalendarConnection({
    ...newGoogleConnection,
    encryptedAccessToken: "newer-same-account-access-token",
    encryptedRefreshToken: "newer-same-account-refresh-token",
    metadata: { generation: "newer-same-account" },
  });
  let staleSameAccountRefreshRejected = false;
  try {
    await repository.saveRepCalendarConnection(
      {
        ...newGoogleConnection,
        encryptedAccessToken: "stale-same-account-access-token",
        encryptedRefreshToken: "stale-same-account-refresh-token",
        metadata: { generation: "stale-same-account" },
      },
      {
        preserveCalendarSources: true,
        expectedExternalAccountId: newGoogleConnection.externalAccountId,
        expectedEncryptedRefreshToken:
          newGoogleConnection.encryptedRefreshToken,
      },
    );
  } catch (error) {
    staleSameAccountRefreshRejected =
      error instanceof CalendarAccountIdentityError;
  }
  const sameAccountRefreshWinner = await repository.getRepCalendarConnection(
    temporaryOrganizationSlug,
    createdRepId,
    "google",
  );
  if (
    !staleSameAccountRefreshRejected ||
    sameAccountRefreshWinner?.encryptedRefreshToken !==
      "newer-same-account-refresh-token"
  ) {
    throw new Error(
      "A stale same-account token refresh overwrote newer credentials.",
    );
  }
  await repository.saveRepCalendarConnection({
    ...sameAccountRefreshWinner!,
    encryptedAccessToken: "replacement-account-access-token",
    encryptedRefreshToken: "replacement-account-refresh-token",
    externalAccountId: integrationGoogleReplacementAccountId,
    externalAccountName: "Replacement integration calendar",
    metadata: { generation: "replacement-account" },
  });
  let staleReconnectedAccountRefreshRejected = false;
  try {
    await repository.saveRepCalendarConnection(
      {
        ...sameAccountRefreshWinner!,
        encryptedAccessToken: "stale-reconnected-access-token",
        encryptedRefreshToken: "stale-reconnected-refresh-token",
      },
      {
        preserveCalendarSources: true,
        expectedExternalAccountId: sameAccountRefreshWinner!.externalAccountId,
        expectedEncryptedRefreshToken:
          sameAccountRefreshWinner!.encryptedRefreshToken,
      },
    );
  } catch (error) {
    staleReconnectedAccountRefreshRejected =
      error instanceof CalendarAccountIdentityError;
  }
  if (!staleReconnectedAccountRefreshRejected) {
    throw new Error(
      "A stale refresh overwrote a reconnected calendar account.",
    );
  }
  await repository.saveRepCalendarConnection({
    ...sameAccountRefreshWinner!,
    encryptedAccessToken: "integration-access-token",
    encryptedRefreshToken: "integration-refresh-token",
    externalAccountId: integrationGoogleAccountId,
    externalAccountName: "Integration calendar",
    metadata: {},
  });
  await repository.syncRepCalendarSources({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "google",
    calendars: [
      { id: "primary", name: "Work calendar", isDefault: true },
      {
        id: "google-secondary",
        name: "Customer calls",
        isDefault: false,
      },
    ],
  });
  await repository.updateRepCalendarSettings({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "google",
    selectedCalendarIds: ["primary", "google-secondary"],
  });
  const googleCalendarSettings = await repository.repCalendarSettings(
    temporaryOrganizationSlug,
    createdRepId,
    "google",
  );
  if (
    !googleCalendarSettings?.canSyncCalendars ||
    googleCalendarSettings.calendars.length !== 2 ||
    !googleCalendarSettings.calendars.every((calendar) => calendar.selected)
  ) {
    throw new Error("Google calendar discovery and selection did not persist.");
  }
  let unknownCalendarRejected = false;
  try {
    await repository.updateRepCalendarSettings({
      organizationSlug: temporaryOrganizationSlug,
      repId: createdRepId,
      provider: "google",
      selectedCalendarIds: ["primary", "unknown-calendar"],
    });
  } catch {
    unknownCalendarRejected = true;
  }
  if (!unknownCalendarRejected) {
    throw new Error("An unknown conflict calendar was selected.");
  }

  await repository.saveRepCalendarConnection({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "microsoft",
    encryptedAccessToken: "integration-microsoft-access-token",
    encryptedRefreshToken: "integration-microsoft-refresh-token",
    expiresAt: new Date("2027-08-24T00:00:00.000Z"),
    scopes: ["Calendars.ReadWrite"],
    externalAccountId: integrationOutlookAccountId,
    externalAccountName: "Integration Outlook calendar",
    metadata: {},
  });
  await repository.syncRepCalendarSources({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "microsoft",
    calendars: [
      { id: "default", name: "Calendar", isDefault: true },
      {
        id: "microsoft-secondary",
        name: "Customer demos",
        isDefault: false,
      },
    ],
  });
  await repository.updateRepCalendarSettings({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "microsoft",
    selectedCalendarIds: ["default", "microsoft-secondary"],
  });
  await repository.syncRepCalendarSources({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "microsoft",
    calendars: [{ id: "default", name: "Calendar", isDefault: true }],
  });
  const missingMicrosoftCalendar = (
    await repository.repCalendarSettings(
      temporaryOrganizationSlug,
      createdRepId,
      "microsoft",
    )
  )?.calendars.find(
    (calendar) => calendar.calendarId === "microsoft-secondary",
  );
  if (
    !missingMicrosoftCalendar?.selected ||
    missingMicrosoftCalendar.available ||
    !missingMicrosoftCalendar.missingSince
  ) {
    throw new Error("A missing selected calendar did not fail closed.");
  }
  await repository.syncRepCalendarSources({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "microsoft",
    calendars: [
      { id: "default", name: "Calendar", isDefault: true },
      {
        id: "microsoft-secondary",
        name: "Customer demos",
        isDefault: false,
      },
    ],
  });
  const restoredMicrosoftCalendar = (
    await repository.repCalendarSettings(
      temporaryOrganizationSlug,
      createdRepId,
      "microsoft",
    )
  )?.calendars.find(
    (calendar) => calendar.calendarId === "microsoft-secondary",
  );
  if (
    !restoredMicrosoftCalendar?.selected ||
    !restoredMicrosoftCalendar.available ||
    restoredMicrosoftCalendar.missingSince
  ) {
    throw new Error("A rediscovered calendar did not preserve its selection.");
  }
  const initialConflictProviders =
    await repository.repAvailabilityCalendarProviders(
      temporaryOrganizationSlug,
      [createdRepId],
    );
  if (
    initialConflictProviders.get(createdRepId)?.join(",") !== "google,microsoft"
  ) {
    throw new Error("Connected rep calendars were not selected by default.");
  }

  await repository.updateRepCalendarSettings({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "microsoft",
    checkConflicts: false,
  });
  await repository.saveRepCalendarConnection({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "microsoft",
    encryptedAccessToken: "integration-microsoft-refreshed-access-token",
    encryptedRefreshToken: "integration-microsoft-refreshed-refresh-token",
    expiresAt: new Date("2027-09-24T00:00:00.000Z"),
    scopes: ["Calendars.ReadWrite"],
    externalAccountId: integrationOutlookAccountId,
    externalAccountName: "Integration Outlook calendar",
    metadata: { refreshed: true },
  });
  const reconnectedMicrosoft = await repository.getRepCalendarConnection(
    temporaryOrganizationSlug,
    createdRepId,
    "microsoft",
  );
  const afterReconnectProviders =
    await repository.repAvailabilityCalendarProviders(
      temporaryOrganizationSlug,
      [createdRepId],
    );
  const afterReconnectDashboard = await repository.dashboard(
    temporaryOrganizationSlug,
  );
  const afterReconnectRep = afterReconnectDashboard.reps.find(
    (rep) => rep.id === createdRepId,
  );
  if (
    reconnectedMicrosoft?.checkConflicts !== false ||
    afterReconnectProviders.get(createdRepId)?.join(",") !== "google" ||
    !afterReconnectRep?.googleCalendar.checkConflicts ||
    afterReconnectRep.microsoftCalendar.checkConflicts
  ) {
    throw new Error("Reconnecting changed the saved conflict-calendar choice.");
  }

  await repository.saveRepCalendarConnection({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "microsoft",
    encryptedAccessToken: "integration-unknown-account-access-token",
    encryptedRefreshToken: "integration-unknown-account-refresh-token",
    expiresAt: new Date("2027-10-24T00:00:00.000Z"),
    scopes: ["Calendars.ReadWrite"],
    externalAccountId: null,
    externalAccountName: null,
    metadata: {},
  });
  const unknownMicrosoftSettings = await repository.repCalendarSettings(
    temporaryOrganizationSlug,
    createdRepId,
    "microsoft",
  );
  if (
    unknownMicrosoftSettings?.calendarCatalogSyncedAt !== null ||
    unknownMicrosoftSettings?.calendars.length !== 1 ||
    unknownMicrosoftSettings.calendars[0]?.calendarId !== "default" ||
    !unknownMicrosoftSettings.calendars[0]?.selected
  ) {
    throw new Error(
      "Reconnecting without a verified account reused stale calendar IDs.",
    );
  }

  await repository.syncRepCalendarSources({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "microsoft",
    calendars: [
      { id: "default", name: "Default calendar", isDefault: true },
      {
        id: "replacement-secondary",
        name: "Replacement secondary",
        isDefault: false,
      },
    ],
  });
  await repository.updateRepCalendarSettings({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "microsoft",
    selectedCalendarIds: ["default", "replacement-secondary"],
  });
  await repository.saveRepCalendarConnection({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "microsoft",
    encryptedAccessToken: "integration-new-account-access-token",
    encryptedRefreshToken: "integration-new-account-refresh-token",
    expiresAt: new Date("2027-11-24T00:00:00.000Z"),
    scopes: ["Calendars.ReadWrite"],
    externalAccountId: integrationOutlookReplacementAccountId,
    externalAccountName: "Replacement Outlook calendar",
    metadata: {},
  });
  const replacementMicrosoftSettings = await repository.repCalendarSettings(
    temporaryOrganizationSlug,
    createdRepId,
    "microsoft",
  );
  if (
    replacementMicrosoftSettings?.calendarCatalogSyncedAt !== null ||
    replacementMicrosoftSettings?.calendars.length !== 1 ||
    replacementMicrosoftSettings.calendars[0]?.calendarId !== "default" ||
    !replacementMicrosoftSettings.calendars[0]?.selected
  ) {
    throw new Error(
      "Connecting a newly verified Microsoft account reused stale calendar IDs.",
    );
  }

  await repository.updateRepCalendarSettings({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "microsoft",
    makeActive: true,
  });
  let activeConflictExclusionRejected = false;
  try {
    await repository.updateRepCalendarSettings({
      organizationSlug: temporaryOrganizationSlug,
      repId: createdRepId,
      provider: "microsoft",
      checkConflicts: false,
    });
  } catch {
    activeConflictExclusionRejected = true;
  }
  if (!activeConflictExclusionRejected) {
    throw new Error("The active write calendar was excluded from conflicts.");
  }

  await repository.updateRepCalendarSettings({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "google",
    makeActive: true,
  });
  let crossOrganizationCalendarUpdateRejected = false;
  try {
    await repository.updateRepCalendarSettings({
      organizationSlug: "acme",
      repId: createdRepId,
      provider: "google",
      checkConflicts: false,
    });
  } catch {
    crossOrganizationCalendarUpdateRejected = true;
  }
  const conflictCalendarDashboard = await repository.dashboard(
    temporaryOrganizationSlug,
  );
  const crossOrganizationCalendarSettings =
    await repository.repCalendarSettings("acme", createdRepId, "google");
  const conflictCalendarRep = conflictCalendarDashboard.reps.find(
    (rep) => rep.id === createdRepId,
  );
  if (
    !crossOrganizationCalendarUpdateRejected ||
    crossOrganizationCalendarSettings !== null ||
    !conflictCalendarRep ||
    conflictCalendarRep.activeCalendarProvider !== "google" ||
    !conflictCalendarRep.googleCalendar.checkConflicts ||
    !conflictCalendarRep.microsoftCalendar.checkConflicts
  ) {
    throw new Error(
      "Rep conflict-calendar settings were not atomic and organization scoped.",
    );
  }
  const quoteSchedule = await repository.publicSchedule(
    temporaryOrganizationSlug,
    "test-representative",
  );
  const quoteRep = quoteSchedule?.reps.find((rep) => rep.id === createdRepId);
  if (!quoteRep) {
    throw new Error("The connected representative had no schedulable quote.");
  }
  const createdRepCalendarQuote: BookingCandidateQuote = {
    repId: quoteRep.id,
    calendarProvider: quoteRep.calendarProvider,
    calendarExternalAccountId: quoteRep.calendarExternalAccountId,
    conflictCalendars: quoteRep.conflictCalendars.map(
      ({ available: _available, ...calendar }) => calendar,
    ),
  };
  const requiredCohostEmail = `required-cohost-${randomUUID()}@example.com`;
  const secondaryCohostEmail = `secondary-cohost-${randomUUID()}@example.com`;
  const optionalCohostEmail = `optional-cohost-${randomUUID()}@example.com`;
  const requiredCohostId = await repository.saveRoutingRep({
    organizationSlug: temporaryOrganizationSlug,
    name: "ZZ Required Co-host",
    email: requiredCohostEmail,
    timezone: "UTC",
    weight: 1,
    active: true,
    schedulingSlug: `required-cohost-${randomUUID()}`,
  });
  const optionalCohostId = await repository.saveRoutingRep({
    organizationSlug: temporaryOrganizationSlug,
    name: "ZZ Optional Co-host",
    email: optionalCohostEmail,
    timezone: "UTC",
    weight: 1,
    active: true,
    schedulingSlug: `optional-cohost-${randomUUID()}`,
  });
  const secondaryCohostId = await repository.saveRoutingRep({
    organizationSlug: temporaryOrganizationSlug,
    name: "ZZ Secondary Co-host",
    email: secondaryCohostEmail,
    timezone: "UTC",
    weight: 1,
    active: true,
    schedulingSlug: `secondary-cohost-${randomUUID()}`,
  });
  const collectiveMicrosoftAccountId = `collective-outlook-${randomUUID()}`;
  await repository.saveRepCalendarConnection({
    organizationSlug: temporaryOrganizationSlug,
    repId: requiredCohostId,
    provider: "microsoft",
    encryptedAccessToken: "collective-outlook-access",
    encryptedRefreshToken: "collective-outlook-refresh",
    expiresAt: new Date("2044-01-01T00:00:00.000Z"),
    scopes: ["Calendars.ReadWrite"],
    externalAccountId: collectiveMicrosoftAccountId,
    externalAccountName: "Required Outlook calendar",
    metadata: {},
  });
  await repository.setActiveRepCalendarProvider(
    temporaryOrganizationSlug,
    requiredCohostId,
    "microsoft",
  );
  const collectiveGoogleAccountId = `collective-google-${randomUUID()}`;
  await repository.saveRepCalendarConnection({
    organizationSlug: temporaryOrganizationSlug,
    repId: secondaryCohostId,
    provider: "google",
    encryptedAccessToken: "collective-google-access",
    encryptedRefreshToken: "collective-google-refresh",
    expiresAt: new Date("2044-01-01T00:00:00.000Z"),
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    externalAccountId: collectiveGoogleAccountId,
    externalAccountName: "Secondary Google calendar",
    metadata: {},
  });
  await repository.setActiveRepCalendarProvider(
    temporaryOrganizationSlug,
    secondaryCohostId,
    "google",
  );
  const collectiveCohostPoolId = await repository.saveRoutingPool({
    organizationSlug: temporaryOrganizationSlug,
    name: "Solutions engineering",
    slug: `solutions-engineering-${randomUUID()}`,
    memberIds: [requiredCohostId, secondaryCohostId],
  });
  const collectiveEscalationPoolId = await repository.saveRoutingPool({
    organizationSlug: temporaryOrganizationSlug,
    name: "Technical escalation",
    slug: `technical-escalation-${randomUUID()}`,
    memberIds: [requiredCohostId],
  });
  await testDatabase`
    UPDATE assignment_state
    SET assignments = 1, last_assigned_at = now()
    WHERE pool_id = ${collectiveCohostPoolId}
      AND rep_id = ${secondaryCohostId}
  `;
  const collectiveMeetingTypeId = await repository.saveMeetingType({
    organizationSlug: temporaryOrganizationSlug,
    slug: "collective-demo",
    title: "Collective demo",
    description: "A Google organizer with an Outlook co-host.",
    durationMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingWindowDays: 365,
    conferenceProvider: "google_meet",
    reminderMinutes: 0,
    active: true,
    targetType: "rep",
    targetId: createdRepId,
    cohosts: [{ repId: optionalCohostId, requiredForAvailability: false }],
    cohostGroups: [
      {
        poolId: collectiveCohostPoolId,
        requiredForAvailability: true,
        crmOwnerProperty: "technical_owner",
      },
      {
        poolId: collectiveEscalationPoolId,
        requiredForAvailability: true,
        crmOwnerProperty: "escalation_owner",
      },
    ],
  });
  await repository.saveMeetingType({
    organizationSlug: temporaryOrganizationSlug,
    id: collectiveMeetingTypeId,
    slug: "collective-demo",
    title: "Collective demo",
    description: "A Google organizer with an Outlook co-host.",
    durationMinutes: 30,
    minimumNoticeMinutes: 0,
    bookingWindowDays: 365,
    conferenceProvider: "google_meet",
    reminderMinutes: 0,
    active: true,
    targetType: "rep",
    targetId: createdRepId,
  });
  const [preservedCohostConfiguration] = await testDatabase`
    SELECT
      (SELECT count(*)::int FROM meeting_type_cohosts
       WHERE meeting_type_id = ${collectiveMeetingTypeId}) AS fixed_count,
      (SELECT count(*)::int FROM meeting_type_cohost_groups
       WHERE meeting_type_id = ${collectiveMeetingTypeId}) AS group_count,
      (SELECT crm_owner_property FROM meeting_type_cohost_groups
       WHERE meeting_type_id = ${collectiveMeetingTypeId}
         AND pool_id = ${collectiveCohostPoolId}) AS technical_owner_property,
      (SELECT crm_owner_property FROM meeting_type_cohost_groups
       WHERE meeting_type_id = ${collectiveMeetingTypeId}
         AND pool_id = ${collectiveEscalationPoolId}) AS escalation_owner_property
  `;
  const collectiveSchedule = await repository.publicSchedule(
    temporaryOrganizationSlug,
    "collective-demo",
  );
  const collectiveOrganizer = collectiveSchedule?.reps.find(
    (rep) => rep.id === createdRepId,
  );
  const collectiveGroup = collectiveSchedule?.cohostGroups.find(
    (group) => group.poolId === collectiveCohostPoolId,
  );
  const collectiveEscalationGroup = collectiveSchedule?.cohostGroups.find(
    (group) => group.poolId === collectiveEscalationPoolId,
  );
  const collectiveRequired = collectiveGroup?.candidates.find(
    (rep) => rep.id === requiredCohostId,
  );
  const collectiveSecondary = collectiveGroup?.candidates.find(
    (rep) => rep.id === secondaryCohostId,
  );
  if (
    !collectiveSchedule ||
    Number(preservedCohostConfiguration?.fixedCount) !== 1 ||
    Number(preservedCohostConfiguration?.groupCount) !== 2 ||
    preservedCohostConfiguration?.technicalOwnerProperty !==
      "technical_owner" ||
    preservedCohostConfiguration?.escalationOwnerProperty !==
      "escalation_owner" ||
    !collectiveOrganizer ||
    !collectiveRequired ||
    !collectiveSecondary ||
    !collectiveEscalationGroup ||
    collectiveRequired.calendarProvider !== "microsoft" ||
    collectiveSecondary.calendarProvider !== "google" ||
    collectiveSchedule.teamMembers.length !== 1 ||
    collectiveSchedule.cohostGroups.length !== 2 ||
    !collectiveGroup?.requiredForAvailability ||
    !collectiveEscalationGroup.requiredForAvailability
  ) {
    throw new Error(
      "Collective scheduling did not expose the required cross-provider calendar and optional invitee.",
    );
  }
  const collectiveQuote: BookingCandidateQuote = {
    repId: collectiveOrganizer.id,
    calendarProvider: collectiveOrganizer.calendarProvider,
    calendarExternalAccountId: collectiveOrganizer.calendarExternalAccountId,
    conflictCalendars: collectiveOrganizer.conflictCalendars.map(
      ({ available: _available, ...calendar }) => calendar,
    ),
    requiredCohosts: [],
    cohostGroups: [
      {
        poolId: collectiveCohostPoolId,
        requiredForAvailability: true,
        candidateQuotes: [
          {
            repId: collectiveRequired.id,
            calendarProvider: collectiveRequired.calendarProvider,
            calendarExternalAccountId:
              collectiveRequired.calendarExternalAccountId,
            conflictCalendars: collectiveRequired.conflictCalendars.map(
              ({ available: _available, ...calendar }) => calendar,
            ),
          },
          {
            repId: collectiveSecondary.id,
            calendarProvider: collectiveSecondary.calendarProvider,
            calendarExternalAccountId:
              collectiveSecondary.calendarExternalAccountId,
            conflictCalendars: collectiveSecondary.conflictCalendars.map(
              ({ available: _available, ...calendar }) => calendar,
            ),
          },
        ],
      },
      {
        poolId: collectiveEscalationPoolId,
        requiredForAvailability: true,
        candidateQuotes: [
          {
            repId: collectiveRequired.id,
            calendarProvider: collectiveRequired.calendarProvider,
            calendarExternalAccountId:
              collectiveRequired.calendarExternalAccountId,
            conflictCalendars: collectiveRequired.conflictCalendars.map(
              ({ available: _available, ...calendar }) => calendar,
            ),
          },
        ],
      },
    ],
  };
  const collectiveExternalId = randomUUID();
  await repository.enqueuePublicBooking({
    organizationSlug: temporaryOrganizationSlug,
    schedulingSlug: "collective-demo",
    meetingTypeId: collectiveMeetingTypeId,
    candidateQuotes: [collectiveQuote],
    externalId: collectiveExternalId,
    startsAt: new Date("2043-03-10T15:00:00.000Z"),
    endsAt: new Date("2043-03-10T15:30:00.000Z"),
    attendeeName: "Collective Buyer",
    attendeeEmail: "collective-buyer@example.com",
    subject: "Collective demo",
    conferenceProvider: "google_meet",
    reminderMinutes: 0,
  });
  const [collectiveEvidence] = await testDatabase`
    SELECT booking.id, booking.status,
      (SELECT count(*)::int FROM booking_cohosts cohost
       WHERE cohost.booking_id = booking.id) AS cohost_count,
      (SELECT count(*)::int FROM booking_rep_reservations reservation
       WHERE reservation.booking_id = booking.id) AS reservation_count,
      (SELECT count(*)::int FROM booking_rep_reservations reservation
       WHERE reservation.booking_id = booking.id
         AND reservation.rep_id = ${optionalCohostId}) AS optional_reservations,
      (SELECT count(*)::int FROM booking_cohosts cohost
       WHERE cohost.booking_id = booking.id
         AND cohost.source_pool_id = ${collectiveCohostPoolId}
         AND cohost.rep_id = ${secondaryCohostId}) AS primary_pooled_cohosts,
      (SELECT count(*)::int FROM booking_cohosts cohost
       WHERE cohost.booking_id = booking.id
         AND cohost.source_pool_id = ${collectiveEscalationPoolId}
         AND cohost.rep_id = ${requiredCohostId}) AS escalation_pooled_cohosts,
      (SELECT job.payload->'cohostEmails' FROM jobs job
       WHERE job.type = 'calendar.event.create'
         AND job.payload->>'bookingId' = booking.id::text
       ORDER BY job.id DESC LIMIT 1) AS cohost_emails,
      (SELECT job.id FROM jobs job
       WHERE job.type = 'calendar.event.create'
         AND job.payload->>'bookingId' = booking.id::text
       ORDER BY job.id DESC LIMIT 1) AS calendar_job_id,
      (SELECT job.payload->'crmRoleOwners' FROM jobs job
       WHERE job.type = 'calendar.event.create'
         AND job.payload->>'bookingId' = booking.id::text
       ORDER BY job.id DESC LIMIT 1) AS crm_role_owners
    FROM bookings booking
    WHERE booking.organization_id = ${operatorOrganization!.id}
      AND booking.external_id = ${collectiveExternalId}
  `;
  if (!collectiveEvidence?.calendarJobId) {
    throw new Error("Collective booking did not queue its calendar job.");
  }
  const collectiveCalendarClaim = await claimJobForIntegration(
    Number(collectiveEvidence.calendarJobId),
  );
  await repository.completeJob(
    Number(collectiveEvidence.calendarJobId),
    collectiveCalendarClaim,
    {
      externalEventId: `collective-event-${randomUUID()}`,
      webLink: "https://calendar.example/collective",
      conferenceUrl: "https://meet.google.com/collective",
    },
  );
  const [collectiveCrmRoleEvidence] = await testDatabase`
    SELECT payload->'roleOwners' AS role_owners
    FROM jobs
    WHERE type = 'crm.roles.writeback'
      AND payload->>'bookingId' = ${String(collectiveEvidence.id)}
  `;
  await testDatabase`
    DELETE FROM routing_pools WHERE id = ${collectiveCohostPoolId}
  `;
  const [deletedPoolSnapshot] = await testDatabase`
    SELECT source_pool_id, source_pool_name
    FROM booking_cohosts
    WHERE booking_id = ${collectiveEvidence!.id}
      AND rep_id = ${secondaryCohostId}
  `;
  let crossRoleOverlapRejected = false;
  try {
    const overlappingExternalId = randomUUID();
    await testDatabase`
      INSERT INTO bookings (
        organization_id, meeting_type_id, rep_id, external_id,
        manage_token_hash, status, attendee_name, attendee_email,
        attendee_notifications_enabled, starts_at, ends_at,
        calendar_provider, calendar_external_account_id, conference_provider
      ) VALUES (
        ${operatorOrganization!.id}, ${collectiveMeetingTypeId}, ${requiredCohostId},
        ${overlappingExternalId},
        ${createHash("sha256").update(overlappingExternalId).digest("hex")},
        'confirmed', 'Cross-role overlap', 'overlap@example.com', false,
        '2043-03-10T15:00:00.000Z', '2043-03-10T15:30:00.000Z',
        'microsoft', ${collectiveMicrosoftAccountId}, 'none'
      )
    `;
  } catch (error) {
    crossRoleOverlapRejected = (error as { code?: string }).code === "23P01";
  }
  await testDatabase`
    UPDATE bookings SET status = 'cancelled'
    WHERE id = ${collectiveEvidence!.id}
  `;
  const releasedExternalId = randomUUID();
  const [releasedCrossRoleSlot] = await testDatabase`
    INSERT INTO bookings (
      organization_id, meeting_type_id, rep_id, external_id,
      manage_token_hash, status, attendee_name, attendee_email,
      attendee_notifications_enabled, starts_at, ends_at,
      calendar_provider, calendar_external_account_id, conference_provider
    ) VALUES (
      ${operatorOrganization!.id}, ${collectiveMeetingTypeId}, ${requiredCohostId},
      ${releasedExternalId},
      ${createHash("sha256").update(releasedExternalId).digest("hex")},
      'confirmed', 'Released cross-role slot', 'released@example.com', false,
      '2043-03-10T15:00:00.000Z', '2043-03-10T15:30:00.000Z',
      'microsoft', ${collectiveMicrosoftAccountId}, 'none'
    )
    RETURNING id
  `;
  const expectedCrmRoleOwners = [
    {
      propertyName: "technical_owner",
      ownerEmail: secondaryCohostEmail,
    },
    {
      propertyName: "escalation_owner",
      ownerEmail: requiredCohostEmail,
    },
  ];
  const matchesExpectedCrmRoleOwners = (value: unknown) =>
    Array.isArray(value) &&
    value.length === expectedCrmRoleOwners.length &&
    value.every((role, index) => {
      const expected = expectedCrmRoleOwners[index];
      return (
        role &&
        typeof role === "object" &&
        !Array.isArray(role) &&
        (role as Record<string, unknown>).propertyName ===
          expected?.propertyName &&
        (role as Record<string, unknown>).ownerEmail === expected?.ownerEmail
      );
    });
  if (
    collectiveEvidence?.status !== "pending" ||
    Number(collectiveEvidence.cohostCount) !== 3 ||
    Number(collectiveEvidence.reservationCount) !== 3 ||
    Number(collectiveEvidence.optionalReservations) !== 0 ||
    Number(collectiveEvidence.primaryPooledCohosts) !== 1 ||
    Number(collectiveEvidence.escalationPooledCohosts) !== 1 ||
    JSON.stringify(collectiveEvidence.cohostEmails) !==
      JSON.stringify([
        optionalCohostEmail,
        secondaryCohostEmail,
        requiredCohostEmail,
      ]) ||
    !matchesExpectedCrmRoleOwners(collectiveEvidence.crmRoleOwners) ||
    !matchesExpectedCrmRoleOwners(collectiveCrmRoleEvidence?.roleOwners) ||
    deletedPoolSnapshot?.sourcePoolId !== null ||
    deletedPoolSnapshot.sourcePoolName !== "Solutions engineering" ||
    !crossRoleOverlapRejected ||
    !releasedCrossRoleSlot
  ) {
    throw new Error(
      "Collective booking snapshots, invitations, or cross-role reservations were not durable.",
    );
  }
  await testDatabase`
    DELETE FROM bookings
    WHERE id IN (${collectiveEvidence!.id}, ${releasedCrossRoleSlot!.id})
  `;
  await repository.saveMeetingType({
    organizationSlug: temporaryOrganizationSlug,
    id: collectiveMeetingTypeId,
    slug: "collective-demo",
    title: "Collective demo",
    description: "Switch the former co-host pool into the organizer role.",
    durationMinutes: 30,
    minimumNoticeMinutes: 0,
    bookingWindowDays: 365,
    conferenceProvider: "none",
    reminderMinutes: 0,
    active: true,
    targetType: "pool",
    targetId: collectiveEscalationPoolId,
    cohosts: [{ repId: optionalCohostId, requiredForAvailability: false }],
    cohostGroups: [],
  });
  const [switchedCollectiveTarget] = await testDatabase`
    SELECT pool_id,
      (SELECT count(*)::int FROM meeting_type_cohost_groups cohost_group
       WHERE cohost_group.meeting_type_id = meeting_type.id) AS group_count
    FROM meeting_types meeting_type
    WHERE id = ${collectiveMeetingTypeId}
  `;
  if (
    String(switchedCollectiveTarget?.poolId) !== collectiveEscalationPoolId ||
    Number(switchedCollectiveTarget?.groupCount) !== 0
  ) {
    throw new Error(
      "A co-host pool could not be promoted to organizer while removing its old role.",
    );
  }
  const bufferedMeetingTypeId = await repository.saveMeetingType({
    organizationSlug: temporaryOrganizationSlug,
    slug: "protected-conversation",
    title: "Protected conversation",
    description: "A meeting with preparation and recovery time.",
    durationMinutes: 30,
    bufferBeforeMinutes: 15,
    bufferAfterMinutes: 20,
    minimumNoticeMinutes: 0,
    bookingWindowDays: 365,
    conferenceProvider: "none",
    reminderMinutes: 0,
    active: true,
    targetType: "rep",
    targetId: createdRepId,
  });
  const bufferedSchedule = await repository.publicSchedule(
    temporaryOrganizationSlug,
    "protected-conversation",
  );
  if (
    bufferedSchedule?.meetingTypeId !== bufferedMeetingTypeId ||
    bufferedSchedule.bufferBeforeMinutes !== 15 ||
    bufferedSchedule.bufferAfterMinutes !== 20
  ) {
    throw new Error(
      "Meeting buffers were not persisted in the public schedule.",
    );
  }
  const bufferedFirstExternalId = `buffer-first-${randomUUID()}`;
  await repository.enqueuePublicBooking({
    organizationSlug: temporaryOrganizationSlug,
    schedulingSlug: "protected-conversation",
    meetingTypeId: bufferedMeetingTypeId,
    candidateQuotes: [createdRepCalendarQuote],
    externalId: bufferedFirstExternalId,
    startsAt: new Date("2025-01-03T10:00:00.000Z"),
    endsAt: new Date("2025-01-03T10:30:00.000Z"),
    attendeeName: "Buffered First",
    attendeeEmail: "buffered-first@example.com",
    subject: "Protected conversation",
    conferenceProvider: "none",
    reminderMinutes: 0,
  });
  let adjacentBufferRejected = false;
  try {
    await repository.enqueuePublicBooking({
      organizationSlug: temporaryOrganizationSlug,
      schedulingSlug: "protected-conversation",
      meetingTypeId: bufferedMeetingTypeId,
      candidateQuotes: [createdRepCalendarQuote],
      externalId: `buffer-overlap-${randomUUID()}`,
      startsAt: new Date("2025-01-03T10:45:00.000Z"),
      endsAt: new Date("2025-01-03T11:15:00.000Z"),
      attendeeName: "Buffered Overlap",
      attendeeEmail: "buffered-overlap@example.com",
      subject: "Protected conversation",
      conferenceProvider: "none",
      reminderMinutes: 0,
    });
  } catch (error) {
    adjacentBufferRejected = error instanceof CalendarSlotUnavailableError;
  }
  const bufferedBoundaryExternalId = `buffer-boundary-${randomUUID()}`;
  const bufferedBoundary = await repository.enqueuePublicBooking({
    organizationSlug: temporaryOrganizationSlug,
    schedulingSlug: "protected-conversation",
    meetingTypeId: bufferedMeetingTypeId,
    candidateQuotes: [createdRepCalendarQuote],
    externalId: bufferedBoundaryExternalId,
    startsAt: new Date("2025-01-03T11:05:00.000Z"),
    endsAt: new Date("2025-01-03T11:35:00.000Z"),
    attendeeName: "Buffered Boundary",
    attendeeEmail: "buffered-boundary@example.com",
    subject: "Protected conversation",
    conferenceProvider: "none",
    reminderMinutes: 0,
  });
  const [bufferSnapshot] = await testDatabase`
    SELECT buffer_before_minutes, buffer_after_minutes
    FROM bookings
    WHERE organization_id = (
      SELECT id FROM organizations WHERE slug = ${temporaryOrganizationSlug}
    )
      AND external_id = ${bufferedFirstExternalId}
  `;
  if (
    !adjacentBufferRejected ||
    bufferedBoundary.status !== "pending" ||
    Number(bufferSnapshot?.bufferBeforeMinutes) !== 15 ||
    Number(bufferSnapshot?.bufferAfterMinutes) !== 20
  ) {
    throw new Error(
      "Meeting buffers did not protect adjacent bookings at the durable boundary.",
    );
  }

  const guardedMeetingTypeId = await repository.saveMeetingType({
    organizationSlug: temporaryOrganizationSlug,
    slug: "buyer-guardrails",
    title: "Buyer guardrails",
    description: "Concurrency-safe buyer limits and booking change deadlines.",
    durationMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingWindowDays: 365,
    inviteeLimitScope: "domain",
    inviteeLimitCount: 1,
    rescheduleCutoffMinutes: 120,
    cancelCutoffMinutes: 60,
    conferenceProvider: "none",
    reminderMinutes: 0,
    active: true,
    targetType: "rep",
    targetId: createdRepId,
  });
  const guardedAttempts = [
    {
      externalId: randomUUID(),
      startsAt: new Date("2043-05-04T15:00:00.000Z"),
      endsAt: new Date("2043-05-04T15:30:00.000Z"),
      attendeeEmail: "first@Buyer.Test",
    },
    {
      externalId: randomUUID(),
      startsAt: new Date("2043-05-05T15:00:00.000Z"),
      endsAt: new Date("2043-05-05T15:30:00.000Z"),
      attendeeEmail: "second@buyer.test",
    },
  ];
  const guardedResults = await Promise.allSettled(
    guardedAttempts.map((attempt, index) =>
      repository.enqueuePublicBooking({
        organizationSlug: temporaryOrganizationSlug,
        schedulingSlug: "buyer-guardrails",
        meetingTypeId: guardedMeetingTypeId,
        candidateQuotes: [createdRepCalendarQuote],
        externalId: attempt.externalId,
        startsAt: attempt.startsAt,
        endsAt: attempt.endsAt,
        attendeeName: `Guarded buyer ${index + 1}`,
        attendeeEmail: attempt.attendeeEmail,
        subject: "Buyer guardrails",
        conferenceProvider: "none",
        reminderMinutes: 0,
      }),
    ),
  );
  const guardedWinnerIndex = guardedResults.findIndex(
    (result) => result.status === "fulfilled",
  );
  const guardedLoserIndex = guardedResults.findIndex(
    (result) => result.status === "rejected",
  );
  if (
    guardedWinnerIndex < 0 ||
    guardedLoserIndex < 0 ||
    !(guardedResults[guardedLoserIndex] as PromiseRejectedResult).reason ||
    !(
      (guardedResults[guardedLoserIndex] as PromiseRejectedResult)
        .reason instanceof InviteeBookingLimitError
    )
  ) {
    throw new Error(
      "Concurrent exact-domain bookings did not admit exactly one buyer.",
    );
  }
  const guardedWinner = guardedAttempts[guardedWinnerIndex]!;
  const idempotentGuardedWinner = await repository.enqueuePublicBooking({
    organizationSlug: temporaryOrganizationSlug,
    schedulingSlug: "buyer-guardrails",
    meetingTypeId: guardedMeetingTypeId,
    candidateQuotes: [createdRepCalendarQuote],
    externalId: guardedWinner.externalId,
    startsAt: guardedWinner.startsAt,
    endsAt: guardedWinner.endsAt,
    attendeeName: "Guarded buyer retry",
    attendeeEmail: guardedWinner.attendeeEmail,
    subject: "Buyer guardrails",
    conferenceProvider: "none",
    reminderMinutes: 0,
  });
  const guardedManagedBeforeEdit = await repository.managedBooking(
    guardedWinner.externalId,
  );
  const expectedRescheduleDeadline = new Date(
    guardedWinner.startsAt.getTime() - 120 * 60_000,
  ).toISOString();
  const expectedCancelDeadline = new Date(
    guardedWinner.startsAt.getTime() - 60 * 60_000,
  ).toISOString();
  await repository.saveMeetingType({
    organizationSlug: temporaryOrganizationSlug,
    id: guardedMeetingTypeId,
    slug: "buyer-guardrails",
    title: "Buyer guardrails",
    description: "Concurrency-safe buyer limits and booking change deadlines.",
    durationMinutes: 30,
    minimumNoticeMinutes: 0,
    bookingWindowDays: 365,
    inviteeLimitScope: "email",
    inviteeLimitCount: 1,
    rescheduleCutoffMinutes: 0,
    cancelCutoffMinutes: 0,
    conferenceProvider: "none",
    reminderMinutes: 0,
    active: true,
    targetType: "rep",
    targetId: createdRepId,
  });
  const guardedManagedAfterEdit = await repository.managedBooking(
    guardedWinner.externalId,
  );
  if (
    idempotentGuardedWinner.startsAt !== guardedWinner.startsAt.toISOString() ||
    guardedManagedBeforeEdit?.rescheduleAllowedUntil !==
      expectedRescheduleDeadline ||
    guardedManagedBeforeEdit.cancelAllowedUntil !== expectedCancelDeadline ||
    guardedManagedAfterEdit?.rescheduleAllowedUntil !==
      expectedRescheduleDeadline ||
    guardedManagedAfterEdit.cancelAllowedUntil !== expectedCancelDeadline
  ) {
    throw new Error(
      "Invitee-limit retries or booking-snapshotted change deadlines were not durable.",
    );
  }
  await testDatabase`
    UPDATE bookings SET status = 'cancelled'
    WHERE organization_id = ${operatorOrganization!.id}
      AND external_id = ${guardedWinner.externalId}
  `;
  const emailLimitedExternalId = randomUUID();
  await repository.enqueuePublicBooking({
    organizationSlug: temporaryOrganizationSlug,
    schedulingSlug: "buyer-guardrails",
    meetingTypeId: guardedMeetingTypeId,
    candidateQuotes: [createdRepCalendarQuote],
    externalId: emailLimitedExternalId,
    startsAt: new Date("2043-05-06T15:00:00.000Z"),
    endsAt: new Date("2043-05-06T15:30:00.000Z"),
    attendeeName: "Email-limited buyer",
    attendeeEmail: "same.person@buyer.test",
    subject: "Buyer guardrails",
    conferenceProvider: "none",
    reminderMinutes: 0,
  });
  let sameEmailRejected = false;
  try {
    await repository.enqueuePublicBooking({
      organizationSlug: temporaryOrganizationSlug,
      schedulingSlug: "buyer-guardrails",
      meetingTypeId: guardedMeetingTypeId,
      candidateQuotes: [createdRepCalendarQuote],
      externalId: randomUUID(),
      startsAt: new Date("2043-05-07T15:00:00.000Z"),
      endsAt: new Date("2043-05-07T15:30:00.000Z"),
      attendeeName: "Duplicate email buyer",
      attendeeEmail: "SAME.PERSON@BUYER.TEST",
      subject: "Buyer guardrails",
      conferenceProvider: "none",
      reminderMinutes: 0,
    });
  } catch (error) {
    sameEmailRejected =
      error instanceof InviteeBookingLimitError && error.scope === "email";
  }
  const sameDomainDifferentEmail = await repository.enqueuePublicBooking({
    organizationSlug: temporaryOrganizationSlug,
    schedulingSlug: "buyer-guardrails",
    meetingTypeId: guardedMeetingTypeId,
    candidateQuotes: [createdRepCalendarQuote],
    externalId: randomUUID(),
    startsAt: new Date("2043-05-11T15:00:00.000Z"),
    endsAt: new Date("2043-05-11T15:30:00.000Z"),
    attendeeName: "Different email buyer",
    attendeeEmail: "different.person@buyer.test",
    subject: "Buyer guardrails",
    conferenceProvider: "none",
    reminderMinutes: 0,
  });
  const expiredChangeToken = randomUUID();
  const [expiredChangeBooking] = await testDatabase`
    INSERT INTO bookings (
      organization_id, meeting_type_id, rep_id, external_id,
      manage_token_hash, status, attendee_name, attendee_email,
      attendee_notifications_enabled, starts_at, ends_at,
      reschedule_cutoff_minutes, cancel_cutoff_minutes,
      calendar_provider, calendar_external_account_id,
      conference_provider, external_event_id
    ) VALUES (
      ${operatorOrganization!.id}, ${guardedMeetingTypeId}, ${createdRepId},
      ${randomUUID()},
      ${createHash("sha256").update(expiredChangeToken).digest("hex")},
      'confirmed', 'Expired change buyer', 'expired-change@example.com', false,
      now() - interval '2 hours', now() - interval '90 minutes', 0, 0,
      'google', ${integrationGoogleAccountId}, 'none',
      'expired-change-provider-event'
    )
    RETURNING id
  `;
  let expiredRescheduleRejected = false;
  try {
    await repository.requestBookingReschedule({
      manageToken: expiredChangeToken,
      startsAt: new Date("2043-05-12T15:00:00.000Z"),
      endsAt: new Date("2043-05-12T15:30:00.000Z"),
      reminderMinutes: 0,
    });
  } catch (error) {
    expiredRescheduleRejected =
      error instanceof BookingChangeCutoffError &&
      error.action === "reschedule";
  }
  let expiredCancelRejected = false;
  try {
    await repository.requestBookingCancellation(expiredChangeToken);
  } catch (error) {
    expiredCancelRejected =
      error instanceof BookingChangeCutoffError && error.action === "cancel";
  }
  if (
    !sameEmailRejected ||
    sameDomainDifferentEmail.status !== "pending" ||
    !expiredRescheduleRejected ||
    !expiredCancelRejected
  ) {
    throw new Error(
      "Per-email booking limits or authoritative booking-change cutoffs were not enforced.",
    );
  }
  await testDatabase`
    DELETE FROM bookings
    WHERE id = ${expiredChangeBooking!.id}
       OR meeting_type_id = ${guardedMeetingTypeId}
  `;
  const enqueueCreatedRepCalendarBooking = (
    input: Omit<
      Parameters<HotPotatoRepository["enqueueCalendarBooking"]>[0],
      "calendarQuote"
    >,
  ) =>
    repository.enqueueCalendarBooking({
      ...input,
      calendarQuote: createdRepCalendarQuote,
    });
  const createdRouterLinkId = await repository.saveRouterLink({
    organizationSlug: temporaryOrganizationSlug,
    name: "Qualified company router",
    slug: "qualified-company",
    title: "Find the right representative",
    description: "Answer two questions, then choose a time.",
    buttonLabel: "Find my time",
    noMatchMessage: "Thanks — our team will follow up.",
    successRedirectUrl: "https://www.example.com/thank-you?booked=1",
    successRedirectDelaySeconds: 4,
    accentColor: "#f97316",
    active: true,
    questions: [routerQuestion, routerStateQuestion],
    destinations: [
      { poolId: createdPoolId, meetingTypeId: createdMeetingTypeId },
    ],
  });

  const bridgeInput = {
    organizationSlug: temporaryOrganizationSlug,
    routerLinkId: createdRouterLinkId,
    name: "Qualified company website form",
    provider: "hubspot" as const,
    formId: "0f14c75a-b823-4a6e-bf28-7d33d4f6e238",
    allowedOrigins: ["https://www.example.com", "http://127.0.0.1:4173"],
    attendeeNameFields: ["firstname", "lastname"],
    attendeeEmailField: "email",
    answerMappings: {
      "company.employee_count": "employee_count",
      "company.state": "state",
    },
    active: true,
  };
  const createdBridgeId = await repository.saveRouterFormBridge(bridgeInput);
  const bridgeDashboard = await repository.dashboard(temporaryOrganizationSlug);
  const savedBridge = bridgeDashboard.routerFormBridges.find(
    (bridge) => bridge.id === createdBridgeId,
  );
  const savedRouterLink = bridgeDashboard.routerLinks.find(
    (routerLink) => routerLink.id === createdRouterLinkId,
  );
  const publicHubSpotBridge =
    await repository.publicRouterFormBridge(createdBridgeId);
  if (
    savedBridge?.routerLinkName !== "Qualified company router" ||
    savedRouterLink?.successRedirectUrl !==
      "https://www.example.com/thank-you?booked=1" ||
    savedRouterLink.successRedirectDelaySeconds !== 4 ||
    savedBridge.routerLinkSlug !== "qualified-company" ||
    savedBridge.organizationSlug !== temporaryOrganizationSlug ||
    savedBridge.linkConfigVersion !== savedBridge.currentLinkConfigVersion ||
    publicHubSpotBridge?.provider !== "hubspot" ||
    publicHubSpotBridge.formId !== bridgeInput.formId ||
    publicHubSpotBridge.routerPath !==
      `/r/${temporaryOrganizationSlug}/qualified-company` ||
    publicHubSpotBridge.mapping.answerMappings["company.state"] !== "state" ||
    Object.keys(publicHubSpotBridge).sort().join(",") !==
      "allowedOrigins,formId,mapping,provider,routerPath"
  ) {
    throw new Error(
      "A saved HubSpot form bridge was not returned as a minimal, current public config.",
    );
  }

  let incompleteBridgeMappingRejected = false;
  try {
    await repository.saveRouterFormBridge({
      ...bridgeInput,
      name: "Incomplete website form",
      answerMappings: { "company.employee_count": "employee_count" },
    });
  } catch (error) {
    incompleteBridgeMappingRejected =
      error instanceof RouterFormBridgeValidationError;
  }
  if (!incompleteBridgeMappingRejected) {
    throw new Error(
      "A form bridge omitted a current Smart Link question mapping.",
    );
  }

  let unsafeBridgeSourceFieldRejected = false;
  try {
    await repository.saveRouterFormBridge({
      ...bridgeInput,
      name: "Unsafe website form",
      attendeeEmailField: "__proto__",
    });
  } catch (error) {
    unsafeBridgeSourceFieldRejected =
      error instanceof RouterFormBridgeValidationError;
  }
  if (!unsafeBridgeSourceFieldRejected) {
    throw new Error("A form bridge accepted an unsafe source-field name.");
  }

  let crossOrganizationBridgeUpdateRejected = false;
  try {
    await repository.saveRouterFormBridge({
      ...bridgeInput,
      id: createdBridgeId,
      organizationSlug: "acme",
    });
  } catch (error) {
    crossOrganizationBridgeUpdateRejected =
      error instanceof RouterFormBridgeValidationError;
  }
  const crossOrganizationBridgeDelete = await repository.deleteRouterFormBridge(
    "acme",
    createdBridgeId,
  );
  if (!crossOrganizationBridgeUpdateRejected || crossOrganizationBridgeDelete) {
    throw new Error("Form bridge mutation crossed its organization boundary.");
  }

  const updatedBridgeId = await repository.saveRouterFormBridge({
    ...bridgeInput,
    id: createdBridgeId,
    provider: "manual",
    formId: null,
    name: "Qualified company manual form",
    allowedOrigins: ["https://forms.example.com"],
  });
  const publicManualBridge =
    await repository.publicRouterFormBridge(createdBridgeId);
  if (
    updatedBridgeId !== createdBridgeId ||
    publicManualBridge?.provider !== "manual" ||
    publicManualBridge.formId !== null ||
    publicManualBridge.allowedOrigins.join(",") !== "https://forms.example.com"
  ) {
    throw new Error("A form bridge update did not replace its public config.");
  }

  let invalidPublishRejected = false;
  try {
    await repository.saveRouterLink({
      organizationSlug: temporaryOrganizationSlug,
      name: "Invalid published router",
      slug: "invalid-published-router",
      title: "Invalid published router",
      description: "Missing its required routing question.",
      buttonLabel: "Find my time",
      noMatchMessage: "Thanks — our team will follow up.",
      accentColor: "#f97316",
      active: true,
      questions: [],
      destinations: [
        { poolId: createdPoolId, meetingTypeId: createdMeetingTypeId },
      ],
    });
  } catch (error) {
    invalidPublishRejected = error instanceof RouterLinkValidationError;
  }
  if (!invalidPublishRejected) {
    throw new Error("An active Smart Link accepted incomplete rule coverage.");
  }
  await repository.saveRouterLink({
    organizationSlug: temporaryOrganizationSlug,
    name: "Incomplete draft router",
    slug: "incomplete-draft-router",
    title: "Incomplete draft router",
    description: "This link is intentionally not ready to publish.",
    buttonLabel: "Find my time",
    noMatchMessage: "Thanks — our team will follow up.",
    accentColor: "#f97316",
    active: false,
    questions: [],
    destinations: [],
  });

  const publicRouter = await repository.publicRouterLink(
    temporaryOrganizationSlug,
    "qualified-company",
  );
  const crossOrganizationRouter = await repository.publicRouterLink(
    "acme",
    "qualified-company",
  );
  const inactiveRouter = await repository.publicRouterLink(
    temporaryOrganizationSlug,
    "incomplete-draft-router",
  );
  if (
    publicRouter?.id !== createdRouterLinkId ||
    publicRouter.successRedirectUrl !==
      "https://www.example.com/thank-you?booked=1" ||
    publicRouter.successRedirectDelaySeconds !== 4 ||
    crossOrganizationRouter ||
    inactiveRouter
  ) {
    throw new Error(
      "Smart Link public configuration was not organization scoped.",
    );
  }

  let unsafeSuccessRedirectRejected = false;
  try {
    await repository.saveRouterLink({
      organizationSlug: temporaryOrganizationSlug,
      name: "Unsafe redirect router",
      slug: "unsafe-redirect-router",
      title: "Unsafe redirect router",
      description: "This draft attempts an unsafe post-booking redirect.",
      buttonLabel: "Find my time",
      noMatchMessage: "Thanks — our team will follow up.",
      successRedirectUrl: "http://customer.example/thank-you",
      successRedirectDelaySeconds: 5,
      accentColor: "#f97316",
      active: false,
      questions: [],
      destinations: [],
    });
  } catch (error) {
    unsafeSuccessRedirectRejected = error instanceof RouterLinkValidationError;
  }
  if (!unsafeSuccessRedirectRejected) {
    throw new Error("Smart Link accepted an unsafe success redirect.");
  }

  const pausedMeetingTypeId = await repository.saveMeetingType({
    organizationSlug: temporaryOrganizationSlug,
    slug: "paused-email-tool-meeting",
    title: "Paused email tool meeting",
    description: "This meeting type must not appear in an email tool.",
    durationMinutes: 30,
    minimumNoticeMinutes: 0,
    bookingWindowDays: 14,
    conferenceProvider: "none",
    reminderMinutes: 0,
    active: false,
    targetType: "rep",
    targetId: createdRepId,
  });
  const verifiedRep = await repository.repIdentityForVerifiedEmail(
    `  ${temporaryRepEmail.toUpperCase()}  `,
  );
  const emailToolCatalog = await repository.emailToolSchedulingCatalog(
    temporaryOrganizationSlug,
    createdRepId,
  );
  const crossOrganizationCatalog = await repository.emailToolSchedulingCatalog(
    "acme",
    createdRepId,
  );
  const catalogMeetingTypeKeys = emailToolCatalog?.meetingTypes[0]
    ? Object.keys(emailToolCatalog.meetingTypes[0]).sort().join(",")
    : "";
  const catalogRouterLinkKeys = emailToolCatalog?.smartRouterLinks[0]
    ? Object.keys(emailToolCatalog.smartRouterLinks[0]).sort().join(",")
    : "";
  if (
    verifiedRep?.organization.slug !== temporaryOrganizationSlug ||
    verifiedRep.rep.id !== createdRepId ||
    !emailToolCatalog ||
    emailToolCatalog.repId !== createdRepId ||
    emailToolCatalog.recentLinkAssetId !== null ||
    emailToolCatalog.recentMeetingTypeId !== null ||
    emailToolCatalog.recentPurpose !== null ||
    crossOrganizationCatalog !== null ||
    !emailToolCatalog.meetingTypes.some(
      (meetingType) => meetingType.id === createdMeetingTypeId,
    ) ||
    !emailToolCatalog.meetingTypes.some(
      (meetingType) => meetingType.slug === "test-representative",
    ) ||
    emailToolCatalog.meetingTypes.some(
      (meetingType) => meetingType.id === pausedMeetingTypeId,
    ) ||
    !emailToolCatalog.smartRouterLinks.some(
      (routerLink) => routerLink.id === createdRouterLinkId,
    ) ||
    emailToolCatalog.smartRouterLinks.some(
      (routerLink) => routerLink.slug === "incomplete-draft-router",
    ) ||
    catalogMeetingTypeKeys !==
      "conferenceProvider,description,durationMinutes,id,slug,targetName,targetType,title" ||
    catalogRouterLinkKeys !==
      "accentColor,buttonLabel,description,id,slug,title"
  ) {
    throw new Error(
      `Email tool scheduling catalog was not active, usable, minimal, and rep scoped: ${JSON.stringify(
        {
          verifiedRep,
          emailToolCatalog,
          crossOrganizationCatalog,
          pausedMeetingTypeId,
          catalogMeetingTypeKeys,
          catalogRouterLinkKeys,
        },
      )}`,
    );
  }

  const rememberedRouterLink = await repository.rememberEmailToolRecentAsset({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    purpose: "link",
    assetId: createdRouterLinkId,
  });
  const rememberedMeetingType = await repository.rememberEmailToolRecentAsset({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    purpose: "times",
    assetId: createdMeetingTypeId,
  });
  const rejectedRouterTimes = await repository.rememberEmailToolRecentAsset({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    purpose: "times",
    assetId: createdRouterLinkId,
  });
  const rejectedInactiveMeeting = await repository.rememberEmailToolRecentAsset(
    {
      organizationSlug: temporaryOrganizationSlug,
      repId: createdRepId,
      purpose: "times",
      assetId: pausedMeetingTypeId,
    },
  );
  const rejectedCrossOrganizationRecent =
    await repository.rememberEmailToolRecentAsset({
      organizationSlug: "acme",
      repId: createdRepId,
      purpose: "link",
      assetId: createdRouterLinkId,
    });
  const catalogWithRecentAssets = await repository.emailToolSchedulingCatalog(
    temporaryOrganizationSlug,
    createdRepId,
  );
  if (
    !rememberedRouterLink ||
    !rememberedMeetingType ||
    rejectedRouterTimes ||
    rejectedInactiveMeeting ||
    rejectedCrossOrganizationRecent ||
    !catalogWithRecentAssets ||
    catalogWithRecentAssets.recentLinkAssetId !== createdRouterLinkId ||
    catalogWithRecentAssets.recentMeetingTypeId !== createdMeetingTypeId ||
    catalogWithRecentAssets.recentPurpose !== "times"
  ) {
    throw new Error(
      "Email tool recent choices were not active, purpose-specific, and organization scoped.",
    );
  }

  const rawEmailToolToken = `hp-email-tool-${randomUUID()}`;
  const emailToolTokenHash = createHash("sha256")
    .update(rawEmailToolToken)
    .digest("hex");
  let crossOrganizationKeyCreationRejected = false;
  try {
    await repository.createEmailToolAccessKey({
      organizationSlug: "acme",
      repId: createdRepId,
      clientType: "outlook",
      label: "Wrong organization",
      tokenHash: createHash("sha256")
        .update(`wrong-organization-${randomUUID()}`)
        .digest("hex"),
    });
  } catch {
    crossOrganizationKeyCreationRejected = true;
  }
  const createdEmailToolKey = await repository.createEmailToolAccessKey({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    clientType: "gmail",
    label: "  Integration Gmail  ",
    tokenHash: emailToolTokenHash,
  });
  const listedEmailToolKeys = await repository.listEmailToolAccessKeys(
    temporaryOrganizationSlug,
    createdRepId,
  );
  const crossOrganizationKeys = await repository.listEmailToolAccessKeys(
    "acme",
    createdRepId,
  );
  const [storedEmailToolKey] = await testDatabase`
    SELECT token_hash FROM email_tool_access_keys
    WHERE id = ${createdEmailToolKey.id}
  `;
  const resolvedEmailToolKey =
    await repository.resolveEmailToolAccessKey(emailToolTokenHash);
  const listedAfterResolve = await repository.listEmailToolAccessKeys(
    temporaryOrganizationSlug,
    createdRepId,
  );
  const rawTokenResolution =
    await repository.resolveEmailToolAccessKey(rawEmailToolToken);
  const crossOrganizationRevocation = await repository.revokeEmailToolAccessKey(
    {
      organizationSlug: "acme",
      repId: createdRepId,
      keyId: createdEmailToolKey.id,
    },
  );
  const stillResolvedAfterWrongScope =
    await repository.resolveEmailToolAccessKey(emailToolTokenHash);
  if (
    !crossOrganizationKeyCreationRejected ||
    createdEmailToolKey.label !== "Integration Gmail" ||
    createdEmailToolKey.clientType !== "gmail" ||
    listedEmailToolKeys[0]?.id !== createdEmailToolKey.id ||
    crossOrganizationKeys.length !== 0 ||
    storedEmailToolKey?.tokenHash !== emailToolTokenHash ||
    String(storedEmailToolKey?.tokenHash).includes(rawEmailToolToken) ||
    resolvedEmailToolKey?.organization.slug !== temporaryOrganizationSlug ||
    resolvedEmailToolKey.rep.id !== createdRepId ||
    !listedAfterResolve[0]?.lastUsedAt ||
    rawTokenResolution !== null ||
    crossOrganizationRevocation !== null ||
    stillResolvedAfterWrongScope?.keyId !== createdEmailToolKey.id
  ) {
    throw new Error(
      "Email tool access keys were not hashed, resolved, used, and organization scoped.",
    );
  }

  const outlookBootstrapToken = `hp-outlook-bootstrap-${randomUUID()}`;
  const outlookBootstrapTokenHash = createHash("sha256")
    .update(outlookBootstrapToken)
    .digest("hex");
  const outlookBootstrapKey = await repository.createEmailToolAccessKey({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    clientType: "outlook",
    label: "Integration Outlook identity",
    tokenHash: outlookBootstrapTokenHash,
  });
  const outlookPrincipal = {
    tenantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    subject: `outlook-subject-${randomUUID()}`,
    assertedEmail: temporaryRepEmail,
    bootstrapTokenHash: outlookBootstrapTokenHash,
  };
  const gmailKeyCannotBindOutlook = await repository.bindOutlookEmailIdentity({
    ...outlookPrincipal,
    bootstrapTokenHash: emailToolTokenHash,
  });
  const boundOutlookIdentity =
    await repository.bindOutlookEmailIdentity(outlookPrincipal);
  const repeatedOutlookBinding =
    await repository.bindOutlookEmailIdentity(outlookPrincipal);
  const listedAfterOutlookBinding = await repository.listEmailToolAccessKeys(
    temporaryOrganizationSlug,
    createdRepId,
  );
  const resolvedOutlookIdentity =
    await repository.resolveOutlookEmailIdentity(outlookPrincipal);
  const conflictingOutlookBinding = await repository.bindOutlookEmailIdentity({
    ...outlookPrincipal,
    subject: `different-subject-${randomUUID()}`,
  });
  await repository.revokeEmailToolAccessKey({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    keyId: outlookBootstrapKey.id,
  });
  const resolvedOutlookAfterRevocation =
    await repository.resolveOutlookEmailIdentity(outlookPrincipal);
  if (
    gmailKeyCannotBindOutlook !== null ||
    !boundOutlookIdentity?.keyId.startsWith("entra:") ||
    repeatedOutlookBinding?.keyId !== boundOutlookIdentity.keyId ||
    !listedAfterOutlookBinding.find((key) => key.id === outlookBootstrapKey.id)
      ?.outlookIdentityLinked ||
    resolvedOutlookIdentity?.keyId !== boundOutlookIdentity.keyId ||
    resolvedOutlookIdentity.rep.id !== createdRepId ||
    conflictingOutlookBinding !== null ||
    resolvedOutlookAfterRevocation !== null
  ) {
    throw new Error(
      "Outlook identities were not durably scoped, idempotent, conflict-safe, and revocable.",
    );
  }

  const revokedEmailToolKey = await repository.revokeEmailToolAccessKey({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    keyId: createdEmailToolKey.id,
  });
  const repeatedRevocation = await repository.revokeEmailToolAccessKey({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    keyId: createdEmailToolKey.id,
  });
  const resolvedAfterRevocation =
    await repository.resolveEmailToolAccessKey(emailToolTokenHash);
  const listedAfterRevocation = await repository.listEmailToolAccessKeys(
    temporaryOrganizationSlug,
    createdRepId,
  );
  if (
    !revokedEmailToolKey?.revokedAt ||
    repeatedRevocation?.revokedAt?.toISOString() !==
      revokedEmailToolKey.revokedAt.toISOString() ||
    resolvedAfterRevocation !== null ||
    listedAfterRevocation[0]?.revokedAt?.toISOString() !==
      revokedEmailToolKey.revokedAt.toISOString()
  ) {
    throw new Error("Revoked email tool access remained active.");
  }

  await testDatabase`
    INSERT INTO organizations (slug, name)
    VALUES (${secondaryOrganizationSlug}, 'Email tools ambiguity integration')
  `;
  await repository.saveRoutingRep({
    organizationSlug: secondaryOrganizationSlug,
    name: "Ambiguous Representative",
    email: temporaryRepEmail,
    timezone: "UTC",
    weight: 1,
    active: true,
    schedulingSlug: "ambiguous-representative",
  });
  if (
    (await repository.repIdentityForVerifiedEmail(temporaryRepEmail)) !== null
  ) {
    throw new Error(
      "An email shared by multiple organizations resolved ambiguously.",
    );
  }

  const configurationTestNow = new Date("2026-08-24T12:00:00.000Z");
  const staleConfigurationToken = `stale-${randomUUID()}`;
  await repository.qualifyRouterLink({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: staleConfigurationToken,
    attendeeName: "Stale Configuration",
    attendeeEmail: "stale-configuration@example.com",
    answers: { "company.employee_count": 75, "company.state": "NY" },
    now: configurationTestNow,
  });
  await repository.saveRouterLink({
    organizationSlug: temporaryOrganizationSlug,
    id: createdRouterLinkId,
    name: "Qualified company router",
    slug: "qualified-company",
    title: "Find the right representative",
    description: "Answer two questions, then choose a time.",
    buttonLabel: "Find my time",
    noMatchMessage: "Thanks — our team will follow up.",
    accentColor: "#f97316",
    active: true,
    questions: [routerQuestion, routerStateQuestion],
    destinations: [
      { poolId: createdPoolId, meetingTypeId: createdMeetingTypeId },
    ],
  });
  const publicBridgeAfterLinkEdit =
    await repository.publicRouterFormBridge(createdBridgeId);
  const dashboardAfterLinkEdit = await repository.dashboard(
    temporaryOrganizationSlug,
  );
  const staleBridge = dashboardAfterLinkEdit.routerFormBridges.find(
    (bridge) => bridge.id === createdBridgeId,
  );
  if (
    publicBridgeAfterLinkEdit !== null ||
    !staleBridge ||
    staleBridge.linkConfigVersion === staleBridge.currentLinkConfigVersion
  ) {
    throw new Error(
      "A Smart Link edit did not safely invalidate its pinned form bridge.",
    );
  }

  await repository.saveRouterFormBridge({
    ...bridgeInput,
    id: createdBridgeId,
    provider: "manual",
    formId: null,
    name: "Qualified company manual form",
    allowedOrigins: ["https://forms.example.com"],
  });
  const refreshedBridge =
    await repository.publicRouterFormBridge(createdBridgeId);
  const deletedBridge = await repository.deleteRouterFormBridge(
    temporaryOrganizationSlug,
    createdBridgeId,
  );
  const repeatedBridgeDelete = await repository.deleteRouterFormBridge(
    temporaryOrganizationSlug,
    createdBridgeId,
  );
  const deletedPublicBridge =
    await repository.publicRouterFormBridge(createdBridgeId);
  if (
    !refreshedBridge ||
    !deletedBridge ||
    repeatedBridgeDelete ||
    deletedPublicBridge !== null
  ) {
    throw new Error(
      "A refreshed form bridge could not be deleted safely and idempotently.",
    );
  }
  let staleConfigurationRejected = false;
  try {
    await repository.routerLinkSession(
      temporaryOrganizationSlug,
      "qualified-company",
      staleConfigurationToken,
      configurationTestNow,
    );
  } catch (error) {
    staleConfigurationRejected = error instanceof RouterLinkSessionExpiredError;
  }
  if (!staleConfigurationRejected) {
    throw new Error("Smart Link edit did not invalidate its old session.");
  }

  const [temporaryOrganization] = await testDatabase`
    SELECT id FROM organizations WHERE slug = ${temporaryOrganizationSlug}
  `;
  const organizationId = String(temporaryOrganization!.id);
  const [claimFenceJob] = await testDatabase`
    INSERT INTO jobs (organization_id, type, payload)
    VALUES (${organizationId}, 'integration.claim.fence', '{}'::jsonb)
    RETURNING id
  `;
  const staleClaimToken = await claimJobForIntegration(
    Number(claimFenceJob!.id),
  );
  await testDatabase`
    UPDATE jobs
    SET status = 'pending', attempts = 0, locked_at = null, claim_token = null
    WHERE id = ${claimFenceJob!.id}
  `;
  const currentClaimToken = await claimJobForIntegration(
    Number(claimFenceJob!.id),
  );
  const staleCompletion = await repository.completeJob(
    Number(claimFenceJob!.id),
    staleClaimToken,
    { stale: true },
  );
  const staleFailure = await repository.failJob(
    Number(claimFenceJob!.id),
    staleClaimToken,
    "stale worker failure",
  );
  const currentCompletion = await repository.completeJob(
    Number(claimFenceJob!.id),
    currentClaimToken,
    { current: true },
  );
  const [claimFenceEvidence] = await testDatabase`
    SELECT status, attempts, result, last_error
    FROM jobs WHERE id = ${claimFenceJob!.id}
  `;
  if (
    staleCompletion ||
    staleFailure ||
    !currentCompletion ||
    claimFenceEvidence?.status !== "completed" ||
    Number(claimFenceEvidence.attempts) !== 1 ||
    (claimFenceEvidence.result as { current?: boolean } | null)?.current !==
      true ||
    claimFenceEvidence.lastError !== null
  ) {
    throw new Error("A stale worker claim mutated a newer job lifecycle.");
  }
  const routerMetrics = async () => {
    const [metrics] = await testDatabase`
      SELECT
        (SELECT count(*)::int FROM routing_decisions
          WHERE organization_id = ${organizationId}) AS decisions,
        (SELECT count(*)::int FROM bookings
          WHERE organization_id = ${organizationId}) AS bookings,
        (SELECT count(*)::int FROM jobs
          WHERE organization_id = ${organizationId}) AS jobs,
        (SELECT coalesce(sum(ast.assignments), 0)::int
          FROM assignment_state ast
          JOIN routing_pools rp ON rp.id = ast.pool_id
          WHERE rp.organization_id = ${organizationId}) AS assignments
    `;
    return {
      decisions: Number(metrics!.decisions),
      bookings: Number(metrics!.bookings),
      jobs: Number(metrics!.jobs),
      assignments: Number(metrics!.assignments),
    };
  };
  const testNow = new Date("2026-08-24T12:00:00.000Z");
  const beforeQualification = await routerMetrics();
  const matchedSessionToken = `matched-${randomUUID()}`;
  const matchedQualification = await repository.qualifyRouterLink({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: matchedSessionToken,
    attendeeName: "Qualified Buyer",
    attendeeEmail: "qualified-buyer@example.com",
    answers: { "company.employee_count": "75", "company.state": "NY" },
    now: testNow,
  });
  const repeatedMatchedQualification = await repository.qualifyRouterLink({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: matchedSessionToken,
    attendeeName: "Qualified Buyer",
    attendeeEmail: "qualified-buyer@example.com",
    answers: { "company.employee_count": "75", "company.state": "NY" },
    now: testNow,
  });
  const afterQualification = await routerMetrics();
  if (
    matchedQualification.outcome !== "matched" ||
    matchedQualification.matchedRuleName !== "Qualified company" ||
    matchedQualification.poolName !== "Qualified inbound" ||
    repeatedMatchedQualification.matchedRuleName !==
      matchedQualification.matchedRuleName ||
    repeatedMatchedQualification.poolName !== matchedQualification.poolName ||
    JSON.stringify(beforeQualification) !== JSON.stringify(afterQualification)
  ) {
    throw new Error("Qualification changed routing or booking side effects.");
  }
  const session = await repository.routerLinkSession(
    temporaryOrganizationSlug,
    "qualified-company",
    matchedSessionToken,
    testNow,
  );
  if (
    !session ||
    session.matchedRuleName !== "Qualified company" ||
    session.poolName !== "Qualified inbound" ||
    session.schedule.meetingTypeId !== createdMeetingTypeId ||
    session.schedule.reps[0]?.id !== createdRepId
  ) {
    throw new Error("Matched qualification did not resolve its pool schedule.");
  }

  const noMatch = await repository.qualifyRouterLink({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: `no-match-${randomUUID()}`,
    attendeeName: "Small Company",
    attendeeEmail: "small-company@example.com",
    answers: { "company.employee_count": 10, "company.state": "NY" },
    now: testNow,
  });
  if (
    noMatch.outcome !== "no_match" ||
    noMatch.meetingType !== null ||
    noMatch.matchedRuleName !== null ||
    noMatch.poolName !== null
  ) {
    throw new Error(
      "Smart Link no-match qualification returned a destination.",
    );
  }

  const catchAllRuleId = await repository.saveRoutingRule({
    organizationSlug: temporaryOrganizationSlug,
    name: "Every other qualified lead",
    priority: 30,
    conditions: {},
    poolId: createdPoolId,
    active: true,
  });
  let duplicateCatchAllCode: string | null = null;
  let duplicateCatchAllConstraint: string | null = null;
  try {
    await repository.saveRoutingRule({
      organizationSlug: temporaryOrganizationSlug,
      name: "Duplicate catch-all",
      priority: 40,
      conditions: {},
      poolId: createdPoolId,
      active: false,
    });
  } catch (error) {
    duplicateCatchAllCode =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : null;
    duplicateCatchAllConstraint =
      typeof error === "object" && error !== null && "constraint_name" in error
        ? String(error.constraint_name)
        : null;
  }
  const catchAllQualification = await repository.qualifyRouterLink({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: `catch-all-${randomUUID()}`,
    attendeeName: "Unmatched Buyer",
    attendeeEmail: "unmatched-buyer@example.com",
    answers: { "company.employee_count": 10, "company.state": "CA" },
    now: testNow,
  });
  if (
    duplicateCatchAllCode !== "23505" ||
    duplicateCatchAllConstraint !== "routing_rules_one_catch_all_idx" ||
    catchAllQualification.outcome !== "matched" ||
    catchAllQualification.matchedRuleName !== "Every other qualified lead" ||
    catchAllQualification.poolName !== "Qualified inbound" ||
    catchAllQualification.meetingType?.slug !== "qualified-team"
  ) {
    throw new Error(
      "Catch-all routing did not remain unique or resolve the final Smart Link destination.",
    );
  }

  const expiredToken = `expired-${randomUUID()}`;
  await repository.qualifyRouterLink({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: expiredToken,
    attendeeName: "Expired Buyer",
    attendeeEmail: "expired-buyer@example.com",
    answers: { "company.employee_count": 75, "company.state": "NY" },
    now: testNow,
    expiresInMinutes: 1,
  });
  let expiredSessionRejected = false;
  try {
    await repository.routerLinkSession(
      temporaryOrganizationSlug,
      "qualified-company",
      expiredToken,
      new Date(testNow.getTime() + 2 * 60_000),
    );
  } catch (error) {
    expiredSessionRejected = error instanceof RouterLinkSessionExpiredError;
  }
  if (!expiredSessionRejected) {
    throw new Error("Expired Smart Link session remained usable.");
  }

  const expiredAttemptSessionToken = `expired-attempt-${randomUUID()}`;
  await repository.qualifyRouterLink({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: expiredAttemptSessionToken,
    attendeeName: "Expired Attempt Buyer",
    attendeeEmail: "expired-attempt@example.com",
    answers: { "company.employee_count": 75, "company.state": "NY" },
    now: testNow,
  });
  const expiredAttemptToken = `attempt-${randomUUID()}`;
  const preLockNow = new Date(testNow.getTime() - 31_000);
  await repository.beginRouterLinkBookingAttempt({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: expiredAttemptSessionToken,
    attemptToken: expiredAttemptToken,
    startsAt: new Date("2026-08-24T13:00:00.000Z"),
    endsAt: new Date("2026-08-24T13:30:00.000Z"),
    now: preLockNow,
  });
  const expiredAttemptStatus = await repository.routerLinkBookingStatus(
    temporaryOrganizationSlug,
    "qualified-company",
    expiredAttemptSessionToken,
    testNow,
  );
  let clearedAttemptRejected = false;
  try {
    await repository.bookRouterLinkSession({
      organizationSlug: temporaryOrganizationSlug,
      routerSlug: "qualified-company",
      sessionToken: expiredAttemptSessionToken,
      attemptToken: expiredAttemptToken,
      candidateQuotes: [createdRepCalendarQuote],
      startsAt: new Date("2026-08-24T13:00:00.000Z"),
      endsAt: new Date("2026-08-24T13:30:00.000Z"),
      now: preLockNow,
    });
  } catch (error) {
    clearedAttemptRejected = error instanceof RouterLinkConflictError;
  }
  const [clearedAttemptEvidence] = await testDatabase`
    SELECT booking_attempt_token_hash, booking_attempt_starts_at,
           booking_attempt_ends_at, booking_attempt_started_at
    FROM router_qualification_sessions
    WHERE token_hash = ${createHash("sha256")
      .update(expiredAttemptSessionToken)
      .digest("hex")}
  `;
  if (
    expiredAttemptStatus !== null ||
    !clearedAttemptRejected ||
    clearedAttemptEvidence?.bookingAttemptTokenHash !== null ||
    clearedAttemptEvidence.bookingAttemptStartsAt !== null ||
    clearedAttemptEvidence.bookingAttemptEndsAt !== null ||
    clearedAttemptEvidence.bookingAttemptStartedAt !== null
  ) {
    throw new Error(
      "Expired attempt status did not fence a pre-lock booking owner.",
    );
  }

  const rateIdentifier = `198.51.100.9:${randomUUID()}`;
  const firstRate = await repository.consumePublicRateLimit({
    organizationSlug: temporaryOrganizationSlug,
    scope: "integration_router",
    identifier: rateIdentifier,
    limit: 1,
    windowSeconds: 60,
    now: testNow,
  });
  const secondRate = await repository.consumePublicRateLimit({
    organizationSlug: temporaryOrganizationSlug,
    scope: "integration_router",
    identifier: rateIdentifier,
    limit: 1,
    windowSeconds: 60,
    now: testNow,
  });
  const [rateBucket] = await testDatabase`
    SELECT key_hash, requests FROM public_rate_limit_buckets
    WHERE organization_id = ${organizationId} AND scope = 'integration_router'
  `;
  if (
    !firstRate.allowed ||
    secondRate.allowed ||
    Number(rateBucket?.requests) !== 2 ||
    String(rateBucket?.keyHash).includes(rateIdentifier)
  ) {
    throw new Error("Hashed public rate limiting did not enforce its bucket.");
  }

  const bookingStartsAt = new Date("2026-08-24T13:00:00.000Z");
  const bookingEndsAt = new Date("2026-08-24T13:30:00.000Z");
  const bookingAttemptToken = `attempt-${randomUUID()}`;
  const bookingAttempt = await repository.beginRouterLinkBookingAttempt({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: matchedSessionToken,
    attemptToken: bookingAttemptToken,
    startsAt: bookingStartsAt,
    endsAt: bookingEndsAt,
    now: testNow,
  });
  const activeAttemptStatus = await repository.routerLinkBookingStatus(
    temporaryOrganizationSlug,
    "qualified-company",
    matchedSessionToken,
    testNow,
  );
  const concurrentAttempt = await repository.beginRouterLinkBookingAttempt({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: matchedSessionToken,
    attemptToken: `attempt-${randomUUID()}`,
    startsAt: new Date("2026-08-24T14:00:00.000Z"),
    endsAt: new Date("2026-08-24T14:30:00.000Z"),
    now: testNow,
  });
  if (
    !bookingAttempt.acquired ||
    activeAttemptStatus?.status !== "attempting" ||
    activeAttemptStatus.startsAt !== bookingStartsAt.toISOString() ||
    activeAttemptStatus.endsAt !== bookingEndsAt.toISOString() ||
    concurrentAttempt.acquired ||
    concurrentAttempt.booking.status !== "attempting" ||
    concurrentAttempt.booking.startsAt !== bookingStartsAt.toISOString() ||
    concurrentAttempt.booking.endsAt !== bookingEndsAt.toISOString()
  ) {
    throw new Error(
      "Concurrent Smart Link requests did not share one authoritative attempt.",
    );
  }
  const [booked, repeatedBooking] = await Promise.all([
    repository.bookRouterLinkSession({
      organizationSlug: temporaryOrganizationSlug,
      routerSlug: "qualified-company",
      sessionToken: matchedSessionToken,
      attemptToken: bookingAttemptToken,
      candidateQuotes: [createdRepCalendarQuote],
      startsAt: bookingStartsAt,
      endsAt: bookingEndsAt,
      additionalAttendeeEmails: [
        "guest-one@example.com",
        "QUALIFIED-BUYER@example.com",
        "guest-one@example.com",
      ],
      now: testNow,
    }),
    repository.bookRouterLinkSession({
      organizationSlug: temporaryOrganizationSlug,
      routerSlug: "qualified-company",
      sessionToken: matchedSessionToken,
      attemptToken: bookingAttemptToken,
      candidateQuotes: [createdRepCalendarQuote],
      startsAt: bookingStartsAt,
      endsAt: bookingEndsAt,
      additionalAttendeeEmails: [
        "guest-one@example.com",
        "QUALIFIED-BUYER@example.com",
        "guest-one@example.com",
      ],
      now: testNow,
    }),
  ]);
  const afterBooking = await routerMetrics();
  const [bookingEvidence] = await testDatabase`
    SELECT b.id, b.routing_decision_id, b.calendar_external_account_id,
      b.additional_attendee_emails,
      s.booked_at,
      (SELECT count(*)::int FROM jobs j
        WHERE j.organization_id = b.organization_id
          AND j.type = 'crm.owner.writeback'
          AND j.payload->>'decisionId' = b.routing_decision_id::text) AS crm_jobs,
      (SELECT count(*)::int FROM jobs j
        WHERE j.organization_id = b.organization_id
          AND j.type = 'calendar.event.create'
          AND j.payload->>'bookingId' = b.id::text) AS calendar_jobs
      ,(SELECT min(j.payload->>'calendarExternalAccountId') FROM jobs j
        WHERE j.organization_id = b.organization_id
          AND j.type = 'calendar.event.create'
          AND j.payload->>'bookingId' = b.id::text) AS job_calendar_external_account_id,
      (SELECT j.payload->'additionalAttendeeEmails' FROM jobs j
        WHERE j.organization_id = b.organization_id
          AND j.type = 'calendar.event.create'
          AND j.payload->>'bookingId' = b.id::text
        LIMIT 1) AS job_additional_attendee_emails
    FROM bookings b
    JOIN router_qualification_sessions s ON s.id = b.router_session_id
    WHERE b.organization_id = ${organizationId}
      AND b.attendee_email = 'qualified-buyer@example.com'
  `;
  if (
    booked.status !== "pending" ||
    booked.managePath !== repeatedBooking.managePath ||
    afterBooking.decisions !== beforeQualification.decisions + 1 ||
    afterBooking.bookings !== beforeQualification.bookings + 1 ||
    afterBooking.jobs !== beforeQualification.jobs + 2 ||
    afterBooking.assignments !== beforeQualification.assignments + 1 ||
    Number(bookingEvidence?.crmJobs) !== 1 ||
    Number(bookingEvidence?.calendarJobs) !== 1 ||
    JSON.stringify(bookingEvidence?.additionalAttendeeEmails) !==
      JSON.stringify(["guest-one@example.com"]) ||
    JSON.stringify(bookingEvidence?.jobAdditionalAttendeeEmails) !==
      JSON.stringify(["guest-one@example.com"]) ||
    bookingEvidence?.calendarExternalAccountId !== integrationGoogleAccountId ||
    bookingEvidence.jobCalendarExternalAccountId !==
      integrationGoogleAccountId ||
    !bookingEvidence?.bookedAt
  ) {
    throw new Error("Smart Link booking was not atomic and exactly once.");
  }

  const staleQuoteSessionToken = `stale-quote-${randomUUID()}`;
  const staleQuoteAttemptToken = `attempt-${randomUUID()}`;
  const staleQuoteStartsAt = new Date("2026-08-24T17:00:00.000Z");
  const staleQuoteEndsAt = new Date("2026-08-24T17:30:00.000Z");
  await repository.qualifyRouterLink({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: staleQuoteSessionToken,
    attendeeName: "Stale Quote Buyer",
    attendeeEmail: "stale-quote@example.com",
    answers: { "company.employee_count": 75, "company.state": "NY" },
    now: testNow,
  });
  await repository.beginRouterLinkBookingAttempt({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: staleQuoteSessionToken,
    attemptToken: staleQuoteAttemptToken,
    startsAt: staleQuoteStartsAt,
    endsAt: staleQuoteEndsAt,
    now: testNow,
  });
  const preQuoteReconnect = await repository.getRepCalendarConnection(
    temporaryOrganizationSlug,
    createdRepId,
    "google",
  );
  if (!preQuoteReconnect) throw new Error("Google quote connection not found.");
  await repository.saveRepCalendarConnection(
    {
      ...preQuoteReconnect,
      encryptedAccessToken: "quote-race-reconnected-access",
      encryptedRefreshToken: "quote-race-reconnected-refresh",
      externalAccountId: integrationQuoteRaceAccountId,
      externalAccountName: "Quote race reconnected account",
    },
    { preserveCalendarSources: true },
  );
  let staleAccountQuoteRejected = false;
  try {
    await repository.bookRouterLinkSession({
      organizationSlug: temporaryOrganizationSlug,
      routerSlug: "qualified-company",
      sessionToken: staleQuoteSessionToken,
      attemptToken: staleQuoteAttemptToken,
      candidateQuotes: [createdRepCalendarQuote],
      startsAt: staleQuoteStartsAt,
      endsAt: staleQuoteEndsAt,
      now: testNow,
    });
  } catch (error) {
    staleAccountQuoteRejected = error instanceof CalendarSlotUnavailableError;
  } finally {
    await repository.saveRepCalendarConnection(
      {
        ...preQuoteReconnect,
        encryptedAccessToken: "integration-access-token",
        encryptedRefreshToken: "integration-refresh-token",
      },
      { preserveCalendarSources: true },
    );
    await repository.syncRepCalendarSources({
      organizationSlug: temporaryOrganizationSlug,
      repId: createdRepId,
      provider: "google",
      calendars: [
        { id: "primary", name: "Work calendar", isDefault: true },
        {
          id: "google-secondary",
          name: "Customer calls",
          isDefault: false,
        },
      ],
    });
    await repository.updateRepCalendarSettings({
      organizationSlug: temporaryOrganizationSlug,
      repId: createdRepId,
      provider: "google",
      selectedCalendarIds: ["primary", "google-secondary"],
    });
    await repository.releaseRouterLinkBookingAttempt(
      temporaryOrganizationSlug,
      "qualified-company",
      staleQuoteSessionToken,
      staleQuoteAttemptToken,
    );
  }
  const [staleQuoteBooking] = await testDatabase`
    SELECT b.id
    FROM bookings b
    JOIN router_qualification_sessions s ON s.id = b.router_session_id
    WHERE s.token_hash = ${createHash("sha256")
      .update(staleQuoteSessionToken)
      .digest("hex")}
  `;
  if (!staleAccountQuoteRejected || staleQuoteBooking) {
    throw new Error(
      "A calendar account switch after availability produced a booking.",
    );
  }

  const overlapToken = `overlap-${randomUUID()}`;
  await repository.qualifyRouterLink({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: overlapToken,
    attendeeName: "Overlap Buyer",
    attendeeEmail: "overlap-buyer@example.com",
    answers: { "company.employee_count": 75, "company.state": "NY" },
    now: testNow,
  });
  let overlapRejected = false;
  const staleOverlapAttemptToken = `attempt-${randomUUID()}`;
  const overlapAttemptToken = `attempt-${randomUUID()}`;
  await repository.beginRouterLinkBookingAttempt({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: overlapToken,
    attemptToken: staleOverlapAttemptToken,
    startsAt: new Date("2026-08-24T13:15:00.000Z"),
    endsAt: new Date("2026-08-24T13:45:00.000Z"),
    now: new Date(testNow.getTime() - 31_000),
  });
  await repository.beginRouterLinkBookingAttempt({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: overlapToken,
    attemptToken: overlapAttemptToken,
    startsAt: new Date("2026-08-24T13:15:00.000Z"),
    endsAt: new Date("2026-08-24T13:45:00.000Z"),
    now: testNow,
  });
  let staleAttemptRejected = false;
  try {
    await repository.bookRouterLinkSession({
      organizationSlug: temporaryOrganizationSlug,
      routerSlug: "qualified-company",
      sessionToken: overlapToken,
      attemptToken: staleOverlapAttemptToken,
      candidateQuotes: [createdRepCalendarQuote],
      startsAt: new Date("2026-08-24T13:15:00.000Z"),
      endsAt: new Date("2026-08-24T13:45:00.000Z"),
      now: testNow,
    });
  } catch (error) {
    staleAttemptRejected = error instanceof RouterLinkConflictError;
  }
  try {
    await repository.bookRouterLinkSession({
      organizationSlug: temporaryOrganizationSlug,
      routerSlug: "qualified-company",
      sessionToken: overlapToken,
      attemptToken: overlapAttemptToken,
      candidateQuotes: [createdRepCalendarQuote],
      startsAt: new Date("2026-08-24T13:15:00.000Z"),
      endsAt: new Date("2026-08-24T13:45:00.000Z"),
      now: testNow,
    });
  } catch (error) {
    overlapRejected = error instanceof CalendarSlotUnavailableError;
  }
  if (
    !staleAttemptRejected ||
    !overlapRejected ||
    JSON.stringify(await routerMetrics()) !== JSON.stringify(afterBooking)
  ) {
    throw new Error(
      "Overlapping Smart Link booking was not rejected atomically.",
    );
  }

  const legacyAExternalId = `legacy-a-${randomUUID()}`;
  const legacyBExternalId = `legacy-b-${randomUUID()}`;
  const legacyDecisionA = await repository.route({
    organizationSlug: temporaryOrganizationSlug,
    externalId: `legacy-route-a-${randomUUID()}`,
    lead: {
      name: "Legacy Buyer A",
      email: "legacy-a@example.com",
      company: { employee_count: 75, state: "NY" },
    },
    now: testNow,
  });
  const legacyDecisionB = await repository.route({
    organizationSlug: temporaryOrganizationSlug,
    externalId: `legacy-route-b-${randomUUID()}`,
    lead: {
      name: "Legacy Buyer B",
      email: "legacy-b@example.com",
      company: { employee_count: 75, state: "NY" },
    },
    now: testNow,
  });
  const legacyBookingResults = await Promise.allSettled([
    enqueueCreatedRepCalendarBooking({
      organizationSlug: temporaryOrganizationSlug,
      externalId: legacyAExternalId,
      decisionId: legacyDecisionA.id,
      startsAt: new Date("2026-08-24T14:00:00.000Z"),
      endsAt: new Date("2026-08-24T14:30:00.000Z"),
      subject: "Legacy dashboard booking",
      provider: "google",
    }),
    enqueueCreatedRepCalendarBooking({
      organizationSlug: temporaryOrganizationSlug,
      externalId: legacyBExternalId,
      decisionId: legacyDecisionB.id,
      startsAt: new Date("2026-08-24T14:00:00.000Z"),
      endsAt: new Date("2026-08-24T14:30:00.000Z"),
      subject: "Legacy dashboard booking",
      provider: "google",
    }),
  ]);
  if (
    legacyBookingResults.filter((result) => result.status === "fulfilled")
      .length !== 1 ||
    legacyBookingResults.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof CalendarSlotUnavailableError,
    ).length !== 1
  ) {
    throw new Error(
      `Concurrent dashboard bookings bypassed the calendar slot guard: ${JSON.stringify(
        legacyBookingResults.map((result) =>
          result.status === "fulfilled"
            ? { status: result.status, value: result.value }
            : {
                status: result.status,
                name:
                  result.reason instanceof Error
                    ? result.reason.name
                    : "Unknown error",
                message:
                  result.reason instanceof Error
                    ? result.reason.message
                    : String(result.reason),
              },
        ),
      )}`,
    );
  }

  const [legacyBookingEvidence] = await testDatabase`
    SELECT b.id, b.external_id, b.source_external_id, b.manage_token_hash,
           b.routing_decision_id, j.id AS job_id,
           j.payload->>'bookingId' AS job_booking_id,
           j.payload->>'externalId' AS job_external_id,
           j.payload->>'sourceExternalId' AS job_source_external_id,
           b.attendee_name, b.attendee_email,
           b.attendee_notifications_enabled,
           b.calendar_external_account_id,
           j.payload->>'calendarExternalAccountId' AS job_calendar_external_account_id,
           j.payload->>'attendeeNotificationsEnabled' AS job_notifications_enabled,
           j.payload->>'attendeeEmail' AS job_attendee_email
    FROM bookings b
    JOIN jobs j
      ON j.organization_id = b.organization_id
     AND j.type = 'calendar.event.create'
     AND j.payload->>'bookingId' = b.id::text
    WHERE b.organization_id = ${organizationId}
      AND b.source_external_id IN (${legacyAExternalId}, ${legacyBExternalId})
  `;
  if (
    !legacyBookingEvidence ||
    String(legacyBookingEvidence.jobBookingId) !==
      String(legacyBookingEvidence.id) ||
    ![legacyAExternalId, legacyBExternalId].includes(
      String(legacyBookingEvidence.sourceExternalId),
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(legacyBookingEvidence.externalId),
    ) ||
    legacyBookingEvidence.externalId ===
      legacyBookingEvidence.sourceExternalId ||
    legacyBookingEvidence.manageTokenHash !==
      createHash("sha256")
        .update(String(legacyBookingEvidence.externalId))
        .digest("hex") ||
    legacyBookingEvidence.jobExternalId !== legacyBookingEvidence.externalId ||
    legacyBookingEvidence.jobSourceExternalId !==
      legacyBookingEvidence.sourceExternalId ||
    ![legacyDecisionA.id, legacyDecisionB.id].includes(
      String(legacyBookingEvidence.routingDecisionId),
    ) ||
    !["Legacy Buyer A", "Legacy Buyer B"].includes(
      String(legacyBookingEvidence.attendeeName),
    ) ||
    !["legacy-a@example.com", "legacy-b@example.com"].includes(
      String(legacyBookingEvidence.attendeeEmail),
    ) ||
    legacyBookingEvidence.attendeeNotificationsEnabled !== false ||
    legacyBookingEvidence.calendarExternalAccountId !==
      integrationGoogleAccountId ||
    legacyBookingEvidence.jobCalendarExternalAccountId !==
      integrationGoogleAccountId ||
    legacyBookingEvidence.jobNotificationsEnabled !== "false" ||
    legacyBookingEvidence.jobAttendeeEmail !== null
  ) {
    throw new Error(
      "Dashboard booking did not create a durable lifecycle ledger record.",
    );
  }
  const repeatedLegacy = await enqueueCreatedRepCalendarBooking({
    organizationSlug: temporaryOrganizationSlug,
    externalId: String(legacyBookingEvidence.sourceExternalId),
    decisionId: String(legacyBookingEvidence.routingDecisionId),
    startsAt: new Date("2026-08-24T14:00:00.000Z"),
    endsAt: new Date("2026-08-24T14:30:00.000Z"),
    subject: "Legacy dashboard booking",
    provider: "google",
  });
  const lookedUpLegacy = await repository.bookingByExternalId(
    temporaryOrganizationSlug,
    String(legacyBookingEvidence.sourceExternalId),
  );
  if (
    repeatedLegacy.id !== Number(legacyBookingEvidence.jobId) ||
    lookedUpLegacy?.id !== repeatedLegacy.id ||
    lookedUpLegacy.managePath !==
      `/schedule/manage/${String(legacyBookingEvidence.externalId)}`
  ) {
    throw new Error("Dashboard booking external ID was not idempotent.");
  }
  const legacyBookingClaim = await claimJobForIntegration(
    Number(legacyBookingEvidence.jobId),
  );
  await repository.completeJob(
    Number(legacyBookingEvidence.jobId),
    legacyBookingClaim,
    {
      externalEventId: "integration-legacy-event",
      webLink: "https://calendar.example.com/integration-legacy-event",
    },
  );
  const completedLegacy = await repository.bookingByExternalId(
    temporaryOrganizationSlug,
    String(legacyBookingEvidence.sourceExternalId),
  );
  const [completedLegacyEvidence] = await testDatabase`
    SELECT b.status, b.external_event_id,
      (SELECT count(*)::int FROM jobs message
       WHERE message.type LIKE 'email.booking.%'
         AND message.payload->>'bookingId' = b.id::text) AS confirmations
    FROM bookings b
    WHERE b.id = ${legacyBookingEvidence.id}
  `;
  if (
    completedLegacy?.status !== "completed" ||
    completedLegacy.externalEventId !== "integration-legacy-event" ||
    completedLegacyEvidence?.status !== "confirmed" ||
    completedLegacyEvidence.externalEventId !== "integration-legacy-event" ||
    Number(completedLegacyEvidence.confirmations) !== 0
  ) {
    throw new Error("Dashboard booking did not complete its full lifecycle.");
  }
  const confirmedBusyRetry = await enqueueCreatedRepCalendarBooking({
    organizationSlug: temporaryOrganizationSlug,
    externalId: String(legacyBookingEvidence.sourceExternalId),
    decisionId: String(legacyBookingEvidence.routingDecisionId),
    startsAt: new Date("2026-08-24T14:00:00.000Z"),
    endsAt: new Date("2026-08-24T14:30:00.000Z"),
    subject: "Legacy dashboard booking",
    provider: "google",
  });
  if (
    confirmedBusyRetry.id !== Number(legacyBookingEvidence.jobId) ||
    confirmedBusyRetry.status !== "completed" ||
    confirmedBusyRetry.managePath !==
      `/schedule/manage/${String(legacyBookingEvidence.externalId)}`
  ) {
    throw new Error(
      "A confirmed dashboard idempotency retry checked the occupied slot before returning its original booking.",
    );
  }

  let legacyPublicOverlapRejected = false;
  try {
    await repository.enqueuePublicBooking({
      organizationSlug: temporaryOrganizationSlug,
      schedulingSlug: "qualified-team",
      meetingTypeId: createdMeetingTypeId,
      candidateQuotes: [createdRepCalendarQuote],
      externalId: `public-overlap-${randomUUID()}`,
      startsAt: new Date("2026-08-24T14:15:00.000Z"),
      endsAt: new Date("2026-08-24T14:45:00.000Z"),
      attendeeName: "Public Overlap",
      attendeeEmail: "public-overlap@example.com",
      subject: "Public overlap",
      conferenceProvider: "none",
      reminderMinutes: 0,
    });
  } catch (error) {
    legacyPublicOverlapRejected = error instanceof CalendarSlotUnavailableError;
  }
  if (!legacyPublicOverlapRejected) {
    throw new Error("A public booking overlapped a dashboard booking.");
  }

  await repository.requestBookingCancellation(
    String(legacyBookingEvidence.externalId),
  );
  const [legacyCancellationJob] = await testDatabase`
    SELECT id, payload->>'calendarExternalAccountId' AS calendar_external_account_id
    FROM jobs
    WHERE type = 'calendar.event.cancel'
      AND payload->>'bookingId' = ${String(legacyBookingEvidence.id)}
  `;
  if (
    !legacyCancellationJob ||
    legacyCancellationJob.calendarExternalAccountId !==
      integrationGoogleAccountId
  ) {
    throw new Error("Dashboard booking did not queue its cancellation.");
  }
  const legacyCancellationClaim = await claimJobForIntegration(
    Number(legacyCancellationJob.id),
  );
  await repository.completeJob(
    Number(legacyCancellationJob.id),
    legacyCancellationClaim,
    { externalEventId: "integration-legacy-event" },
  );
  const [suppressedLifecycleMessages] = await testDatabase`
    SELECT count(*)::int AS messages
    FROM jobs
    WHERE type LIKE 'email.booking.%'
      AND payload->>'bookingId' = ${String(legacyBookingEvidence.id)}
  `;
  if (Number(suppressedLifecycleMessages?.messages) !== 0) {
    throw new Error(
      "A dashboard booking without notification intent queued lifecycle email.",
    );
  }

  const legacyNullManageToken = `legacy-null-${randomUUID()}`;
  const legacyNullStartsAt = new Date("2026-08-28T14:00:00.000Z");
  const legacyNullEndsAt = new Date("2026-08-28T14:30:00.000Z");
  const legacyNullEventId = "integration-legacy-null-event";
  const [legacyNullBooking] = await testDatabase`
    INSERT INTO bookings (
      organization_id, meeting_type_id, rep_id, external_id,
      manage_token_hash, status, attendee_name, attendee_email,
      attendee_notifications_enabled, starts_at, ends_at,
      calendar_provider, calendar_external_account_id,
      conference_provider, external_event_id
    ) VALUES (
      ${organizationId}, ${createdMeetingTypeId}, ${createdRepId},
      ${legacyNullManageToken},
      ${createHash("sha256").update(legacyNullManageToken).digest("hex")},
      'confirmed', 'Legacy Null Booking', 'legacy-null@example.com', false,
      ${legacyNullStartsAt}, ${legacyNullEndsAt},
      'google', null, 'none', ${legacyNullEventId}
    )
    RETURNING id
  `;
  await testDatabase`
    INSERT INTO jobs (
      organization_id, type, payload, status, result, completed_at
    ) VALUES (
      ${organizationId}, 'calendar.event.create',
      ${testDatabase.json({
        bookingId: String(legacyNullBooking!.id),
        externalId: legacyNullManageToken,
        organizationSlug: temporaryOrganizationSlug,
        schedulingSlug: "test-representative",
        repId: createdRepId,
        provider: "google",
        startsAt: legacyNullStartsAt.toISOString(),
        endsAt: legacyNullEndsAt.toISOString(),
        attendeeNotificationsEnabled: false,
      })},
      'completed', ${testDatabase.json({ externalEventId: legacyNullEventId })},
      now()
    )
  `;
  const nullBoundReconnectProbe = `null-bound-reconnect-${randomUUID()}`;
  const [nullBoundReconnectBooking] = await testDatabase`
    INSERT INTO bookings (
      organization_id, meeting_type_id, rep_id, external_id,
      manage_token_hash, status, attendee_name, attendee_email,
      attendee_notifications_enabled, starts_at, ends_at,
      calendar_provider, calendar_external_account_id, conference_provider,
      last_error
    ) VALUES (
      ${organizationId}, ${createdMeetingTypeId}, ${createdRepId},
      ${nullBoundReconnectProbe},
      ${createHash("sha256").update(nullBoundReconnectProbe).digest("hex")},
      'failed', 'Unproven Future Booking', 'unproven-future@example.com', false,
      '2032-08-28T14:00:00.000Z', '2032-08-28T14:30:00.000Z',
      'google', null, 'none', 'calendar account identity is unproven'
    )
    RETURNING id
  `;
  const nullBoundAccount = await repository.getRepCalendarConnection(
    temporaryOrganizationSlug,
    createdRepId,
    "google",
  );
  if (!nullBoundAccount) throw new Error("Calendar account was not found.");
  let nullBoundReconnectRejected = false;
  try {
    await repository.saveRepCalendarConnection(
      {
        ...nullBoundAccount,
        encryptedAccessToken: "unproven-account-b-access",
        encryptedRefreshToken: "unproven-account-b-refresh",
        externalAccountId: integrationUnprovenAccountBId,
        externalAccountName: "Unproven account B",
      },
      { preserveCalendarSources: true },
    );
  } catch (error) {
    nullBoundReconnectRejected = error instanceof CalendarAccountIdentityError;
  }
  const accountAfterNullBoundReconnect =
    await repository.getRepCalendarConnection(
      temporaryOrganizationSlug,
      createdRepId,
      "google",
    );
  await testDatabase`
    UPDATE rep_calendar_connections
    SET external_account_id = NULL
    WHERE rep_id = ${createdRepId} AND provider = 'google'
  `;
  const unidentifiedConnection = await repository.getRepCalendarConnection(
    temporaryOrganizationSlug,
    createdRepId,
    "google",
  );
  if (!unidentifiedConnection) {
    throw new Error("Unidentified calendar connection was not found.");
  }
  let unidentifiedReconnectRejected = false;
  try {
    await repository.saveRepCalendarConnection(
      {
        ...unidentifiedConnection,
        encryptedAccessToken: "identified-account-b-access",
        encryptedRefreshToken: "identified-account-b-refresh",
        externalAccountId: integrationIdentifiedAccountBId,
        externalAccountName: "Identified account B",
      },
      { preserveCalendarSources: true },
    );
  } catch (error) {
    unidentifiedReconnectRejected =
      error instanceof CalendarAccountIdentityError;
  }
  const connectionAfterUnidentifiedReconnect =
    await repository.getRepCalendarConnection(
      temporaryOrganizationSlug,
      createdRepId,
      "google",
    );
  if (
    !nullBoundReconnectRejected ||
    accountAfterNullBoundReconnect?.externalAccountId !==
      integrationGoogleAccountId ||
    unidentifiedReconnectRejected ||
    connectionAfterUnidentifiedReconnect?.externalAccountId !==
      integrationIdentifiedAccountBId ||
    connectionAfterUnidentifiedReconnect.encryptedRefreshToken !==
      "identified-account-b-refresh"
  ) {
    throw new Error(
      "Calendar reconnect did not protect a known account or identify an unknown legacy connection safely.",
    );
  }
  await testDatabase`
    DELETE FROM bookings WHERE id = ${nullBoundReconnectBooking!.id}
  `;
  await repository.saveRepCalendarConnection(
    {
      ...connectionAfterUnidentifiedReconnect,
      encryptedAccessToken: "integration-access-token",
      encryptedRefreshToken: "integration-refresh-token",
      externalAccountId: integrationGoogleAccountId,
      externalAccountName: "Integration calendar",
      metadata: {},
    },
    { preserveCalendarSources: true },
  );
  await repository.syncRepCalendarSources({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "google",
    calendars: [
      { id: "primary", name: "Work calendar", isDefault: true },
      {
        id: "google-secondary",
        name: "Customer calls",
        isDefault: false,
      },
    ],
  });
  await repository.updateRepCalendarSettings({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "google",
    selectedCalendarIds: ["primary", "google-secondary"],
  });
  const legacyNullManaged = await repository.managedBooking(
    legacyNullManageToken,
  );
  const legacyNullRepairContext =
    await repository.legacyBookingCalendarAccountRepairContext(
      legacyNullManageToken,
    );
  if (
    legacyNullManaged?.calendarExternalAccountId !== null ||
    legacyNullManaged.rescheduleSchedule !== null ||
    legacyNullRepairContext?.calendarProvider !== "google" ||
    legacyNullRepairContext.currentCalendarExternalAccountId !==
      integrationGoogleAccountId ||
    legacyNullRepairContext.transactionId !== legacyNullManageToken ||
    legacyNullRepairContext.externalEventId !== legacyNullEventId ||
    legacyNullRepairContext.startsAt !== legacyNullStartsAt.toISOString() ||
    legacyNullRepairContext.endsAt !== legacyNullEndsAt.toISOString()
  ) {
    throw new Error(
      "A legacy NULL booking did not expose fail-closed provider-proof repair context.",
    );
  }
  let legacyNullCancelRejected = false;
  try {
    await repository.requestBookingCancellation(legacyNullManageToken);
  } catch (error) {
    legacyNullCancelRejected = error instanceof CalendarAccountIdentityError;
  }
  let legacyNullRescheduleRejected = false;
  try {
    await repository.requestBookingReschedule({
      manageToken: legacyNullManageToken,
      startsAt: new Date("2026-08-28T15:00:00.000Z"),
      endsAt: new Date("2026-08-28T15:30:00.000Z"),
      reminderMinutes: 0,
      calendarQuote: createdRepCalendarQuote,
    });
  } catch (error) {
    legacyNullRescheduleRejected =
      error instanceof CalendarAccountIdentityError;
  }
  const [legacyNullUnchanged] = await testDatabase`
    SELECT b.status, b.calendar_external_account_id,
      count(lifecycle.id)::integer AS lifecycle_jobs
    FROM bookings b
    LEFT JOIN jobs lifecycle
      ON lifecycle.payload->>'bookingId' = b.id::text
     AND lifecycle.type IN ('calendar.event.update', 'calendar.event.cancel')
    WHERE b.id = ${String(legacyNullBooking!.id)}
    GROUP BY b.id
  `;
  if (
    !legacyNullCancelRejected ||
    !legacyNullRescheduleRejected ||
    legacyNullUnchanged?.status !== "confirmed" ||
    legacyNullUnchanged.calendarExternalAccountId !== null ||
    Number(legacyNullUnchanged.lifecycleJobs) !== 0
  ) {
    throw new Error(
      "A legacy NULL booking mutated before exact provider-account proof.",
    );
  }
  let wrongLegacyProofRejected = false;
  try {
    await repository.bindLegacyBookingCalendarAccount(legacyNullManageToken, {
      calendarExternalAccountId: integrationGoogleAccountId,
      externalEventId: "wrong-legacy-event",
      startsAt: legacyNullStartsAt,
      endsAt: legacyNullEndsAt,
    });
  } catch (error) {
    wrongLegacyProofRejected = error instanceof CalendarAccountIdentityError;
  }
  const legacyBound = await repository.bindLegacyBookingCalendarAccount(
    legacyNullManageToken,
    {
      calendarExternalAccountId: integrationGoogleAccountId,
      externalEventId: legacyNullEventId,
      startsAt: legacyNullStartsAt,
      endsAt: legacyNullEndsAt,
    },
  );
  const legacyBoundAgain = await repository.bindLegacyBookingCalendarAccount(
    legacyNullManageToken,
    {
      calendarExternalAccountId: integrationGoogleAccountId,
      externalEventId: legacyNullEventId,
      startsAt: legacyNullStartsAt,
      endsAt: legacyNullEndsAt,
    },
  );
  const [legacyBoundEvidence] = await testDatabase`
    SELECT b.calendar_external_account_id,
           create_job.payload->>'calendarExternalAccountId' AS create_account_id
    FROM bookings b
    JOIN jobs create_job
      ON create_job.type = 'calendar.event.create'
     AND create_job.payload->>'bookingId' = b.id::text
    WHERE b.id = ${String(legacyNullBooking!.id)}
  `;
  if (
    !wrongLegacyProofRejected ||
    !legacyBound ||
    !legacyBoundAgain ||
    legacyBoundEvidence?.calendarExternalAccountId !==
      integrationGoogleAccountId ||
    legacyBoundEvidence.createAccountId !== integrationGoogleAccountId
  ) {
    throw new Error(
      "Exact provider proof did not atomically bind a legacy booking lifecycle.",
    );
  }
  await repository.requestBookingCancellation(legacyNullManageToken);
  const [legacyNullCancellation] = await testDatabase`
    SELECT id, payload->>'calendarExternalAccountId' AS account_id
    FROM jobs
    WHERE type = 'calendar.event.cancel'
      AND payload->>'bookingId' = ${String(legacyNullBooking!.id)}
    ORDER BY id DESC
    LIMIT 1
  `;
  if (legacyNullCancellation?.accountId !== integrationGoogleAccountId) {
    throw new Error(
      "A positively repaired legacy booking did not queue an account-bound cancellation.",
    );
  }
  const legacyNullCancellationClaim = await claimJobForIntegration(
    Number(legacyNullCancellation!.id),
  );
  await repository.completeJob(
    Number(legacyNullCancellation!.id),
    legacyNullCancellationClaim,
    { externalEventId: legacyNullEventId },
  );

  const optedInDecision = await repository.route({
    organizationSlug: temporaryOrganizationSlug,
    externalId: `opted-in-route-${randomUUID()}`,
    lead: {
      name: "Opted In Buyer",
      email: "opted-in@example.com",
      company: { employee_count: 75, state: "NY" },
    },
    now: testNow,
  });
  const optedInExternalId = `opted-in-booking-${randomUUID()}`;
  const optedInBooking = await enqueueCreatedRepCalendarBooking({
    organizationSlug: temporaryOrganizationSlug,
    externalId: optedInExternalId,
    decisionId: optedInDecision.id,
    startsAt: new Date("2026-08-25T14:00:00.000Z"),
    endsAt: new Date("2026-08-25T14:30:00.000Z"),
    subject: "Opted-in dashboard booking",
    provider: "google",
    attendeeEmail: "opted-in@example.com",
  });
  const [optedInEvidence] = await testDatabase`
    SELECT b.id, b.attendee_email, b.attendee_notifications_enabled,
           j.payload->>'attendeeNotificationsEnabled' AS job_notifications_enabled,
           j.payload->>'attendeeEmail' AS job_attendee_email
    FROM bookings b
    JOIN jobs j ON j.payload->>'bookingId' = b.id::text
      AND j.type = 'calendar.event.create'
    WHERE b.organization_id = ${organizationId}
      AND b.source_external_id = ${optedInExternalId}
  `;
  if (
    optedInEvidence?.attendeeEmail !== "opted-in@example.com" ||
    optedInEvidence.attendeeNotificationsEnabled !== true ||
    optedInEvidence.jobNotificationsEnabled !== "true" ||
    optedInEvidence.jobAttendeeEmail !== "opted-in@example.com"
  ) {
    throw new Error(
      "Dashboard notification opt-in was not persisted explicitly.",
    );
  }
  const optedInClaim = await claimJobForIntegration(optedInBooking.id);
  await repository.completeJob(optedInBooking.id, optedInClaim, {
    externalEventId: "integration-opted-in-event",
  });
  const [optedInMessages] = await testDatabase`
    SELECT count(*)::int AS messages
    FROM jobs
    WHERE type = 'email.booking.confirmation'
      AND payload->>'bookingId' = ${String(optedInEvidence!.id)}
  `;
  if (Number(optedInMessages?.messages) !== 1) {
    throw new Error(
      "An opted-in dashboard booking did not queue confirmation email.",
    );
  }

  const silentDecision = await repository.route({
    organizationSlug: temporaryOrganizationSlug,
    externalId: `silent-route-${randomUUID()}`,
    lead: {
      name: "Silent Buyer",
      email: "silent@example.com",
      company: { employee_count: 75, state: "NY" },
    },
    now: testNow,
  });
  const silentExternalId = `silent-booking-${randomUUID()}`;
  const silentBooking = await enqueueCreatedRepCalendarBooking({
    organizationSlug: temporaryOrganizationSlug,
    externalId: silentExternalId,
    decisionId: silentDecision.id,
    startsAt: new Date("2026-08-25T15:00:00.000Z"),
    endsAt: new Date("2026-08-25T15:30:00.000Z"),
    subject: "Silent dashboard booking",
    provider: "google",
  });
  const silentCreateClaim = await claimJobForIntegration(silentBooking.id);
  await repository.completeJob(silentBooking.id, silentCreateClaim, {
    externalEventId: "integration-silent-event",
  });
  const silentManageToken = silentBooking.managePath?.split("/").at(-1);
  if (!silentManageToken) {
    throw new Error(
      "A new dashboard booking did not receive a management capability.",
    );
  }
  await repository.requestBookingReschedule({
    manageToken: silentManageToken,
    startsAt: new Date("2026-08-25T15:30:00.000Z"),
    endsAt: new Date("2026-08-25T16:00:00.000Z"),
    reminderMinutes: 0,
    calendarQuote: createdRepCalendarQuote,
  });
  const [silentUpdate] = await testDatabase`
    SELECT j.id,
           j.payload->>'attendeeNotificationsEnabled' AS notifications_enabled,
           j.payload->>'attendeeEmail' AS attendee_email
    FROM bookings b
    JOIN jobs j ON j.payload->>'bookingId' = b.id::text
      AND j.type = 'calendar.event.update'
    WHERE b.organization_id = ${organizationId}
      AND b.source_external_id = ${silentExternalId}
  `;
  if (
    silentUpdate?.notificationsEnabled !== "false" ||
    silentUpdate.attendeeEmail !== null
  ) {
    throw new Error("A silent booking reschedule reintroduced attendee email.");
  }
  const silentUpdateClaim = await claimJobForIntegration(
    Number(silentUpdate.id),
  );
  await repository.completeJob(Number(silentUpdate.id), silentUpdateClaim, {
    externalEventId: "integration-silent-event",
  });
  const [silentMessages] = await testDatabase`
    SELECT count(*)::int AS messages
    FROM jobs
    WHERE type LIKE 'email.booking.%'
      AND payload->>'bookingId' = (
        SELECT id::text FROM bookings
        WHERE organization_id = ${organizationId}
          AND source_external_id = ${silentExternalId}
      )
  `;
  if (Number(silentMessages?.messages) !== 0) {
    throw new Error("A silent booking reschedule queued lifecycle email.");
  }

  const reusablePublicExternalId = `public-reuse-${randomUUID()}`;
  const reusedCancelledSlot = await repository.enqueuePublicBooking({
    organizationSlug: temporaryOrganizationSlug,
    schedulingSlug: "qualified-team",
    meetingTypeId: createdMeetingTypeId,
    candidateQuotes: [createdRepCalendarQuote],
    externalId: reusablePublicExternalId,
    startsAt: new Date("2026-08-24T14:15:00.000Z"),
    endsAt: new Date("2026-08-24T14:45:00.000Z"),
    attendeeName: "Cancelled Slot Reuse",
    attendeeEmail: "cancelled-reuse@example.com",
    subject: "Cancelled slot reuse",
    conferenceProvider: "none",
    reminderMinutes: 0,
  });
  if (reusedCancelledSlot.status !== "pending") {
    throw new Error("A cancelled booking did not release its full time range.");
  }
  const [reusablePublicJob] = await testDatabase`
    UPDATE jobs SET attempts = 5
    WHERE organization_id = ${organizationId}
      AND type = 'calendar.event.create'
      AND payload->>'externalId' = ${reusablePublicExternalId}
    RETURNING id
  `;
  if (!reusablePublicJob) {
    throw new Error("Reusable public booking did not queue a calendar job.");
  }
  const reusablePublicClaim = await claimJobForIntegration(
    Number(reusablePublicJob.id),
    5,
  );
  await repository.failJob(
    Number(reusablePublicJob.id),
    reusablePublicClaim,
    "integration calendar failure",
  );
  const [publicReconciliation] = await testDatabase`
    SELECT b.id AS booking_id, b.status AS booking_status,
           b.calendar_external_account_id,
           create_job.status AS create_job_status,
           create_job.payload->>'calendarExternalAccountId' AS create_account_id,
           reconcile_job.id AS reconcile_job_id,
           reconcile_job.status AS reconcile_job_status,
           reconcile_job.payload->>'calendarExternalAccountId' AS reconcile_account_id
    FROM bookings b
    JOIN jobs create_job ON create_job.id = ${reusablePublicJob.id}
    JOIN jobs reconcile_job
      ON reconcile_job.type = 'calendar.event.create.reconcile'
     AND reconcile_job.payload->>'bookingId' = b.id::text
    WHERE b.external_id = ${reusablePublicExternalId}
  `;
  if (
    publicReconciliation?.bookingStatus !== "pending" ||
    publicReconciliation.calendarExternalAccountId !==
      integrationGoogleAccountId ||
    publicReconciliation.createAccountId !== integrationGoogleAccountId ||
    publicReconciliation.reconcileAccountId !== integrationGoogleAccountId ||
    publicReconciliation.createJobStatus !== "failed" ||
    publicReconciliation.reconcileJobStatus !== "pending"
  ) {
    throw new Error(
      "A non-router terminal create did not enter safe provider reconciliation.",
    );
  }
  const failedLedgerIntervals = await repository.activeBookingIntervals(
    temporaryOrganizationSlug,
    [createdRepId],
    new Date("2026-08-24T14:15:00.000Z"),
    new Date("2026-08-24T14:45:00.000Z"),
  );
  const retryLedgerIntervals = await repository.activeBookingIntervals(
    temporaryOrganizationSlug,
    [createdRepId],
    new Date("2026-08-24T14:15:00.000Z"),
    new Date("2026-08-24T14:45:00.000Z"),
    reusablePublicExternalId,
  );
  if (
    (failedLedgerIntervals.get(createdRepId)?.length ?? 0) !== 1 ||
    (retryLedgerIntervals.get(createdRepId)?.length ?? 0) !== 0
  ) {
    throw new Error(
      "Failed booking retry availability did not exclude exactly its own reservation.",
    );
  }
  const failedReuseDecision = await repository.route({
    organizationSlug: temporaryOrganizationSlug,
    externalId: `failed-reuse-route-${randomUUID()}`,
    lead: {
      name: "Failed Slot Reuse",
      email: "failed-reuse@example.com",
      company: { employee_count: 75, state: "NY" },
    },
    now: testNow,
  });
  let failedSlotStayedReserved = false;
  try {
    await enqueueCreatedRepCalendarBooking({
      organizationSlug: temporaryOrganizationSlug,
      externalId: `legacy-reuse-${randomUUID()}`,
      decisionId: failedReuseDecision.id,
      startsAt: new Date("2026-08-24T14:20:00.000Z"),
      endsAt: new Date("2026-08-24T14:50:00.000Z"),
      subject: "Failed slot reuse",
      provider: "google",
    });
  } catch (error) {
    failedSlotStayedReserved = error instanceof CalendarSlotUnavailableError;
  }
  if (!failedSlotStayedReserved) {
    throw new Error(
      "A failed calendar create released its range before provider reconciliation.",
    );
  }

  const firstNegativeClaim = await claimJobForIntegration(
    Number(publicReconciliation!.reconcileJobId),
  );
  await repository.completeJob(
    Number(publicReconciliation!.reconcileJobId),
    firstNegativeClaim,
    { found: false },
  );
  const [firstNegativeEvidence] = await testDatabase`
    SELECT b.status AS booking_status, j.status AS reconciliation_status,
           j.result
    FROM bookings b
    JOIN jobs j ON j.id = ${publicReconciliation!.reconcileJobId}
    WHERE b.id = ${publicReconciliation!.bookingId}
  `;
  if (
    firstNegativeEvidence?.bookingStatus !== "pending" ||
    firstNegativeEvidence.reconciliationStatus !== "pending" ||
    Number(
      (firstNegativeEvidence.result as { negativeChecks?: number } | null)
        ?.negativeChecks,
    ) !== 1
  ) {
    throw new Error("One provider miss released a reconciling booking.");
  }
  await testDatabase`
    UPDATE jobs
    SET created_at = now() - interval '3 minutes',
        result = jsonb_build_object(
          'negativeChecks', 1,
          'lastCheckedAt', now() - interval '1 minute'
        ),
        run_at = now()
    WHERE id = ${publicReconciliation!.reconcileJobId}
  `;
  const secondNegativeClaim = await claimJobForIntegration(
    Number(publicReconciliation!.reconcileJobId),
  );
  await repository.completeJob(
    Number(publicReconciliation!.reconcileJobId),
    secondNegativeClaim,
    { found: false },
  );
  const [durableNegativeEvidence] = await testDatabase`
    SELECT b.status AS booking_status, b.cancelled_at,
           create_job.status AS create_job_status,
           reconcile_job.status AS reconciliation_status,
      (SELECT count(*)::int FROM jobs message
       WHERE message.type = 'email.booking.cancelled'
         AND message.payload->>'bookingId' = b.id::text) AS cancellation_emails
    FROM bookings b
    JOIN jobs create_job ON create_job.id = ${reusablePublicJob.id}
    JOIN jobs reconcile_job
      ON reconcile_job.id = ${publicReconciliation!.reconcileJobId}
    WHERE b.id = ${publicReconciliation!.bookingId}
  `;
  if (
    durableNegativeEvidence?.bookingStatus !== "cancelled" ||
    !durableNegativeEvidence.cancelledAt ||
    durableNegativeEvidence.createJobStatus !== "failed" ||
    durableNegativeEvidence.reconciliationStatus !== "completed" ||
    Number(durableNegativeEvidence.cancellationEmails) !== 0
  ) {
    throw new Error(
      "Durable provider absence did not safely close and release the booking.",
    );
  }
  const replacementAfterReconciliation = await repository.enqueuePublicBooking({
    organizationSlug: temporaryOrganizationSlug,
    schedulingSlug: "qualified-team",
    meetingTypeId: createdMeetingTypeId,
    candidateQuotes: [createdRepCalendarQuote],
    externalId: `reconciled-reuse-${randomUUID()}`,
    startsAt: new Date("2026-08-24T14:15:00.000Z"),
    endsAt: new Date("2026-08-24T14:45:00.000Z"),
    attendeeName: "Reconciled slot reuse",
    attendeeEmail: "reconciled-reuse@example.com",
    subject: "Reconciled slot reuse",
    conferenceProvider: "none",
    reminderMinutes: 0,
  });
  if (replacementAfterReconciliation.status !== "pending") {
    throw new Error(
      "A durably absent provider event did not release its slot.",
    );
  }

  const exclusionDecision = await repository.route({
    organizationSlug: temporaryOrganizationSlug,
    externalId: `exclusion-route-${randomUUID()}`,
    lead: {
      name: "Database Exclusion",
      email: "database-exclusion@example.com",
      company: { employee_count: 75, state: "NY" },
    },
    now: testNow,
  });
  let databaseExclusionRejected = false;
  const exclusionExternalId = `database-exclusion-${randomUUID()}`;
  try {
    await testDatabase`
      INSERT INTO bookings (
        organization_id, meeting_type_id, rep_id, external_id,
        manage_token_hash, attendee_name, attendee_email, starts_at, ends_at,
        calendar_provider, conference_provider, routing_decision_id
      )
      SELECT o.id, mt.id, r.id, ${exclusionExternalId},
             ${createHash("sha256").update(exclusionExternalId).digest("hex")},
             'Database Exclusion', 'database-exclusion@example.com',
             ${new Date("2026-08-24T14:40:00.000Z")},
             ${new Date("2026-08-24T15:10:00.000Z")},
             'google', 'none', ${exclusionDecision.id}
      FROM organizations o
      JOIN reps r ON r.organization_id = o.id AND r.id = ${createdRepId}
      JOIN meeting_types mt
        ON mt.organization_id = o.id
       AND mt.rep_id = r.id
       AND mt.slug = r.scheduling_slug
      WHERE o.slug = ${temporaryOrganizationSlug}
    `;
  } catch (error) {
    databaseExclusionRejected =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23P01";
  }
  if (!databaseExclusionRejected) {
    throw new Error("PostgreSQL accepted an offset active-booking overlap.");
  }

  const recoveredLegacyDecision = await repository.route({
    organizationSlug: temporaryOrganizationSlug,
    externalId: `recovered-legacy-route-${randomUUID()}`,
    lead: {
      name: "Recovered legacy buyer",
      email: "recovered-legacy@example.com",
      company: { employee_count: 75, state: "NY" },
    },
    now: testNow,
  });
  const recoveredLegacyExternalId = `recovered-legacy-${randomUUID()}`;
  const recoveredLegacyInput = {
    organizationSlug: temporaryOrganizationSlug,
    externalId: recoveredLegacyExternalId,
    decisionId: recoveredLegacyDecision.id,
    startsAt: new Date("2026-08-25T16:30:00.000Z"),
    endsAt: new Date("2026-08-25T17:00:00.000Z"),
    subject: "Recovered legacy booking",
    provider: "google" as const,
  };
  const recoveredLegacyCreate =
    await enqueueCreatedRepCalendarBooking(recoveredLegacyInput);
  const recoveredLegacyFailureClaim = await claimJobForIntegration(
    recoveredLegacyCreate.id,
    5,
  );
  await repository.failJob(
    recoveredLegacyCreate.id,
    recoveredLegacyFailureClaim,
    "integration ambiguous legacy create",
  );
  const [recoveredLegacyReconciliation] = await testDatabase`
    SELECT id FROM jobs
    WHERE type = 'calendar.event.create.reconcile'
      AND payload->>'sourceExternalId' = ${recoveredLegacyExternalId}
  `;
  if (!recoveredLegacyReconciliation) {
    throw new Error("Legacy failed create did not queue reconciliation.");
  }
  const recoveredLegacyClaim = await claimJobForIntegration(
    Number(recoveredLegacyReconciliation.id),
  );
  await repository.completeJob(
    Number(recoveredLegacyReconciliation.id),
    recoveredLegacyClaim,
    {
      found: true,
      externalEventId: "integration-recovered-legacy-event",
      webLink: "https://calendar.example.com/recovered-legacy-event",
      conferenceUrl: null,
    },
  );
  const repeatedRecoveredLegacy =
    await enqueueCreatedRepCalendarBooking(recoveredLegacyInput);
  const [recoveredLegacyEvidence] = await testDatabase`
    SELECT b.status AS booking_status, b.external_event_id,
           create_job.status AS create_job_status,
           reconcile_job.status AS reconciliation_status,
      (SELECT count(*)::int FROM jobs message
       WHERE message.type LIKE 'email.booking.%'
         AND message.payload->>'bookingId' = b.id::text) AS lifecycle_messages
    FROM bookings b
    JOIN jobs create_job ON create_job.id = ${recoveredLegacyCreate.id}
    JOIN jobs reconcile_job
      ON reconcile_job.id = ${recoveredLegacyReconciliation.id}
    WHERE b.source_external_id = ${recoveredLegacyExternalId}
  `;
  if (
    repeatedRecoveredLegacy.id !== recoveredLegacyCreate.id ||
    repeatedRecoveredLegacy.status !== "completed" ||
    repeatedRecoveredLegacy.externalEventId !==
      "integration-recovered-legacy-event" ||
    recoveredLegacyEvidence?.bookingStatus !== "confirmed" ||
    recoveredLegacyEvidence.externalEventId !==
      "integration-recovered-legacy-event" ||
    recoveredLegacyEvidence.createJobStatus !== "completed" ||
    recoveredLegacyEvidence.reconciliationStatus !== "completed" ||
    Number(recoveredLegacyEvidence.lifecycleMessages) !== 0
  ) {
    throw new Error(
      "Legacy provider reconciliation did not recover the same durable booking.",
    );
  }

  const smartManageToken = booked.managePath?.split("/").at(-1);
  if (!smartManageToken) {
    throw new Error("Smart Link booking did not expose its manage token.");
  }
  await testDatabase`
    UPDATE bookings SET status = 'confirmed',
      external_event_id = 'integration-smart-event'
    WHERE organization_id = ${organizationId}
      AND external_id = ${smartManageToken}
  `;
  await repository.updateRepCalendarSettings({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "microsoft",
    makeActive: true,
  });
  const managedAfterProviderSwitch =
    await repository.managedBooking(smartManageToken);
  if (
    managedAfterProviderSwitch?.calendarProvider !== "google" ||
    managedAfterProviderSwitch.calendarExternalAccountId !==
      integrationGoogleAccountId ||
    managedAfterProviderSwitch.rescheduleSchedule?.reps[0]?.calendarProvider !==
      "google" ||
    managedAfterProviderSwitch.rescheduleSchedule.reps[0]
      .calendarExternalAccountId !== integrationGoogleAccountId
  ) {
    throw new Error(
      "A booking lost its original calendar account after the active provider changed.",
    );
  }
  let rescheduleOverlapRejected = false;
  try {
    await repository.requestBookingReschedule({
      manageToken: smartManageToken,
      startsAt: new Date("2026-08-24T14:30:00.000Z"),
      endsAt: new Date("2026-08-24T15:00:00.000Z"),
      reminderMinutes: 0,
      calendarQuote: createdRepCalendarQuote,
    });
  } catch (error) {
    rescheduleOverlapRejected = error instanceof CalendarSlotUnavailableError;
  }
  if (!rescheduleOverlapRejected) {
    throw new Error("Rescheduling ignored an offset overlap.");
  }
  const rescheduledStartsAt = new Date("2026-08-24T15:00:00.000Z");
  const rescheduledEndsAt = new Date("2026-08-24T15:30:00.000Z");
  await repository.requestBookingReschedule({
    manageToken: smartManageToken,
    startsAt: rescheduledStartsAt,
    endsAt: rescheduledEndsAt,
    reminderMinutes: 0,
    calendarQuote: createdRepCalendarQuote,
  });
  await repository.updateRepCalendarSettings({
    organizationSlug: temporaryOrganizationSlug,
    repId: createdRepId,
    provider: "google",
    makeActive: true,
  });
  await repository.requestBookingReschedule({
    manageToken: smartManageToken,
    startsAt: rescheduledStartsAt,
    endsAt: rescheduledEndsAt,
    reminderMinutes: 0,
  });
  const [rescheduleEvidence] = await testDatabase`
    SELECT b.status, b.starts_at, b.ends_at,
           b.previous_starts_at, b.previous_ends_at,
      (SELECT count(*)::int FROM jobs j
       WHERE j.type = 'calendar.event.update'
         AND j.payload->>'bookingId' = b.id::text) AS update_jobs
      ,(SELECT min(j.payload->>'calendarExternalAccountId') FROM jobs j
        WHERE j.type = 'calendar.event.update'
          AND j.payload->>'bookingId' = b.id::text) AS update_account_id
    FROM bookings b
    WHERE b.organization_id = ${organizationId}
      AND b.external_id = ${smartManageToken}
  `;
  if (
    rescheduleEvidence?.status !== "reschedule_pending" ||
    new Date(String(rescheduleEvidence.startsAt)).getTime() !==
      rescheduledStartsAt.getTime() ||
    new Date(String(rescheduleEvidence.endsAt)).getTime() !==
      rescheduledEndsAt.getTime() ||
    new Date(String(rescheduleEvidence.previousStartsAt)).getTime() !==
      bookingStartsAt.getTime() ||
    new Date(String(rescheduleEvidence.previousEndsAt)).getTime() !==
      bookingEndsAt.getTime() ||
    Number(rescheduleEvidence.updateJobs) !== 1 ||
    rescheduleEvidence.updateAccountId !== integrationGoogleAccountId
  ) {
    throw new Error("An exact pending reschedule was not idempotent.");
  }
  const pendingRescheduleIntervals = (
    await repository.activeBookingIntervals(
      temporaryOrganizationSlug,
      [createdRepId],
      new Date("2026-08-24T12:00:00.000Z"),
      new Date("2026-08-24T16:00:00.000Z"),
    )
  ).get(createdRepId);
  const pendingRescheduleRanges = new Set(
    pendingRescheduleIntervals?.map(
      (interval) =>
        `${interval.startsAt.toISOString()}/${interval.endsAt.toISOString()}`,
    ),
  );
  if (
    !pendingRescheduleRanges.has(
      `${bookingStartsAt.toISOString()}/${bookingEndsAt.toISOString()}`,
    ) ||
    !pendingRescheduleRanges.has(
      `${rescheduledStartsAt.toISOString()}/${rescheduledEndsAt.toISOString()}`,
    )
  ) {
    throw new Error(
      "Pending reschedule availability did not reserve both time ranges.",
    );
  }

  const oldSlotDecision = await repository.route({
    organizationSlug: temporaryOrganizationSlug,
    externalId: `old-slot-route-${randomUUID()}`,
    lead: {
      name: "Old Slot Challenger",
      email: "old-slot-challenger@example.com",
      company: { employee_count: 75, state: "NY" },
    },
    now: testNow,
  });
  let oldSlotStayedReserved = false;
  try {
    await enqueueCreatedRepCalendarBooking({
      organizationSlug: temporaryOrganizationSlug,
      externalId: `old-slot-challenger-${randomUUID()}`,
      decisionId: oldSlotDecision.id,
      startsAt: new Date("2026-08-24T13:10:00.000Z"),
      endsAt: new Date("2026-08-24T13:40:00.000Z"),
      subject: "Old slot challenger",
      provider: "google",
    });
  } catch (error) {
    oldSlotStayedReserved = error instanceof CalendarSlotUnavailableError;
  }
  if (!oldSlotStayedReserved) {
    throw new Error(
      "A pending reschedule released the still-live calendar event's old slot.",
    );
  }

  const [failedRescheduleJob] = await testDatabase`
    UPDATE jobs SET attempts = 5
    WHERE type = 'calendar.event.update'
      AND payload->>'bookingId' = ${String(bookingEvidence!.id)}
    RETURNING id
  `;
  if (!failedRescheduleJob) {
    throw new Error("Pending reschedule did not have an update job to fail.");
  }
  const failedRescheduleClaim = await claimJobForIntegration(
    Number(failedRescheduleJob.id),
    5,
  );
  const terminalRescheduleFailure = await repository.failJob(
    Number(failedRescheduleJob.id),
    failedRescheduleClaim,
    "integration reschedule failure",
  );
  const repeatedRescheduleFailure = await repository.failJob(
    Number(failedRescheduleJob.id),
    failedRescheduleClaim,
    "integration reschedule failure",
  );
  if (!terminalRescheduleFailure || repeatedRescheduleFailure) {
    throw new Error("Reschedule failure claim fencing was not idempotent.");
  }
  const [uncertainReschedule] = await testDatabase`
    SELECT status, starts_at, ends_at, previous_starts_at, previous_ends_at,
           last_error
    FROM bookings
    WHERE id = ${bookingEvidence!.id}
  `;
  if (
    uncertainReschedule?.status !== "reschedule_pending" ||
    new Date(String(uncertainReschedule.startsAt)).getTime() !==
      rescheduledStartsAt.getTime() ||
    new Date(String(uncertainReschedule.endsAt)).getTime() !==
      rescheduledEndsAt.getTime() ||
    new Date(String(uncertainReschedule.previousStartsAt)).getTime() !==
      bookingStartsAt.getTime() ||
    new Date(String(uncertainReschedule.previousEndsAt)).getTime() !==
      bookingEndsAt.getTime() ||
    uncertainReschedule.lastError !== "integration reschedule failure"
  ) {
    throw new Error(
      "A terminal uncertain reschedule did not retain both possible provider ranges.",
    );
  }
  const managedUncertainReschedule =
    await repository.managedBooking(smartManageToken);
  if (
    managedUncertainReschedule?.externalEventId !== "integration-smart-event" ||
    managedUncertainReschedule.previousStartsAt !==
      bookingStartsAt.toISOString() ||
    managedUncertainReschedule.previousEndsAt !== bookingEndsAt.toISOString() ||
    managedUncertainReschedule.failedRouterCreate
  ) {
    throw new Error(
      "Managed uncertain reschedule context did not expose both provider ranges and event evidence.",
    );
  }

  await repository.requestBookingCancellation(smartManageToken);
  const [uncertainCancellation] = await testDatabase`
    SELECT b.status, b.starts_at, b.ends_at,
           b.previous_starts_at, b.previous_ends_at,
           update_job.status AS update_status,
           cancel_job.id AS cancel_job_id,
           cancel_job.status AS cancel_status,
           cancel_job.payload AS cancel_payload
    FROM bookings b
    JOIN jobs update_job
      ON update_job.id = ${Number(failedRescheduleJob.id)}
    JOIN LATERAL (
      SELECT id, status, payload
      FROM jobs
      WHERE type = 'calendar.event.cancel'
        AND payload->>'bookingId' = b.id::text
      ORDER BY id DESC
      LIMIT 1
    ) cancel_job ON true
    WHERE b.id = ${bookingEvidence!.id}
  `;
  const uncertainCancellationPayload = uncertainCancellation?.cancelPayload as
    | Record<string, unknown>
    | undefined;
  if (
    uncertainCancellation?.status !== "cancel_pending" ||
    uncertainCancellation.updateStatus !== "cancelled" ||
    uncertainCancellation.cancelStatus !== "pending" ||
    new Date(String(uncertainCancellation.startsAt)).getTime() !==
      rescheduledStartsAt.getTime() ||
    new Date(String(uncertainCancellation.endsAt)).getTime() !==
      rescheduledEndsAt.getTime() ||
    new Date(String(uncertainCancellation.previousStartsAt)).getTime() !==
      bookingStartsAt.getTime() ||
    new Date(String(uncertainCancellation.previousEndsAt)).getTime() !==
      bookingEndsAt.getTime() ||
    uncertainCancellationPayload?.cancelsUncertainReschedule !== true ||
    Number(uncertainCancellationPayload.uncertainRescheduleJobId) !==
      Number(failedRescheduleJob.id) ||
    uncertainCancellationPayload.calendarExternalAccountId !==
      integrationGoogleAccountId
  ) {
    throw new Error(
      "Cancelling an uncertain reschedule did not preserve both ranges and exact provider identity.",
    );
  }
  const uncertainCancellationIntervals = (
    await repository.activeBookingIntervals(
      temporaryOrganizationSlug,
      [createdRepId],
      new Date("2026-08-24T12:00:00.000Z"),
      new Date("2026-08-24T16:00:00.000Z"),
    )
  ).get(createdRepId);
  const uncertainCancellationRanges = new Set(
    uncertainCancellationIntervals?.map(
      (interval) =>
        `${interval.startsAt.toISOString()}/${interval.endsAt.toISOString()}`,
    ),
  );
  if (
    !uncertainCancellationRanges.has(
      `${bookingStartsAt.toISOString()}/${bookingEndsAt.toISOString()}`,
    ) ||
    !uncertainCancellationRanges.has(
      `${rescheduledStartsAt.toISOString()}/${rescheduledEndsAt.toISOString()}`,
    )
  ) {
    throw new Error(
      "An uncertain-reschedule cancellation released one possible provider range.",
    );
  }

  await testDatabase`
    UPDATE jobs SET attempts = 5
    WHERE id = ${Number(uncertainCancellation!.cancelJobId)}
  `;
  const failedUncertainCancellationClaim = await claimJobForIntegration(
    Number(uncertainCancellation!.cancelJobId),
    5,
  );
  await repository.failJob(
    Number(uncertainCancellation!.cancelJobId),
    failedUncertainCancellationClaim,
    "integration uncertain cancellation failure",
  );
  const [restoredUncertainReschedule] = await testDatabase`
    SELECT b.status, b.last_error, b.previous_starts_at, b.previous_ends_at,
           update_job.status AS update_status,
           cancel_job.status AS cancel_status
    FROM bookings b
    JOIN jobs update_job ON update_job.id = ${Number(failedRescheduleJob.id)}
    JOIN jobs cancel_job
      ON cancel_job.id = ${Number(uncertainCancellation!.cancelJobId)}
    WHERE b.id = ${bookingEvidence!.id}
  `;
  if (
    restoredUncertainReschedule?.status !== "reschedule_pending" ||
    restoredUncertainReschedule.lastError !==
      "integration uncertain cancellation failure" ||
    restoredUncertainReschedule.updateStatus !== "failed" ||
    restoredUncertainReschedule.cancelStatus !== "failed" ||
    new Date(String(restoredUncertainReschedule.previousStartsAt)).getTime() !==
      bookingStartsAt.getTime() ||
    new Date(String(restoredUncertainReschedule.previousEndsAt)).getTime() !==
      bookingEndsAt.getTime()
  ) {
    throw new Error(
      "A failed uncertain-reschedule cancellation did not restore a retryable two-range state.",
    );
  }

  let missingRescheduleProofRejected = false;
  try {
    await repository.requestBookingReschedule({
      manageToken: smartManageToken,
      startsAt: rescheduledStartsAt,
      endsAt: rescheduledEndsAt,
      reminderMinutes: 0,
    });
  } catch (error) {
    missingRescheduleProofRejected =
      error instanceof Error &&
      error.message.includes("Provider event location proof");
  }
  let originalRangeWithoutQuoteRejected = false;
  try {
    await repository.requestBookingReschedule({
      manageToken: smartManageToken,
      startsAt: rescheduledStartsAt,
      endsAt: rescheduledEndsAt,
      reminderMinutes: 0,
      providerEventAtRequested: false,
    });
  } catch (error) {
    originalRangeWithoutQuoteRejected =
      error instanceof CalendarSlotUnavailableError;
  }
  if (!missingRescheduleProofRejected || !originalRangeWithoutQuoteRejected) {
    throw new Error(
      "An uncertain reschedule retried without provider-state proof and a current slot quote.",
    );
  }
  await repository.requestBookingReschedule({
    manageToken: smartManageToken,
    startsAt: rescheduledStartsAt,
    endsAt: rescheduledEndsAt,
    reminderMinutes: 0,
    providerEventAtRequested: false,
    calendarQuote: createdRepCalendarQuote,
  });
  const [retriedReschedule] = await testDatabase`
    SELECT b.status, b.last_error, j.status AS job_status, j.attempts
    FROM bookings b
    JOIN jobs j ON j.payload->>'bookingId' = b.id::text
      AND j.type = 'calendar.event.update'
    WHERE b.id = ${bookingEvidence!.id}
    ORDER BY j.id DESC
    LIMIT 1
  `;
  if (
    retriedReschedule?.status !== "reschedule_pending" ||
    retriedReschedule.lastError !== null ||
    retriedReschedule.jobStatus !== "pending" ||
    Number(retriedReschedule.attempts) !== 0
  ) {
    throw new Error("An exact uncertain reschedule retry was not idempotent.");
  }
  await testDatabase`
    UPDATE jobs SET attempts = 5
    WHERE id = ${Number(failedRescheduleJob.id)}
  `;
  const repeatedFailedRescheduleClaim = await claimJobForIntegration(
    Number(failedRescheduleJob.id),
    5,
  );
  await repository.failJob(
    Number(failedRescheduleJob.id),
    repeatedFailedRescheduleClaim,
    "integration repeated uncertain reschedule failure",
  );
  await repository.requestBookingReschedule({
    manageToken: smartManageToken,
    startsAt: rescheduledStartsAt,
    endsAt: rescheduledEndsAt,
    reminderMinutes: 0,
    providerEventAtRequested: true,
  });
  const [providerProvenRetry] = await testDatabase`
    SELECT b.status, b.last_error, j.status AS job_status
    FROM bookings b
    JOIN jobs j ON j.id = ${Number(failedRescheduleJob.id)}
    WHERE b.id = ${bookingEvidence!.id}
  `;
  if (
    providerProvenRetry?.status !== "reschedule_pending" ||
    providerProvenRetry.lastError !== null ||
    providerProvenRetry.jobStatus !== "pending"
  ) {
    throw new Error(
      "A provider-proven requested-range reschedule did not retry without a slot quote.",
    );
  }
  const retriedRescheduleClaim = await claimJobForIntegration(
    Number(failedRescheduleJob.id),
  );
  await repository.completeJob(
    Number(failedRescheduleJob.id),
    retriedRescheduleClaim,
    { externalEventId: "integration-smart-event" },
  );

  const cleanup = await repository.cleanupExpiredPublicRouterData(
    new Date(testNow.getTime() + 25 * 60 * 60_000),
  );
  const [retentionEvidence] = await testDatabase`
    SELECT
      (SELECT count(*)::int FROM router_qualification_sessions
        WHERE organization_id = ${organizationId}
          AND booked_at IS NULL) AS unbooked_sessions,
      (SELECT count(*)::int FROM public_rate_limit_buckets
        WHERE organization_id = ${organizationId}) AS rate_buckets,
      (SELECT count(*)::int FROM router_funnel_events
        WHERE organization_id = ${organizationId}) AS funnel_events,
      s.attendee_name, s.attendee_email, s.lead, s.redacted_at
    FROM router_qualification_sessions s
    WHERE s.organization_id = ${organizationId} AND s.booked_at IS NOT NULL
  `;
  const bookingAfterCleanup = await repository.routerLinkBookingStatus(
    temporaryOrganizationSlug,
    "qualified-company",
    matchedSessionToken,
  );
  if (
    cleanup.deletedSessions < 4 ||
    cleanup.redactedSessions !== 1 ||
    cleanup.deletedRateBuckets !== 1 ||
    Number(retentionEvidence?.unbookedSessions) !== 0 ||
    Number(retentionEvidence?.rateBuckets) !== 0 ||
    Number(retentionEvidence?.funnelEvents) < 5 ||
    retentionEvidence?.attendeeName !== "Redacted" ||
    retentionEvidence?.attendeeEmail !== "redacted@invalid.local" ||
    !retentionEvidence?.redactedAt ||
    (retentionEvidence?.lead as { email?: string } | undefined)?.email !==
      "redacted@invalid.local" ||
    !bookingAfterCleanup
  ) {
    throw new Error(
      `Expired Smart Link public data was not cleaned safely: ${JSON.stringify({
        cleanup,
        retentionEvidence,
        bookingAfterCleanup,
      })}`,
    );
  }

  const retrySessionToken = `retry-${randomUUID()}`;
  const retryAttendeeEmail = `retry-${randomUUID()}@example.com`;
  const retryStartsAt = new Date("2026-08-24T16:00:00.000Z");
  const retryEndsAt = new Date("2026-08-24T16:30:00.000Z");
  await repository.qualifyRouterLink({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: retrySessionToken,
    attendeeName: "Calendar Retry Buyer",
    attendeeEmail: retryAttendeeEmail,
    answers: { "company.employee_count": 75, "company.state": "NY" },
    now: testNow,
  });
  const retryAttemptToken = `attempt-${randomUUID()}`;
  await repository.beginRouterLinkBookingAttempt({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: retrySessionToken,
    attemptToken: retryAttemptToken,
    startsAt: retryStartsAt,
    endsAt: retryEndsAt,
    now: testNow,
  });
  const createdRetryBooking = await repository.bookRouterLinkSession({
    organizationSlug: temporaryOrganizationSlug,
    routerSlug: "qualified-company",
    sessionToken: retrySessionToken,
    attemptToken: retryAttemptToken,
    candidateQuotes: [createdRepCalendarQuote],
    startsAt: retryStartsAt,
    endsAt: retryEndsAt,
    now: testNow,
  });
  const retryEvidence = async () => {
    const [evidence] = await testDatabase`
      SELECT b.id AS booking_id, b.external_id, b.routing_decision_id,
             b.rep_id, b.router_session_id, b.status AS booking_status,
             b.calendar_external_account_id,
             b.last_error AS booking_error, b.cancelled_at, s.booked_at,
             rd.rep_id AS decision_rep_id,
             ast.assignments, ast.last_assigned_at,
             calendar_job.id AS calendar_job_id,
             calendar_job.status AS calendar_job_status,
             calendar_job.attempts AS calendar_attempts,
             calendar_job.result AS calendar_result,
             calendar_job.last_error AS calendar_error,
             calendar_job.run_at AS calendar_run_at,
             calendar_job.completed_at AS calendar_completed_at,
             calendar_job.payload->>'calendarExternalAccountId' AS calendar_job_account_id,
        (SELECT min(crm_job.id) FROM jobs crm_job
         WHERE crm_job.organization_id = b.organization_id
           AND crm_job.type = 'crm.owner.writeback'
           AND crm_job.payload->>'decisionId' = b.routing_decision_id::text
        ) AS crm_job_id,
        (SELECT count(*)::int FROM jobs crm_job
         WHERE crm_job.organization_id = b.organization_id
           AND crm_job.type = 'crm.owner.writeback'
           AND crm_job.payload->>'decisionId' = b.routing_decision_id::text
        ) AS crm_jobs,
        (SELECT count(*)::int FROM jobs create_job
         WHERE create_job.organization_id = b.organization_id
           AND create_job.type = 'calendar.event.create'
           AND create_job.payload->>'bookingId' = b.id::text
        ) AS calendar_jobs
      FROM bookings b
      JOIN router_qualification_sessions s ON s.id = b.router_session_id
      JOIN routing_decisions rd ON rd.id = b.routing_decision_id
      JOIN assignment_state ast
        ON ast.pool_id = s.pool_id AND ast.rep_id = b.rep_id
      JOIN jobs calendar_job
        ON calendar_job.organization_id = b.organization_id
       AND calendar_job.type = 'calendar.event.create'
       AND calendar_job.payload->>'bookingId' = b.id::text
      WHERE b.organization_id = ${organizationId}
        AND b.attendee_email = ${retryAttendeeEmail}
    `;
    return evidence;
  };
  const retryBeforeFailure = await retryEvidence();
  const createdRetryManageToken = createdRetryBooking.managePath
    ?.split("/")
    .at(-1);
  if (
    createdRetryBooking.status !== "pending" ||
    !createdRetryManageToken ||
    createdRetryManageToken !== retryBeforeFailure?.externalId ||
    retryBeforeFailure.bookingStatus !== "pending" ||
    String(retryBeforeFailure.repId) !== createdRepId ||
    String(retryBeforeFailure.decisionRepId) !== createdRepId ||
    !retryBeforeFailure.bookedAt ||
    Number(retryBeforeFailure.crmJobs) !== 1 ||
    Number(retryBeforeFailure.calendarJobs) !== 1 ||
    retryBeforeFailure.calendarJobStatus !== "pending" ||
    Number(retryBeforeFailure.calendarAttempts) !== 0 ||
    retryBeforeFailure.calendarExternalAccountId !==
      integrationGoogleAccountId ||
    retryBeforeFailure.calendarJobAccountId !== integrationGoogleAccountId
  ) {
    throw new Error("Smart Link retry fixture was not created exactly once.");
  }

  await testDatabase`
    UPDATE jobs
    SET attempts = 5, result = '{"stale":"must-clear"}'::jsonb
    WHERE id = ${retryBeforeFailure.calendarJobId}
  `;
  const retryFailureClaim = await claimJobForIntegration(
    Number(retryBeforeFailure.calendarJobId),
    5,
  );
  await repository.failJob(
    Number(retryBeforeFailure.calendarJobId),
    retryFailureClaim,
    "integration terminal calendar failure",
  );
  const [automaticRouterReconciliation] = await testDatabase`
    SELECT b.status AS booking_status, b.last_error AS booking_error,
           reconcile.id, reconcile.status, reconcile.payload
    FROM bookings b
    JOIN jobs reconcile
      ON reconcile.type = 'calendar.event.create.reconcile'
     AND reconcile.payload->>'bookingId' = b.id::text
    WHERE b.id = ${retryBeforeFailure.bookingId}
      AND reconcile.payload->>'reconciliationIntent' = 'resolve'
    ORDER BY reconcile.id DESC
    LIMIT 1
  `;
  const automaticRouterReconciliationPayload =
    automaticRouterReconciliation?.payload as
      | Record<string, unknown>
      | undefined;
  if (
    automaticRouterReconciliation?.bookingStatus !== "pending" ||
    automaticRouterReconciliation.bookingError !== null ||
    automaticRouterReconciliation.status !== "pending" ||
    Number(automaticRouterReconciliationPayload?.reconciliationForJobId) !==
      Number(retryBeforeFailure.calendarJobId) ||
    automaticRouterReconciliationPayload?.calendarExternalAccountId !==
      integrationGoogleAccountId
  ) {
    throw new Error(
      "An exhausted Smart Link create did not enter durable provider reconciliation while retaining its slot.",
    );
  }
  // Preserve a stopped/upgrade recovery fixture for the manual manage-token
  // recovery APIs after proving new runtime failures reconcile automatically.
  await testDatabase.begin(async (transaction) => {
    await transaction`
      UPDATE jobs
      SET status = 'failed', completed_at = now(),
          last_error = 'integration stopped reconciliation'
      WHERE id = ${automaticRouterReconciliation!.id}
    `;
    await transaction`
      UPDATE bookings
      SET status = 'failed', last_error = 'integration terminal calendar failure'
      WHERE id = ${retryBeforeFailure.bookingId}
    `;
  });
  const retryAfterFailure = await retryEvidence();
  if (
    retryAfterFailure?.bookingStatus !== "failed" ||
    retryAfterFailure.bookingError !==
      "integration terminal calendar failure" ||
    retryAfterFailure.calendarJobStatus !== "failed" ||
    Number(retryAfterFailure.calendarAttempts) !== 5 ||
    retryAfterFailure.calendarError !==
      "integration terminal calendar failure" ||
    (retryAfterFailure.calendarResult as { stale?: string } | null)?.stale !==
      "must-clear"
  ) {
    throw new Error("Smart Link calendar failure did not become terminal.");
  }
  const managedRetryContextBeforeProof =
    await repository.managedRouterLinkBookingRetryContext(
      createdRetryManageToken,
    );
  const managedFailedRouter = await repository.managedBooking(
    createdRetryManageToken,
  );
  if (
    managedRetryContextBeforeProof?.status !== "failed" ||
    managedRetryContextBeforeProof.externalEventId !== null ||
    managedRetryContextBeforeProof.calendarExternalAccountId !==
      integrationGoogleAccountId ||
    managedFailedRouter?.externalEventId !== null ||
    managedFailedRouter.transactionId !==
      String(retryBeforeFailure.externalId) ||
    managedFailedRouter.previousStartsAt !== null ||
    managedFailedRouter.previousEndsAt !== null ||
    !managedFailedRouter.failedRouterCreate
  ) {
    throw new Error(
      "A manage token did not resolve its exact failed Smart Link recovery context.",
    );
  }
  let unquotedRetryRejected = false;
  try {
    await repository.retryManagedRouterLinkBooking(createdRetryManageToken);
  } catch (error) {
    unquotedRetryRejected = error instanceof CalendarSlotUnavailableError;
  }
  if (!unquotedRetryRejected) {
    throw new Error(
      "A failed create with no owned provider event retried without a fresh calendar quote.",
    );
  }
  const quotedManagedRetry = await repository.retryManagedRouterLinkBooking(
    createdRetryManageToken,
    createdRepCalendarQuote,
  );
  if (quotedManagedRetry?.status !== "pending") {
    throw new Error(
      "A manage-token retry with an exact current calendar quote did not restart the same booking.",
    );
  }
  await testDatabase`
    UPDATE jobs SET attempts = 5
    WHERE id = ${retryAfterFailure.calendarJobId}
  `;
  const quotedManagedRetryFailureClaim = await claimJobForIntegration(
    Number(retryAfterFailure.calendarJobId),
    5,
  );
  await repository.failJob(
    Number(retryAfterFailure.calendarJobId),
    quotedManagedRetryFailureClaim,
    "integration repeated terminal calendar failure",
  );
  const [repeatedAutomaticReconciliation] = await testDatabase`
    SELECT id FROM jobs
    WHERE type = 'calendar.event.create.reconcile'
      AND payload->>'bookingId' = ${String(retryAfterFailure.bookingId)}
      AND status = 'pending'
    ORDER BY id DESC
    LIMIT 1
  `;
  if (!repeatedAutomaticReconciliation) {
    throw new Error("Repeated Smart Link exhaustion did not reconcile.");
  }
  await testDatabase.begin(async (transaction) => {
    await transaction`
      UPDATE jobs
      SET status = 'failed', completed_at = now(),
          last_error = 'integration stopped repeated reconciliation'
      WHERE id = ${repeatedAutomaticReconciliation.id}
    `;
    await transaction`
      UPDATE bookings
      SET status = 'failed',
          last_error = 'integration repeated terminal calendar failure'
      WHERE id = ${retryAfterFailure.bookingId}
    `;
  });
  await testDatabase.begin(async (transaction) => {
    await transaction`
      UPDATE bookings
      SET calendar_external_account_id = NULL, external_event_id = NULL
      WHERE id = ${retryAfterFailure.bookingId}
    `;
    await transaction`
      UPDATE jobs
      SET payload = payload - 'calendarExternalAccountId'
      WHERE id = ${retryAfterFailure.calendarJobId}
    `;
  });
  const legacyRouterRetryContext =
    await repository.routerLinkBookingRetryContext(
      temporaryOrganizationSlug,
      "qualified-company",
      retrySessionToken,
    );
  const legacyRouterRepairContext =
    await repository.legacyBookingCalendarAccountRepairContext(
      createdRetryManageToken,
    );
  if (
    legacyRouterRetryContext?.calendarExternalAccountId !== null ||
    legacyRouterRetryContext?.currentCalendarExternalAccountId !==
      integrationGoogleAccountId ||
    legacyRouterRepairContext?.status !== "failed" ||
    legacyRouterRepairContext.externalEventId !== null
  ) {
    throw new Error(
      "A legacy failed Smart Link booking did not expose its current same-provider account for positive lookup.",
    );
  }
  const legacyRouterBound = await repository.bindLegacyBookingCalendarAccount(
    createdRetryManageToken,
    {
      calendarExternalAccountId: integrationGoogleAccountId,
      externalEventId: "integration-legacy-router-event",
      startsAt: retryStartsAt,
      endsAt: retryEndsAt,
    },
  );
  const retryAfterLegacyRouterBinding = await retryEvidence();
  if (
    !legacyRouterBound ||
    retryAfterLegacyRouterBinding?.bookingStatus !== "failed" ||
    retryAfterLegacyRouterBinding.calendarJobStatus !== "failed" ||
    retryAfterLegacyRouterBinding.calendarExternalAccountId !==
      integrationGoogleAccountId ||
    retryAfterLegacyRouterBinding.calendarJobAccountId !==
      integrationGoogleAccountId
  ) {
    throw new Error(
      "Positive provider proof did not bind a failed Smart Link booking without restarting it.",
    );
  }
  const knownAccountGuardExternalId = randomUUID();
  const [knownAccountGuardBooking] = await testDatabase`
    INSERT INTO bookings (
      organization_id, meeting_type_id, rep_id, external_id,
      manage_token_hash, status, attendee_name, attendee_email,
      attendee_notifications_enabled, starts_at, ends_at,
      calendar_provider, calendar_external_account_id, conference_provider,
      last_error
    ) VALUES (
      ${organizationId}, ${createdMeetingTypeId}, ${createdRepId},
      ${knownAccountGuardExternalId},
      ${createHash("sha256").update(knownAccountGuardExternalId).digest("hex")},
      'failed', 'Known Account Guard', 'known-account-guard@example.com', false,
      '2032-09-01T14:00:00.000Z', '2032-09-01T14:30:00.000Z',
      'google', ${integrationGoogleAccountId}, 'none',
      'provider outcome requires reconciliation'
    )
    RETURNING id
  `;
  const retryAccountA = await repository.getRepCalendarConnection(
    temporaryOrganizationSlug,
    createdRepId,
    "google",
  );
  if (!retryAccountA) throw new Error("Retry calendar account was not found.");
  let activeAccountReconnectRejected = false;
  try {
    await repository.saveRepCalendarConnection(
      {
        ...retryAccountA,
        encryptedAccessToken: "retry-account-b-access",
        encryptedRefreshToken: "retry-account-b-refresh",
        externalAccountId: integrationRetryAccountBId,
        externalAccountName: "Retry account B",
      },
      { preserveCalendarSources: true },
    );
  } catch (error) {
    activeAccountReconnectRejected =
      error instanceof CalendarAccountIdentityError;
  }
  const accountAfterRejectedReconnect =
    await repository.getRepCalendarConnection(
      temporaryOrganizationSlug,
      createdRepId,
      "google",
    );
  if (
    !activeAccountReconnectRejected ||
    accountAfterRejectedReconnect?.externalAccountId !==
      integrationGoogleAccountId
  ) {
    throw new Error(
      "A reconnect replaced the account that still owns a future or unresolved booking.",
    );
  }
  await testDatabase`
    DELETE FROM bookings WHERE id = ${knownAccountGuardBooking!.id}
  `;
  // Simulate out-of-band database corruption to prove every lifecycle mutation
  // still fails closed even if the repository reconnect guard is bypassed.
  await testDatabase`
    UPDATE rep_calendar_connections
    SET external_account_id = ${integrationRetryAccountBId},
        encrypted_access_token = 'retry-account-b-access',
        encrypted_refresh_token = 'retry-account-b-refresh'
    WHERE rep_id = ${createdRepId} AND provider = 'google'
  `;
  await repository.saveRepCalendarConnection({
    organizationSlug: temporaryOrganizationSlug,
    repId: duplicateAccountRepId,
    provider: "google",
    encryptedAccessToken: "moved-account-access-token",
    encryptedRefreshToken: "moved-account-refresh-token",
    expiresAt: new Date("2027-08-24T00:00:00.000Z"),
    scopes: ["https://www.googleapis.com/auth/calendar.events"],
    externalAccountId: integrationGoogleAccountId,
    externalAccountName: "Moved integration calendar",
    metadata: {},
  });
  let movedAccountOverlapCode: string | undefined;
  try {
    const movedAccountProbe = `moved-account-overlap-${randomUUID()}`;
    await testDatabase`
      INSERT INTO bookings (
        organization_id, meeting_type_id, rep_id, external_id,
        manage_token_hash, status, attendee_name, attendee_email,
        starts_at, ends_at, calendar_provider,
        calendar_external_account_id, conference_provider
      ) VALUES (
        ${organizationId}, ${createdMeetingTypeId}, ${duplicateAccountRepId},
        ${movedAccountProbe},
        ${createHash("sha256").update(movedAccountProbe).digest("hex")},
        'pending', 'Moved Account Overlap', 'moved-overlap@example.com',
        ${retryStartsAt}, ${retryEndsAt}, 'google',
        ${integrationGoogleAccountId}, 'none'
      )
    `;
  } catch (error) {
    movedAccountOverlapCode = (error as { code?: string }).code;
  } finally {
    await testDatabase`
      DELETE FROM rep_calendar_connections
      WHERE rep_id = ${duplicateAccountRepId} AND provider = 'google'
    `;
  }
  if (movedAccountOverlapCode !== "23P01") {
    throw new Error(
      "A provider account moved to another representative accepted an overlapping booking.",
    );
  }
  let accountChangedRetryRejected = false;
  let accountChangedAbandonRejected = false;
  try {
    await repository.retryRouterLinkBooking(
      temporaryOrganizationSlug,
      "qualified-company",
      retrySessionToken,
    );
  } catch (error) {
    accountChangedRetryRejected = error instanceof CalendarAccountIdentityError;
  }
  try {
    await repository.abandonRouterLinkBooking(
      temporaryOrganizationSlug,
      "qualified-company",
      retrySessionToken,
      {
        externalEventId: "must-not-persist-account-b-event",
        webLink: null,
        conferenceUrl: null,
      },
    );
  } catch (error) {
    accountChangedAbandonRejected =
      error instanceof CalendarAccountIdentityError;
  } finally {
    await testDatabase`
      UPDATE rep_calendar_connections
      SET external_account_id = ${integrationGoogleAccountId},
          encrypted_access_token = 'integration-access-token',
          encrypted_refresh_token = 'integration-refresh-token'
      WHERE rep_id = ${createdRepId} AND provider = 'google'
    `;
  }
  const retryAfterAccountMismatch = await retryEvidence();
  if (
    !accountChangedRetryRejected ||
    !accountChangedAbandonRejected ||
    retryAfterAccountMismatch?.bookingStatus !== "failed" ||
    retryAfterAccountMismatch.calendarJobStatus !== "failed"
  ) {
    throw new Error(
      "A booking bound to account A mutated after the connection became account B.",
    );
  }

  await repository.saveRouterLink({
    organizationSlug: temporaryOrganizationSlug,
    id: createdRouterLinkId,
    name: "Qualified company router",
    slug: "qualified-company-renamed",
    title: "Find the right representative",
    description: "Answer two questions, then choose a time.",
    buttonLabel: "Find my time",
    noMatchMessage: "Thanks — our team will follow up.",
    accentColor: "#f97316",
    active: true,
    questions: [routerQuestion, routerStateQuestion],
    destinations: [
      { poolId: createdPoolId, meetingTypeId: createdMeetingTypeId },
    ],
  });
  const oldPublicRouter = await repository.publicRouterLink(
    temporaryOrganizationSlug,
    "qualified-company",
  );
  const aliasedRouter = await repository.recoverableRouterLinkIdentity(
    temporaryOrganizationSlug,
    "qualified-company",
  );
  const currentRenamedRouter = await repository.publicRouterLink(
    temporaryOrganizationSlug,
    "qualified-company-renamed",
  );
  let oldSlugReuseRejected = false;
  try {
    await repository.saveRouterLink({
      organizationSlug: temporaryOrganizationSlug,
      name: "Conflicting old slug",
      slug: "qualified-company",
      title: "Conflicting old slug",
      description: "Must not replace the stable alias.",
      buttonLabel: "Find my time",
      noMatchMessage: "Thanks — our team will follow up.",
      accentColor: "#f97316",
      active: false,
      questions: [],
      destinations: [],
    });
  } catch (error) {
    oldSlugReuseRejected =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505";
  }
  if (
    oldPublicRouter !== null ||
    aliasedRouter?.id !== createdRouterLinkId ||
    aliasedRouter.slug !== "qualified-company-renamed" ||
    !aliasedRouter.active ||
    currentRenamedRouter?.id !== createdRouterLinkId ||
    currentRenamedRouter.successRedirectUrl !==
      "https://www.example.com/thank-you?booked=1" ||
    currentRenamedRouter.successRedirectDelaySeconds !== 4 ||
    !oldSlugReuseRejected
  ) {
    throw new Error(
      "Smart Link rename aliases did not isolate public qualification, preserve recovery identity, and reserve the old slug.",
    );
  }
  const renamedLinkBookingStatus = await repository.routerLinkBookingStatus(
    temporaryOrganizationSlug,
    "qualified-company",
    retrySessionToken,
  );

  const retryContext = await repository.routerLinkBookingRetryContext(
    temporaryOrganizationSlug,
    "qualified-company",
    retrySessionToken,
  );
  if (
    renamedLinkBookingStatus?.status !== "failed" ||
    retryContext?.status !== "failed" ||
    retryContext.organizationSlug !== temporaryOrganizationSlug ||
    retryContext.repId !== createdRepId ||
    retryContext.startsAt !== retryStartsAt.toISOString() ||
    retryContext.endsAt !== retryEndsAt.toISOString() ||
    retryContext.transactionId !== String(retryBeforeFailure.externalId) ||
    retryContext.externalEventId !== "integration-legacy-router-event" ||
    retryContext.calendarProvider !== "google" ||
    retryContext.calendarExternalAccountId !== integrationGoogleAccountId ||
    retryContext.currentCalendarExternalAccountId !==
      integrationGoogleAccountId ||
    retryContext.schedule?.meetingTypeId !== createdMeetingTypeId ||
    !retryContext.schedule.reps.some((rep) => rep.id === createdRepId)
  ) {
    throw new Error(
      "Smart Link retry context did not preserve its assigned rep and exact slot.",
    );
  }

  const managedRetryContext =
    await repository.managedRouterLinkBookingRetryContext(
      createdRetryManageToken,
    );
  if (
    managedRetryContext?.transactionId !== retryContext.transactionId ||
    managedRetryContext.externalEventId !== "integration-legacy-router-event" ||
    managedRetryContext.repId !== createdRepId
  ) {
    throw new Error(
      "Manage-token recovery did not preserve the failed Smart Link booking identity.",
    );
  }

  const retriedBooking = await repository.retryManagedRouterLinkBooking(
    createdRetryManageToken,
  );
  const retryAfterReset = await retryEvidence();
  if (
    retriedBooking?.status !== "pending" ||
    retriedBooking.managePath !== createdRetryBooking.managePath ||
    retryAfterReset?.bookingStatus !== "pending" ||
    retryAfterReset.bookingError !== null ||
    retryAfterReset.calendarJobStatus !== "pending" ||
    Number(retryAfterReset.calendarAttempts) !== 0 ||
    retryAfterReset.calendarResult !== null ||
    retryAfterReset.calendarError !== null ||
    retryAfterReset.calendarCompletedAt !== null ||
    String(retryAfterReset.bookingId) !==
      String(retryBeforeFailure.bookingId) ||
    String(retryAfterReset.externalId) !==
      String(retryBeforeFailure.externalId) ||
    String(retryAfterReset.routingDecisionId) !==
      String(retryBeforeFailure.routingDecisionId) ||
    String(retryAfterReset.repId) !== String(retryBeforeFailure.repId) ||
    String(retryAfterReset.routerSessionId) !==
      String(retryBeforeFailure.routerSessionId) ||
    String(retryAfterReset.decisionRepId) !==
      String(retryBeforeFailure.decisionRepId) ||
    String(retryAfterReset.calendarJobId) !==
      String(retryBeforeFailure.calendarJobId) ||
    String(retryAfterReset.crmJobId) !== String(retryBeforeFailure.crmJobId) ||
    Number(retryAfterReset.assignments) !==
      Number(retryBeforeFailure.assignments) ||
    new Date(String(retryAfterReset.lastAssignedAt)).getTime() !==
      new Date(String(retryBeforeFailure.lastAssignedAt)).getTime() ||
    new Date(String(retryAfterReset.bookedAt)).getTime() !==
      new Date(String(retryBeforeFailure.bookedAt)).getTime() ||
    Number(retryAfterReset.crmJobs) !== 1 ||
    Number(retryAfterReset.calendarJobs) !== 1
  ) {
    throw new Error(
      "Retrying a failed Smart Link booking changed its durable assignment.",
    );
  }

  const pendingRetryRunAt = new Date("2026-08-31T12:00:00.000Z");
  await testDatabase`
    UPDATE jobs
    SET attempts = 1, last_error = 'integration automatic retry pending',
        run_at = ${pendingRetryRunAt}
    WHERE id = ${retryBeforeFailure.calendarJobId}
  `;
  const repeatedRetry = await repository.retryRouterLinkBooking(
    temporaryOrganizationSlug,
    "qualified-company",
    retrySessionToken,
  );
  const retryAfterRepeat = await retryEvidence();
  if (
    repeatedRetry?.status !== "pending" ||
    repeatedRetry.managePath !== createdRetryBooking.managePath ||
    retryAfterRepeat?.bookingStatus !== "pending" ||
    retryAfterRepeat.calendarJobStatus !== "pending" ||
    Number(retryAfterRepeat.calendarAttempts) !== 1 ||
    retryAfterRepeat.calendarError !== "integration automatic retry pending" ||
    new Date(String(retryAfterRepeat.calendarRunAt)).getTime() !==
      pendingRetryRunAt.getTime() ||
    String(retryAfterRepeat.bookingId) !==
      String(retryBeforeFailure.bookingId) ||
    String(retryAfterRepeat.routingDecisionId) !==
      String(retryBeforeFailure.routingDecisionId) ||
    String(retryAfterRepeat.repId) !== String(retryBeforeFailure.repId) ||
    String(retryAfterRepeat.calendarJobId) !==
      String(retryBeforeFailure.calendarJobId) ||
    String(retryAfterRepeat.crmJobId) !== String(retryBeforeFailure.crmJobId) ||
    Number(retryAfterRepeat.assignments) !==
      Number(retryBeforeFailure.assignments) ||
    Number(retryAfterRepeat.crmJobs) !== 1 ||
    Number(retryAfterRepeat.calendarJobs) !== 1
  ) {
    throw new Error("Repeated Smart Link retry was not idempotently pending.");
  }

  await testDatabase`
    UPDATE jobs
    SET attempts = 5,
        result = '{"providerEvidence":"must-preserve"}'::jsonb
    WHERE id = ${retryBeforeFailure.calendarJobId}
  `;
  const abandonFailureClaim = await claimJobForIntegration(
    Number(retryBeforeFailure.calendarJobId),
    5,
  );
  await repository.failJob(
    Number(retryBeforeFailure.calendarJobId),
    abandonFailureClaim,
    "integration abandoned calendar failure",
  );
  const [abandonResolveReconciliation] = await testDatabase`
    SELECT id FROM jobs
    WHERE type = 'calendar.event.create.reconcile'
      AND payload->>'bookingId' = ${String(retryBeforeFailure.bookingId)}
      AND payload->>'reconciliationIntent' = 'resolve'
      AND status = 'pending'
    ORDER BY id DESC
    LIMIT 1
  `;
  if (!abandonResolveReconciliation) {
    throw new Error("Smart Link abandon fixture did not reconcile first.");
  }
  await testDatabase.begin(async (transaction) => {
    await transaction`
      UPDATE jobs
      SET status = 'failed', completed_at = now(),
          last_error = 'integration stopped abandon reconciliation'
      WHERE id = ${abandonResolveReconciliation.id}
    `;
    await transaction`
      UPDATE bookings
      SET status = 'failed', last_error = 'integration abandoned calendar failure'
      WHERE id = ${retryBeforeFailure.bookingId}
    `;
  });
  const abandonBefore = await retryEvidence();
  await testDatabase`
    UPDATE meeting_types SET active = false
    WHERE id = ${createdMeetingTypeId}
  `;
  const inactiveRetryContext = await repository.routerLinkBookingRetryContext(
    temporaryOrganizationSlug,
    "qualified-company",
    retrySessionToken,
  );
  const managedWhileMeetingTypeInactive =
    await repository.managedBooking(smartManageToken);
  if (
    inactiveRetryContext?.schedule !== null ||
    inactiveRetryContext?.repId !== createdRepId ||
    inactiveRetryContext?.transactionId !==
      String(retryBeforeFailure.externalId) ||
    inactiveRetryContext?.calendarProvider !== "google" ||
    managedWhileMeetingTypeInactive?.rescheduleSchedule?.reps[0]?.id !==
      createdRepId ||
    managedWhileMeetingTypeInactive.rescheduleSchedule.reps[0]
      .calendarExternalAccountId !== integrationGoogleAccountId
  ) {
    throw new Error(
      "Provider reconciliation or managed rescheduling depended on an active meeting type.",
    );
  }
  const reconciledProviderEvent = {
    externalEventId: "integration-legacy-router-event",
    webLink: "https://calendar.example.com/integration-legacy-router-event",
    conferenceUrl: null,
  };
  const abandonedBooking = await repository.abandonManagedRouterLinkBooking(
    createdRetryManageToken,
    null,
  );
  const [closeReconciliation] = await testDatabase`
    SELECT reconcile_job.id, reconcile_job.status,
      (SELECT count(*)::int FROM jobs cancel_job
       WHERE cancel_job.type = 'calendar.event.cancel'
         AND cancel_job.payload->>'bookingId' =
           ${String(retryBeforeFailure.bookingId)}) AS cancel_jobs
    FROM jobs reconcile_job
    WHERE reconcile_job.type = 'calendar.event.create.reconcile'
      AND reconcile_job.payload->>'bookingId' =
        ${String(retryBeforeFailure.bookingId)}
      AND reconcile_job.payload->>'reconciliationIntent' = 'close'
    ORDER BY reconcile_job.id DESC
    LIMIT 1
  `;
  if (
    abandonedBooking?.status !== "cancel_pending" ||
    closeReconciliation?.status !== "pending" ||
    Number(closeReconciliation.cancelJobs) !== 0
  ) {
    throw new Error(
      "One provider miss released or cancelled a failed Smart Link booking.",
    );
  }
  const closeReconciliationClaim = await claimJobForIntegration(
    Number(closeReconciliation.id),
  );
  await repository.completeJob(
    Number(closeReconciliation.id),
    closeReconciliationClaim,
    { found: true, ...reconciledProviderEvent },
  );
  const abandonAfter = await retryEvidence();
  const repeatedAbandon = await repository.abandonRouterLinkBooking(
    temporaryOrganizationSlug,
    "qualified-company",
    retrySessionToken,
    null,
  );
  const abandonAfterRepeat = await retryEvidence();
  await testDatabase`
    UPDATE meeting_types SET active = true
    WHERE id = ${createdMeetingTypeId}
  `;
  const [reconciliationCancel] = await testDatabase`
    SELECT b.status, b.external_event_id, b.external_event_web_link,
           b.cancelled_at, j.id AS cancel_job_id, j.status AS cancel_job_status,
           j.payload, j.attempts,
      (SELECT count(*)::int FROM jobs message
       WHERE message.type = 'email.booking.cancelled'
         AND message.payload->>'bookingId' = b.id::text) AS cancellation_emails
    FROM bookings b
    JOIN jobs j ON j.type = 'calendar.event.cancel'
      AND j.payload->>'bookingId' = b.id::text
    WHERE b.id = ${retryBeforeFailure.bookingId}
    ORDER BY j.id DESC
    LIMIT 1
  `;
  if (
    abandonBefore?.bookingStatus !== "failed" ||
    abandonedBooking?.status !== "cancel_pending" ||
    abandonedBooking.startsAt !== retryStartsAt.toISOString() ||
    abandonedBooking.endsAt !== retryEndsAt.toISOString() ||
    repeatedAbandon?.status !== "cancel_pending" ||
    abandonAfter?.bookingStatus !== "cancel_pending" ||
    abandonAfter.cancelledAt !== null ||
    abandonAfterRepeat?.bookingStatus !== "cancel_pending" ||
    abandonAfter.bookingError !== "integration abandoned calendar failure" ||
    abandonAfter.calendarJobStatus !== "failed" ||
    Number(abandonAfter.calendarAttempts) !== 5 ||
    (abandonAfter.calendarResult as { providerEvidence?: string } | null)
      ?.providerEvidence !== "must-preserve" ||
    abandonAfter.calendarError !== "integration abandoned calendar failure" ||
    String(abandonAfter.calendarCompletedAt) !==
      String(abandonBefore.calendarCompletedAt) ||
    String(abandonAfter.bookingId) !== String(abandonBefore.bookingId) ||
    String(abandonAfter.routingDecisionId) !==
      String(abandonBefore.routingDecisionId) ||
    String(abandonAfter.repId) !== String(abandonBefore.repId) ||
    String(abandonAfter.calendarJobId) !==
      String(abandonBefore.calendarJobId) ||
    String(abandonAfter.crmJobId) !== String(abandonBefore.crmJobId) ||
    Number(abandonAfter.assignments) !== Number(abandonBefore.assignments) ||
    Number(abandonAfter.crmJobs) !== 1 ||
    Number(abandonAfter.calendarJobs) !== 1 ||
    String(abandonAfterRepeat?.bookingId) !== String(abandonAfter.bookingId) ||
    abandonAfterRepeat?.calendarJobStatus !== "failed" ||
    reconciliationCancel?.status !== "cancel_pending" ||
    reconciliationCancel.externalEventId !==
      reconciledProviderEvent.externalEventId ||
    reconciliationCancel.externalEventWebLink !==
      reconciledProviderEvent.webLink ||
    reconciliationCancel.cancelJobStatus !== "pending" ||
    (reconciliationCancel.payload as { suppressLifecycleEmail?: boolean })
      .suppressLifecycleEmail !== true ||
    Number(reconciliationCancel.cancellationEmails) !== 0
  ) {
    throw new Error(
      `Abandoning a failed Smart Link booking changed durable provider or assignment evidence: ${JSON.stringify(
        {
          abandonedBooking,
          repeatedAbandon,
          abandonBefore,
          abandonAfter,
          abandonAfterRepeat,
        },
      )}`,
    );
  }

  const reconciliationSlotBlocked = async () => {
    try {
      await repository.enqueuePublicBooking({
        organizationSlug: temporaryOrganizationSlug,
        schedulingSlug: "qualified-team",
        meetingTypeId: createdMeetingTypeId,
        candidateQuotes: [createdRepCalendarQuote],
        externalId: `ghost-overlap-${randomUUID()}`,
        startsAt: new Date("2026-08-24T16:10:00.000Z"),
        endsAt: new Date("2026-08-24T16:40:00.000Z"),
        attendeeName: "Ghost overlap",
        attendeeEmail: "ghost-overlap@example.com",
        subject: "Ghost overlap",
        conferenceProvider: "none",
        reminderMinutes: 0,
      });
      return false;
    } catch (error) {
      return error instanceof CalendarSlotUnavailableError;
    }
  };
  if (!(await reconciliationSlotBlocked())) {
    throw new Error(
      "Provider cleanup pending did not keep its range reserved.",
    );
  }

  await testDatabase`
    UPDATE jobs SET attempts = 5
    WHERE id = ${reconciliationCancel!.cancelJobId}
  `;
  const reconciliationFailureClaim = await claimJobForIntegration(
    Number(reconciliationCancel!.cancelJobId),
    5,
  );
  await repository.failJob(
    Number(reconciliationCancel!.cancelJobId),
    reconciliationFailureClaim,
    "integration provider cleanup failure",
  );
  const terminalCleanupStatus = await repository.routerLinkBookingStatus(
    temporaryOrganizationSlug,
    "qualified-company",
    retrySessionToken,
  );
  if (
    terminalCleanupStatus?.status !== "confirmed" ||
    terminalCleanupStatus.error !== "integration provider cleanup failure" ||
    terminalCleanupStatus.startsAt !== retryStartsAt.toISOString() ||
    terminalCleanupStatus.endsAt !== retryEndsAt.toISOString() ||
    !(await reconciliationSlotBlocked())
  ) {
    throw new Error(
      "Terminal provider cleanup failure did not stay visible and reserved.",
    );
  }

  const reconciliationCompletionClaim = randomUUID();
  await testDatabase.begin(async (transaction) => {
    await transaction`
      UPDATE bookings SET status = 'cancel_pending'
      WHERE id = ${retryBeforeFailure.bookingId}
    `;
    await transaction`
      UPDATE jobs SET status = 'processing', attempts = 1,
          locked_at = now(), claim_token = ${reconciliationCompletionClaim},
          last_error = null
      WHERE id = ${reconciliationCancel!.cancelJobId}
    `;
  });
  await repository.completeJob(
    Number(reconciliationCancel!.cancelJobId),
    reconciliationCompletionClaim,
    { externalEventId: reconciledProviderEvent.externalEventId },
  );
  const [completedCleanup] = await testDatabase`
    SELECT b.status, b.cancelled_at, j.status AS cancel_job_status,
      (SELECT count(*)::int FROM jobs message
       WHERE message.type = 'email.booking.cancelled'
         AND message.payload->>'bookingId' = b.id::text) AS cancellation_emails
    FROM bookings b
    JOIN jobs j ON j.id = ${reconciliationCancel!.cancelJobId}
    WHERE b.id = ${retryBeforeFailure.bookingId}
  `;
  const completedAbandon = await repository.abandonRouterLinkBooking(
    temporaryOrganizationSlug,
    "qualified-company",
    retrySessionToken,
    null,
  );
  if (
    completedCleanup?.status !== "cancelled" ||
    !completedCleanup.cancelledAt ||
    completedCleanup.cancelJobStatus !== "completed" ||
    Number(completedCleanup.cancellationEmails) !== 0 ||
    completedAbandon?.status !== "cancelled"
  ) {
    throw new Error(
      "Owned provider event cleanup did not complete without duplicate lifecycle email.",
    );
  }
  const releasedGhostSlot = await repository.enqueuePublicBooking({
    organizationSlug: temporaryOrganizationSlug,
    schedulingSlug: "qualified-team",
    meetingTypeId: createdMeetingTypeId,
    candidateQuotes: [createdRepCalendarQuote],
    externalId: `released-ghost-slot-${randomUUID()}`,
    startsAt: retryStartsAt,
    endsAt: retryEndsAt,
    attendeeName: "Released ghost slot",
    attendeeEmail: "released-ghost-slot@example.com",
    subject: "Released ghost slot",
    conferenceProvider: "none",
    reminderMinutes: 0,
  });
  if (releasedGhostSlot.status !== "pending") {
    throw new Error("Successful provider cleanup did not release the range.");
  }

  const [attendanceCandidate] = await testDatabase`
    SELECT b.id
    FROM bookings b
    JOIN organizations o ON o.id = b.organization_id
    WHERE o.slug = ${temporaryOrganizationSlug}
      AND b.status = 'confirmed'
      AND b.ends_at <= now()
    ORDER BY b.ends_at DESC
    LIMIT 1
  `;
  const [ineligibleAttendanceCandidate] = await testDatabase`
    SELECT b.id
    FROM bookings b
    JOIN organizations o ON o.id = b.organization_id
    WHERE o.slug = ${temporaryOrganizationSlug}
      AND b.external_id = ${bufferedFirstExternalId}
  `;
  if (!attendanceCandidate || !ineligibleAttendanceCandidate) {
    throw new Error("Reporting attendance fixtures were not available.");
  }
  const attendanceRecorded = await repository.recordBookingAttendance({
    organizationSlug: temporaryOrganizationSlug,
    bookingId: String(attendanceCandidate.id),
    outcome: "no_show",
  });
  const pendingAttendanceRejected = await repository.recordBookingAttendance({
    organizationSlug: temporaryOrganizationSlug,
    bookingId: String(ineligibleAttendanceCandidate.id),
    outcome: "attended",
  });
  const reporting = await repository.reporting(temporaryOrganizationSlug, 90);
  const googleDelivery = reporting.calendarDelivery.find(
    (delivery) => delivery.provider === "google",
  );
  const outlookDelivery = reporting.calendarDelivery.find(
    (delivery) => delivery.provider === "microsoft",
  );
  if (
    !attendanceRecorded ||
    pendingAttendanceRejected ||
    reporting.funnel.submissions < 1 ||
    reporting.funnel.qualified < 1 ||
    reporting.funnel.bookings < 1 ||
    reporting.bookingHealth.total < 1 ||
    reporting.bookingHealth.noShows < 1 ||
    !reporting.routerLinks.some(
      (router) => router.id === createdRouterLinkId,
    ) ||
    !reporting.reps.some((rep) => rep.id === createdRepId && rep.routes > 0) ||
    !googleDelivery ||
    googleDelivery.total < 1 ||
    !outlookDelivery ||
    reporting.recentMeetings.length < 1
  ) {
    throw new Error(
      `Operator reporting did not preserve scoped conversion, delivery, and attendance evidence: ${JSON.stringify(reporting)}`,
    );
  }

  const capacityUpdated = await repository.updateOperatorRepWorkingHours({
    organizationId,
    operatorId: String(operatorAccount!.id),
    repId: createdRepId,
    timezone: operatorCalendarProfile.rep.timezone,
    availability: operatorCalendarProfile.rep.availability,
    availabilityOverrides: operatorCalendarProfile.rep.availabilityOverrides,
    availabilityScheduleId: null,
    dailyMeetingLimit: 1,
    weeklyMeetingLimit: null,
  });
  const capacitySchedule = await repository.publicSchedule(
    temporaryOrganizationSlug,
    "test-representative",
  );
  if (
    !capacityUpdated ||
    capacitySchedule?.reps[0]?.dailyMeetingLimit !== 1 ||
    capacitySchedule.reps[0]?.weeklyMeetingLimit !== null
  ) {
    throw new Error("Representative meeting capacity did not save or reload.");
  }

  const capacityFirstExternalId = randomUUID();
  const capacitySecondExternalId = randomUUID();
  const capacityStartsAt = new Date("2042-02-03T10:00:00.000Z");
  const capacityEndsAt = new Date("2042-02-03T10:30:00.000Z");
  const [capacityFirst] = await testDatabase`
    INSERT INTO bookings (
      organization_id, meeting_type_id, rep_id, external_id,
      manage_token_hash, status, attendee_name, attendee_email,
      attendee_notifications_enabled, starts_at, ends_at,
      calendar_provider, calendar_external_account_id, conference_provider
    ) VALUES (
      ${organizationId}, ${createdMeetingTypeId}, ${createdRepId},
      ${capacityFirstExternalId},
      ${createHash("sha256").update(capacityFirstExternalId).digest("hex")},
      'confirmed', 'Capacity One', 'capacity-one@example.com', false,
      ${capacityStartsAt}, ${capacityEndsAt},
      'google', ${integrationGoogleAccountId}, 'none'
    )
    RETURNING id
  `;
  const capacityStarts = await repository.activeBookingCapacityStarts(
    temporaryOrganizationSlug,
    [createdRepId],
    new Date("2042-02-03T00:00:00.000Z"),
    new Date("2042-02-04T00:00:00.000Z"),
  );
  let dailyCapacityRejected = false;
  try {
    await testDatabase`
      INSERT INTO bookings (
        organization_id, meeting_type_id, rep_id, external_id,
        manage_token_hash, status, attendee_name, attendee_email,
        attendee_notifications_enabled, starts_at, ends_at,
        calendar_provider, calendar_external_account_id, conference_provider
      ) VALUES (
        ${organizationId}, ${createdMeetingTypeId}, ${createdRepId},
        ${capacitySecondExternalId},
        ${createHash("sha256").update(capacitySecondExternalId).digest("hex")},
        'confirmed', 'Capacity Two', 'capacity-two@example.com', false,
        '2042-02-03T11:00:00.000Z', '2042-02-03T11:30:00.000Z',
        'google', ${integrationGoogleAccountId}, 'none'
      )
    `;
  } catch (error) {
    dailyCapacityRejected =
      (error as { code?: string }).code === "23P01" &&
      (error as { constraint_name?: string }).constraint_name ===
        "booking_rep_reservations_meeting_capacity_check";
  }
  await testDatabase`
    UPDATE bookings SET status = 'cancelled' WHERE id = ${capacityFirst!.id}
  `;
  const [capacityAfterCancellation] = await testDatabase`
    INSERT INTO bookings (
      organization_id, meeting_type_id, rep_id, external_id,
      manage_token_hash, status, attendee_name, attendee_email,
      attendee_notifications_enabled, starts_at, ends_at,
      calendar_provider, calendar_external_account_id, conference_provider
    ) VALUES (
      ${organizationId}, ${createdMeetingTypeId}, ${createdRepId},
      ${capacitySecondExternalId},
      ${createHash("sha256").update(capacitySecondExternalId).digest("hex")},
      'confirmed', 'Capacity Two', 'capacity-two@example.com', false,
      '2042-02-03T11:00:00.000Z', '2042-02-03T11:30:00.000Z',
      'google', ${integrationGoogleAccountId}, 'none'
    )
    RETURNING id
  `;
  if (
    !dailyCapacityRejected ||
    capacityStarts.get(createdRepId)?.[0]?.bookingId !==
      String(capacityFirst!.id) ||
    !capacityAfterCancellation
  ) {
    throw new Error(
      "Daily meeting capacity was not enforced or released after cancellation.",
    );
  }
  await testDatabase`
    DELETE FROM bookings WHERE id IN (${capacityFirst!.id}, ${capacityAfterCancellation.id})
  `;
  const weeklyCapacityUpdated = await repository.updateOperatorRepWorkingHours({
    organizationId,
    operatorId: String(operatorAccount!.id),
    repId: createdRepId,
    timezone: operatorCalendarProfile.rep.timezone,
    availability: operatorCalendarProfile.rep.availability,
    availabilityOverrides: operatorCalendarProfile.rep.availabilityOverrides,
    availabilityScheduleId: null,
    dailyMeetingLimit: null,
    weeklyMeetingLimit: 1,
  });
  const weeklyFirstExternalId = randomUUID();
  const weeklySecondExternalId = randomUUID();
  const [weeklyFirst] = await testDatabase`
    INSERT INTO bookings (
      organization_id, meeting_type_id, rep_id, external_id,
      manage_token_hash, status, attendee_name, attendee_email,
      attendee_notifications_enabled, starts_at, ends_at,
      calendar_provider, calendar_external_account_id, conference_provider
    ) VALUES (
      ${organizationId}, ${createdMeetingTypeId}, ${createdRepId},
      ${weeklyFirstExternalId},
      ${createHash("sha256").update(weeklyFirstExternalId).digest("hex")},
      'confirmed', 'Weekly Capacity One', 'weekly-one@example.com', false,
      '2042-02-10T10:00:00.000Z', '2042-02-10T10:30:00.000Z',
      'google', ${integrationGoogleAccountId}, 'none'
    )
    RETURNING id
  `;
  let weeklyCapacityRejected = false;
  try {
    await testDatabase`
      INSERT INTO bookings (
        organization_id, meeting_type_id, rep_id, external_id,
        manage_token_hash, status, attendee_name, attendee_email,
        attendee_notifications_enabled, starts_at, ends_at,
        calendar_provider, calendar_external_account_id, conference_provider
      ) VALUES (
        ${organizationId}, ${createdMeetingTypeId}, ${createdRepId},
        ${weeklySecondExternalId},
        ${createHash("sha256").update(weeklySecondExternalId).digest("hex")},
        'confirmed', 'Weekly Capacity Two', 'weekly-two@example.com', false,
        '2042-02-11T10:00:00.000Z', '2042-02-11T10:30:00.000Z',
        'google', ${integrationGoogleAccountId}, 'none'
      )
    `;
  } catch (error) {
    weeklyCapacityRejected =
      (error as { code?: string }).code === "23P01" &&
      (error as { constraint_name?: string }).constraint_name ===
        "booking_rep_reservations_meeting_capacity_check";
  }
  await testDatabase`DELETE FROM bookings WHERE id = ${weeklyFirst!.id}`;
  if (!weeklyCapacityUpdated || !weeklyCapacityRejected) {
    throw new Error("Weekly meeting capacity was not enforced.");
  }

  await testDatabase`
    UPDATE reps SET weekly_meeting_limit = NULL WHERE id = ${createdRepId}
  `;
  const grandfatheredExternalIdA = randomUUID();
  const grandfatheredExternalIdB = randomUUID();
  const grandfatheredBookings = await testDatabase`
    INSERT INTO bookings (
      organization_id, meeting_type_id, rep_id, external_id,
      manage_token_hash, status, attendee_name, attendee_email,
      attendee_notifications_enabled, starts_at, ends_at,
      calendar_provider, calendar_external_account_id, conference_provider
    ) VALUES
      (
        ${organizationId}, ${createdMeetingTypeId}, ${createdRepId},
        ${grandfatheredExternalIdA},
        ${createHash("sha256").update(grandfatheredExternalIdA).digest("hex")},
        'confirmed', 'Grandfathered One', 'grandfathered-one@example.com', false,
        '2042-02-17T10:00:00.000Z', '2042-02-17T10:30:00.000Z',
        'google', ${integrationGoogleAccountId}, 'none'
      ),
      (
        ${organizationId}, ${createdMeetingTypeId}, ${createdRepId},
        ${grandfatheredExternalIdB},
        ${createHash("sha256").update(grandfatheredExternalIdB).digest("hex")},
        'confirmed', 'Grandfathered Two', 'grandfathered-two@example.com', false,
        '2042-02-18T10:00:00.000Z', '2042-02-18T10:30:00.000Z',
        'google', ${integrationGoogleAccountId}, 'none'
      )
    RETURNING id, external_id
  `;
  await testDatabase`
    UPDATE reps SET weekly_meeting_limit = 1 WHERE id = ${createdRepId}
  `;
  const grandfatheredBookingA = grandfatheredBookings.find(
    (booking) => booking.externalId === grandfatheredExternalIdA,
  );
  const [grandfatheredReschedule] = await testDatabase`
    UPDATE bookings
    SET status = 'reschedule_pending',
        previous_starts_at = starts_at,
        previous_ends_at = ends_at,
        starts_at = '2042-02-19T10:00:00.000Z',
        ends_at = '2042-02-19T10:30:00.000Z'
    WHERE id = ${grandfatheredBookingA!.id}
    RETURNING id
  `;
  await testDatabase`
    DELETE FROM bookings
    WHERE id = ANY(${grandfatheredBookings.map((booking) => String(booking.id))}::uuid[])
  `;
  if (!grandfatheredReschedule) {
    throw new Error(
      "A grandfathered booking could not reuse its existing weekly capacity.",
    );
  }
  const capacityRestored = await repository.updateOperatorRepWorkingHours({
    organizationId,
    operatorId: String(operatorAccount!.id),
    repId: createdRepId,
    timezone: operatorCalendarProfile.rep.timezone,
    availability: operatorCalendarProfile.rep.availability,
    availabilityOverrides: operatorCalendarProfile.rep.availabilityOverrides,
    availabilityScheduleId: null,
    dailyMeetingLimit: operatorCalendarProfile.rep.dailyMeetingLimit,
    weeklyMeetingLimit: operatorCalendarProfile.rep.weeklyMeetingLimit,
  });
  if (!capacityRestored) {
    throw new Error("Representative meeting capacity was not restored.");
  }

  const createdDashboard = await repository.dashboard(
    temporaryOrganizationSlug,
  );
  const createdPreview = await repository.routingPreview({
    organizationSlug: temporaryOrganizationSlug,
    lead: {
      email: "new-lead@example.com",
      company: { employee_count: 75, state: "NY" },
    },
    evaluatedAt: new Date("2026-08-24T12:00:00.000Z"),
  });
  const createdSchedule = await repository.publicSchedule(
    temporaryOrganizationSlug,
    "test-representative",
  );
  if (
    createdDashboard.reps[0]?.id !== createdRepId ||
    createdDashboard.pools[0]?.id !== createdPoolId ||
    createdDashboard.rules[0]?.id !== createdRuleId ||
    !createdDashboard.rules.some((rule) => rule.id === catchAllRuleId) ||
    !createdDashboard.routerLinks.some(
      (link) => link.id === createdRouterLinkId && link.active,
    ) ||
    createdPreview.selectedRep?.id !== createdRepId ||
    createdPreview.rules.at(-1)?.id !== catchAllRuleId ||
    !createdSchedule ||
    createdSchedule.targetType !== "rep" ||
    createdSchedule.reps[0]?.calendarProvider !== "google" ||
    createdSchedule.reps[0]?.conflictCalendars
      .map((calendar) => `${calendar.provider}:${calendar.calendarId}`)
      .sort()
      .join(",") !== "google:google-secondary,google:primary,microsoft:default"
  ) {
    throw new Error(
      "Fresh Routing Studio configuration did not save, preview, and reload.",
    );
  }
  console.log(
    `Integration smoke passed: ${decision.leadEmail} -> ${decision.repEmail}`,
  );
} finally {
  await testDatabase`
    DELETE FROM organizations
    WHERE slug IN (${temporaryOrganizationSlug}, ${secondaryOrganizationSlug})
  `;
  await testDatabase.end();
  await repository.close();
}
