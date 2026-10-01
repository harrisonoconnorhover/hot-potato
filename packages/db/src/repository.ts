import { createHash, randomUUID } from "node:crypto";
import {
  eligibleRepsForLead,
  findMatchingRule,
  isRepScheduled,
  previewRoute as evaluateRoutePreview,
  routeMatchedRule,
  routeLead as evaluateRoute,
  type AssignmentState,
  type Lead,
  type Rep,
  type RoutingContext,
  type Rule,
} from "@hot-potato/router";
import type { JSONValue, Sql, TransactionSql } from "postgres";
import { createDatabase } from "./client.js";
import type {
  BookingStatus,
  BookingAttendanceOutcome,
  BeginRouterLinkBookingAttemptRequest,
  BeginRouterLinkBookingAttemptResult,
  BookRouterLinkSessionRequest,
  BookingCalendarQuote,
  BookingCandidateQuote,
  BookingConflictCalendarQuote,
  BindOutlookEmailIdentity,
  CalendarConflictSource,
  CalendarOAuthProvider,
  AvailabilitySchedule,
  ConferenceProvider,
  ConnectionStatus,
  CreateEmailToolAccessKey,
  Dashboard,
  DashboardRep,
  EmailToolAccessKeyRecord,
  EmailToolClientType,
  EmailToolSchedulingCatalog,
  Job,
  LegacyBookingCalendarAccountProof,
  LegacyBookingCalendarAccountRepairContext,
  ManagedBooking,
  MeetingType,
  InviteeLimitScope,
  OAuthConnection,
  OAuthProvider,
  OwnerWritebackResult,
  OperatorAccessLink,
  OperatorAccessOverview,
  OperatorCredential,
  OperatorInvitation,
  OperatorMember,
  OperatorRepCalendarProfile,
  OperatorRole,
  OperatorSessionIdentity,
  OperatorSessionRecord,
  OutlookEmailIdentity,
  PublicBookingStatus,
  PublicRateLimitRequest,
  PublicRateLimitResult,
  PublicRouterFormBridgeConfig,
  PublicRouterLink,
  PublicSchedule,
  QualifyRouterLinkRequest,
  RepCalendarConnection,
  RepCalendarOAuthAttempt,
  RepCalendarOAuthReturnTo,
  RepCalendarSource,
  RepBookingCapacityStart,
  ReportingRangeDays,
  ReportingSnapshot,
  ReconciledCalendarEvent,
  ResolvedEmailToolAccess,
  RouteCandidate,
  RouteDecision,
  RouteRequest,
  RouterFormBridge,
  RouterLink,
  RouterLinkMeetingType,
  RouterLinkBookingRetryContext,
  RouterLinkQualification,
  RouterLinkQuestion,
  RouterLinkSession,
  RoutingPreview,
  RoutingPreviewRequest,
  SaveRoutingPool,
  SaveRoutingRep,
  SaveRoutingRule,
  SaveRouterLink,
  SaveOAuthConnection,
  SaveRepCalendarConnection,
  SaveRouterFormBridge,
  VerifiedRepIdentity,
} from "./types.js";

export class CalendarSlotUnavailableError extends Error {
  constructor() {
    super("That time is no longer available. Choose another live time.");
    this.name = "CalendarSlotUnavailableError";
  }
}

export class InviteeBookingLimitError extends Error {
  constructor(public readonly scope: Exclude<InviteeLimitScope, "none">) {
    super(
      scope === "email"
        ? "This email already has the maximum number of active or upcoming meetings for this link."
        : "This email domain already has the maximum number of active or upcoming meetings for this link.",
    );
    this.name = "InviteeBookingLimitError";
  }
}

export class BookingChangeCutoffError extends Error {
  constructor(public readonly action: "reschedule" | "cancel") {
    super(
      action === "reschedule"
        ? "The rescheduling deadline for this meeting has passed."
        : "The cancellation deadline for this meeting has passed.",
    );
    this.name = "BookingChangeCutoffError";
  }
}

export class CalendarAccountIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarAccountIdentityError";
  }
}

export class OAuthConnectionConflictError extends Error {
  constructor() {
    super(
      "The OAuth connection changed while its credentials were refreshing.",
    );
    this.name = "OAuthConnectionConflictError";
  }
}

export type OperatorAccessErrorCode =
  | "conflict"
  | "forbidden"
  | "invalid"
  | "last_owner"
  | "not_found"
  | "self";

export class OperatorAccessError extends Error {
  constructor(
    public readonly code: OperatorAccessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OperatorAccessError";
  }
}

function isCalendarSlotDatabaseConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "23P01" || error.code === "23505")
  );
}

export class RouterLinkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouterLinkValidationError";
  }
}

export class RouterLinkConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouterLinkConflictError";
  }
}

export class RouterFormBridgeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouterFormBridgeValidationError";
  }
}

export class RouterLinkSessionExpiredError extends Error {
  constructor() {
    super("This routing session has expired. Submit the form again.");
    this.name = "RouterLinkSessionExpiredError";
  }
}

export class RouterLinkNotFoundError extends Error {
  constructor() {
    super("Smart Router Link not found.");
    this.name = "RouterLinkNotFoundError";
  }
}

type OrganizationRow = { id: string; name: string; slug: string };
type RuleRow = {
  id: string;
  name: string;
  priority: number;
  poolId: string;
  poolName: string;
  conditions: Rule["conditions"];
};
type RepRow = Rep & { poolId: string };
type AssignmentStateRow = AssignmentState & { poolId: string };

type RouterFieldKind = "string" | "number" | "boolean";

const routerFieldPattern =
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/;
const unsafeRouterFieldSegments = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const nonPrintablePattern = /[\u0000-\u001f\u007f]/u;
const googleCalendarListScope =
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const maxSelectedConflictCalendars = 50;
const routerBookingAttemptLeaseMs = 30_000;
const createReconciliationJobType = "calendar.event.create.reconcile";
const providerAbsenceQuietPeriodMs = 2 * 60_000;
const providerAbsenceCheckSeparationMs = 30_000;

function protectedBookingRange(
  startsAt: Date,
  endsAt: Date,
  bufferBeforeMinutes: number,
  bufferAfterMinutes: number,
): { startsAt: Date; endsAt: Date } {
  if (
    !Number.isFinite(startsAt.getTime()) ||
    !Number.isFinite(endsAt.getTime()) ||
    endsAt <= startsAt ||
    !Number.isInteger(bufferBeforeMinutes) ||
    !Number.isInteger(bufferAfterMinutes) ||
    bufferBeforeMinutes < 0 ||
    bufferBeforeMinutes > 480 ||
    bufferAfterMinutes < 0 ||
    bufferAfterMinutes > 480
  ) {
    throw new Error(
      "Choose a valid meeting range and whole-minute buffers from 0 to 480.",
    );
  }
  return {
    startsAt: new Date(startsAt.getTime() - bufferBeforeMinutes * 60_000),
    endsAt: new Date(endsAt.getTime() + bufferAfterMinutes * 60_000),
  };
}

function defaultCalendarId(provider: CalendarOAuthProvider): string {
  return provider === "google" ? "primary" : "default";
}

function fallbackCalendarName(provider: CalendarOAuthProvider): string {
  return provider === "google" ? "Primary calendar" : "Default calendar";
}

function calendarSourceFromValue(value: unknown): RepCalendarSource {
  const source = value as Record<string, unknown>;
  return {
    calendarId: String(source.calendarId),
    name: String(source.name),
    isDefault: Boolean(source.isDefault),
    selected: Boolean(source.selected),
    available: Boolean(source.available),
    lastSeenAt: source.lastSeenAt ? String(source.lastSeenAt) : null,
    missingSince: source.missingSince ? String(source.missingSince) : null,
  };
}

function calendarSourcesFromValue(value: unknown): RepCalendarSource[] {
  return Array.isArray(value) ? value.map(calendarSourceFromValue) : [];
}

function calendarConflictSourcesFromValue(
  value: unknown,
): CalendarConflictSource[] {
  if (!Array.isArray(value)) return [];
  return value.map((source) => {
    const calendar = source as Record<string, unknown>;
    const calendarExternalAccountId = verifiedCalendarExternalAccountId(
      calendar.calendarExternalAccountId,
    );
    if (!calendarExternalAccountId) {
      throw new CalendarAccountIdentityError(
        "A selected conflict calendar has no verified account identity.",
      );
    }
    return {
      provider: calendar.provider as CalendarOAuthProvider,
      calendarExternalAccountId,
      calendarId: String(calendar.calendarId),
      available: Boolean(calendar.available),
    };
  });
}

function normalizeCalendarId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1_024 ||
    nonPrintablePattern.test(value)
  ) {
    throw new Error(
      "Calendar identifiers must be 1–1024 printable characters.",
    );
  }
  return value;
}

function verifiedCalendarExternalAccountId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 1_024 &&
    !nonPrintablePattern.test(value)
    ? value
    : null;
}

async function lockVerifiedCalendarExternalAccountId(
  transaction: TransactionSql,
  repId: string,
  provider: CalendarOAuthProvider,
  requireActiveProvider = true,
): Promise<string> {
  const [rep] = await transaction`
    SELECT id, active_calendar_provider
    FROM reps
    WHERE id = ${repId}
    FOR UPDATE
  `;
  if (
    !rep ||
    (requireActiveProvider && rep.activeCalendarProvider !== provider)
  ) {
    throw new CalendarAccountIdentityError(
      "The representative's active calendar connection changed. Try again.",
    );
  }
  const [connection] = await transaction`
    SELECT external_account_id
    FROM rep_calendar_connections
    WHERE rep_id = ${repId} AND provider = ${provider}
    FOR UPDATE
  `;
  const externalAccountId = verifiedCalendarExternalAccountId(
    connection?.externalAccountId,
  );
  if (!externalAccountId) {
    throw new CalendarAccountIdentityError(
      "The representative's active calendar has no verified account identity.",
    );
  }
  return externalAccountId;
}

async function requireMatchingBookingCalendarAccount(
  transaction: TransactionSql,
  booking: Record<string, unknown>,
): Promise<string> {
  const boundExternalAccountId = verifiedCalendarExternalAccountId(
    booking.calendarExternalAccountId,
  );
  if (!boundExternalAccountId) {
    throw new CalendarAccountIdentityError(
      "This legacy booking has no verified calendar-account identity and cannot be changed safely.",
    );
  }
  const currentExternalAccountId = await lockVerifiedCalendarExternalAccountId(
    transaction,
    String(booking.repId),
    booking.calendarProvider as CalendarOAuthProvider,
    false,
  );
  if (currentExternalAccountId !== boundExternalAccountId) {
    throw new CalendarAccountIdentityError(
      "The representative's connected calendar account changed. This booking cannot be changed safely.",
    );
  }
  return boundExternalAccountId;
}

function canonicalBookingConflictCalendars(
  calendars: BookingConflictCalendarQuote[],
): BookingConflictCalendarQuote[] {
  return [...calendars].sort((left, right) =>
    `${left.provider}\u0000${left.calendarExternalAccountId}\u0000${left.calendarId}`.localeCompare(
      `${right.provider}\u0000${right.calendarExternalAccountId}\u0000${right.calendarId}`,
    ),
  );
}

function normalizeBookingCalendarQuote(
  quote: BookingCalendarQuote,
): BookingCalendarQuote {
  if (
    !uuidPattern.test(quote.repId) ||
    !["google", "microsoft"].includes(quote.calendarProvider) ||
    quote.conflictCalendars.length < 1 ||
    quote.conflictCalendars.length > 100
  ) {
    throw new CalendarAccountIdentityError(
      "The availability quote does not identify a valid calendar candidate.",
    );
  }
  const calendarExternalAccountId = verifiedCalendarExternalAccountId(
    quote.calendarExternalAccountId,
  );
  if (!calendarExternalAccountId) {
    throw new CalendarAccountIdentityError(
      "The availability quote has no verified calendar-account identity.",
    );
  }
  const conflictCalendars = quote.conflictCalendars.map((calendar) => {
    if (
      !["google", "microsoft"].includes(calendar.provider) ||
      !verifiedCalendarExternalAccountId(calendar.calendarExternalAccountId) ||
      calendar.calendarId.length < 1 ||
      calendar.calendarId.length > 1_024 ||
      nonPrintablePattern.test(calendar.calendarId)
    ) {
      throw new CalendarAccountIdentityError(
        "The availability quote contains an invalid conflict calendar.",
      );
    }
    return {
      provider: calendar.provider,
      calendarExternalAccountId: calendar.calendarExternalAccountId,
      calendarId: calendar.calendarId,
    };
  });
  const canonical = canonicalBookingConflictCalendars(conflictCalendars);
  if (
    new Set(
      canonical.map(
        (calendar) => `${calendar.provider}\u0000${calendar.calendarId}`,
      ),
    ).size !== canonical.length
  ) {
    throw new CalendarAccountIdentityError(
      "The availability quote contains duplicate conflict calendars.",
    );
  }
  return {
    repId: quote.repId,
    calendarProvider: quote.calendarProvider,
    calendarExternalAccountId,
    conflictCalendars: canonical,
  };
}

function normalizeBookingCandidateQuote(
  quote: BookingCandidateQuote,
): BookingCandidateQuote {
  const organizer = normalizeBookingCalendarQuote(quote);
  const requiredCohosts = (quote.requiredCohosts ?? [])
    .map(normalizeBookingCalendarQuote)
    .sort((left, right) => left.repId.localeCompare(right.repId));
  if (
    requiredCohosts.length > 10 ||
    requiredCohosts.some((cohost) => cohost.repId === organizer.repId) ||
    new Set(requiredCohosts.map((cohost) => cohost.repId)).size !==
      requiredCohosts.length
  ) {
    throw new CalendarAccountIdentityError(
      "The availability quote contains invalid required co-hosts.",
    );
  }
  const cohostGroups = (quote.cohostGroups ?? []).map((group) => {
    if (!uuidPattern.test(group.poolId)) {
      throw new CalendarAccountIdentityError(
        "The availability quote contains an invalid co-host pool.",
      );
    }
    const candidateQuotes = group.candidateQuotes
      .map(normalizeBookingCalendarQuote)
      .sort((left, right) => left.repId.localeCompare(right.repId));
    if (
      candidateQuotes.length > 100 ||
      (group.requiredForAvailability && candidateQuotes.length < 1) ||
      (!group.requiredForAvailability && candidateQuotes.length > 0) ||
      candidateQuotes.some(
        (candidate) => candidate.repId === organizer.repId,
      ) ||
      new Set(candidateQuotes.map((candidate) => candidate.repId)).size !==
        candidateQuotes.length
    ) {
      throw new CalendarAccountIdentityError(
        "The availability quote contains invalid pooled co-host candidates.",
      );
    }
    return {
      poolId: group.poolId,
      requiredForAvailability: group.requiredForAvailability,
      candidateQuotes,
    };
  });
  if (
    cohostGroups.length > 5 ||
    new Set(cohostGroups.map((group) => group.poolId)).size !==
      cohostGroups.length
  ) {
    throw new CalendarAccountIdentityError(
      "The availability quote contains invalid co-host pools.",
    );
  }
  return { ...organizer, requiredCohosts, cohostGroups };
}

async function lockMatchingAvailabilityQuote(
  transaction: TransactionSql,
  quote: BookingCalendarQuote,
  options: { requireActiveProvider: boolean; includeProviderDefault: boolean },
): Promise<string> {
  const expected = normalizeBookingCalendarQuote(quote);
  const currentCalendarExternalAccountId =
    await lockVerifiedCalendarExternalAccountId(
      transaction,
      expected.repId,
      expected.calendarProvider,
      options.requireActiveProvider,
    );
  if (currentCalendarExternalAccountId !== expected.calendarExternalAccountId) {
    throw new CalendarAccountIdentityError(
      "The calendar account changed after availability was checked.",
    );
  }
  const rows = await transaction`
    SELECT source.provider, source.provider_calendar_id,
           source.missing_since, connection.external_account_id
    FROM rep_calendar_sources source
    JOIN rep_calendar_connections connection
      ON connection.rep_id = source.rep_id
     AND connection.provider = source.provider
    WHERE source.rep_id = ${expected.repId}
      AND (
        source.selected_for_conflicts
        OR (
          ${options.includeProviderDefault}
          AND source.provider = ${expected.calendarProvider}
          AND source.is_provider_default
        )
      )
    ORDER BY source.provider, source.provider_calendar_id
    FOR UPDATE OF source, connection
  `;
  const current = canonicalBookingConflictCalendars(
    rows.map((row) => {
      const externalAccountId = verifiedCalendarExternalAccountId(
        row.externalAccountId,
      );
      if (!externalAccountId || row.missingSince) {
        throw new CalendarAccountIdentityError(
          "A checked conflict calendar changed or is no longer available.",
        );
      }
      return {
        provider: row.provider as CalendarOAuthProvider,
        calendarExternalAccountId: externalAccountId,
        calendarId: String(row.providerCalendarId),
      };
    }),
  );
  if (JSON.stringify(current) !== JSON.stringify(expected.conflictCalendars)) {
    throw new CalendarAccountIdentityError(
      "The selected conflict calendars changed after availability was checked.",
    );
  }
  return currentCalendarExternalAccountId;
}

function bookingParticipantIds(quote: BookingCandidateQuote): string[] {
  return [
    quote.repId,
    ...(quote.requiredCohosts ?? []).map((cohost) => cohost.repId),
  ].sort();
}

function bookingQuotedParticipantIds(quote: BookingCandidateQuote): string[] {
  return [
    ...bookingParticipantIds(quote),
    ...(quote.cohostGroups ?? []).flatMap((group) =>
      group.candidateQuotes.map((candidate) => candidate.repId),
    ),
  ].sort();
}

async function lockBookingParticipantReps(
  transaction: TransactionSql,
  quotes: BookingCandidateQuote[],
): Promise<void> {
  const repIds = [
    ...new Set(quotes.flatMap((quote) => bookingQuotedParticipantIds(quote))),
  ].sort();
  for (const repId of repIds) {
    await transaction`
      SELECT pg_advisory_xact_lock(hashtext(${repId}))
    `;
  }
}

async function lockSchedulingPools(
  transaction: TransactionSql,
  meetingTypeId: string,
  primaryPoolId?: string | null,
): Promise<void> {
  const groupRows = await transaction`
    SELECT pool_id
    FROM meeting_type_cohost_groups
    WHERE meeting_type_id = ${meetingTypeId}
  `;
  const poolIds = [
    ...new Set([
      ...(primaryPoolId ? [primaryPoolId] : []),
      ...groupRows.map((row) => String(row.poolId)),
    ]),
  ].sort();
  for (const poolId of poolIds) {
    await transaction`
      SELECT pg_advisory_xact_lock(hashtext(${poolId}))
    `;
  }
}

async function bookingParticipantsAreAvailable(
  transaction: TransactionSql,
  quote: BookingCandidateQuote,
  startsAt: Date,
  protectedRange: { startsAt: Date; endsAt: Date },
  excludeBookingId?: string,
): Promise<boolean> {
  const participantIds = bookingParticipantIds(quote);
  const [overlap] = await transaction`
    SELECT 1
    FROM booking_rep_reservations reservation
    WHERE reservation.rep_id = ANY(${participantIds}::uuid[])
      AND (${excludeBookingId ?? null}::uuid IS NULL
        OR reservation.booking_id <> ${excludeBookingId ?? null})
      AND reservation.status IN (
        'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
      )
      AND (
        (
          reservation.reserved_starts_at < ${protectedRange.endsAt}
          AND reservation.reserved_ends_at > ${protectedRange.startsAt}
        ) OR (
          reservation.previous_reserved_starts_at IS NOT NULL
          AND reservation.previous_reserved_starts_at < ${protectedRange.endsAt}
          AND reservation.previous_reserved_ends_at > ${protectedRange.startsAt}
        )
      )
    LIMIT 1
  `;
  if (overlap) return false;
  for (const repId of participantIds) {
    if (
      !(await repHasBookingCapacity(
        transaction,
        repId,
        startsAt,
        excludeBookingId,
      ))
    ) {
      return false;
    }
  }
  return true;
}

type SelectedCohostGroup = {
  poolId: string;
  poolName: string;
  repId: string;
  name: string;
  email: string;
  crmOwnerProperty: string | null;
  requiredForAvailability: boolean;
  position: number;
};

type MeetingTypeCohostResolution = {
  quote: BookingCandidateQuote;
  cohostEmails: string[];
  selectedGroups: SelectedCohostGroup[];
};

async function resolveMeetingTypeCohosts(
  transaction: TransactionSql,
  meetingTypeId: string,
  organizerRepId: string,
  quote: BookingCandidateQuote,
  startsAt: Date,
  protectedRange: { startsAt: Date; endsAt: Date },
): Promise<MeetingTypeCohostResolution> {
  const [meetingType] = await transaction`
    SELECT id
    FROM meeting_types
    WHERE id = ${meetingTypeId}
    FOR SHARE
  `;
  if (!meetingType) {
    throw new CalendarAccountIdentityError(
      "The meeting type is no longer available.",
    );
  }
  const rows = await transaction`
    SELECT cohost.rep_id, cohost.required_for_availability,
           rep.name, rep.email, rep.active
    FROM meeting_type_cohosts cohost
    JOIN reps rep ON rep.id = cohost.rep_id
    WHERE cohost.meeting_type_id = ${meetingTypeId}
    ORDER BY cohost.position
    FOR SHARE OF cohost, rep
  `;
  const requiredRows = rows.filter(
    (row) =>
      row.requiredForAvailability && String(row.repId) !== organizerRepId,
  );
  if (requiredRows.some((row) => !row.active)) {
    throw new CalendarAccountIdentityError(
      "A required co-host is no longer active.",
    );
  }
  const requiredQuotes = quote.requiredCohosts ?? [];
  const expectedRequiredIds = requiredRows
    .map((row) => String(row.repId))
    .sort();
  const quotedRequiredIds = requiredQuotes.map((cohost) => cohost.repId).sort();
  if (
    JSON.stringify(expectedRequiredIds) !== JSON.stringify(quotedRequiredIds)
  ) {
    throw new CalendarAccountIdentityError(
      "The required co-hosts changed after availability was checked.",
    );
  }
  for (const requiredQuote of requiredQuotes) {
    await lockMatchingAvailabilityQuote(transaction, requiredQuote, {
      requireActiveProvider: true,
      includeProviderDefault: false,
    });
  }
  const fixedCohostIds = new Set(rows.map((row) => String(row.repId)));
  const fixedCohostEmails = rows
    .filter((row) => row.active && String(row.repId) !== organizerRepId)
    .map((row) => String(row.email));

  const groupRows = await transaction`
    SELECT cohost_group.pool_id, pool.name AS pool_name,
           cohost_group.required_for_availability, cohost_group.position,
           cohost_group.crm_owner_property
    FROM meeting_type_cohost_groups cohost_group
    JOIN routing_pools pool ON pool.id = cohost_group.pool_id
    WHERE cohost_group.meeting_type_id = ${meetingTypeId}
    ORDER BY cohost_group.position
    FOR SHARE OF cohost_group, pool
  `;
  const quotedGroups = quote.cohostGroups ?? [];
  if (
    JSON.stringify(
      groupRows.map((row) => ({
        poolId: String(row.poolId),
        requiredForAvailability: Boolean(row.requiredForAvailability),
      })),
    ) !==
    JSON.stringify(
      quotedGroups.map((group) => ({
        poolId: group.poolId,
        requiredForAvailability: group.requiredForAvailability,
      })),
    )
  ) {
    throw new CalendarAccountIdentityError(
      "The co-host pools changed after availability was checked.",
    );
  }

  const excludedRepIds = new Set([organizerRepId, ...fixedCohostIds]);
  const groupOptions: Array<
    Array<{
      row: Record<string, unknown>;
      quote?: BookingCalendarQuote;
    }>
  > = [];
  for (const [groupIndex, group] of groupRows.entries()) {
    const poolId = String(group.poolId);
    const candidates = await transaction`
      SELECT rep.id, rep.name, rep.email, rep.weight,
             coalesce(state.assignments, 0)::int AS assignments,
             state.last_assigned_at
      FROM routing_pool_members member
      JOIN reps rep ON rep.id = member.rep_id
      LEFT JOIN assignment_state state
        ON state.pool_id = member.pool_id AND state.rep_id = member.rep_id
      WHERE member.pool_id = ${poolId}
        AND rep.active = true
      ORDER BY
        (coalesce(state.assignments, 0)::numeric / greatest(rep.weight, 1)) ASC,
        state.last_assigned_at ASC NULLS FIRST,
        rep.id
      FOR SHARE OF member, rep
    `;
    const quotedGroup = quotedGroups[groupIndex]!;
    const quoteByRepId = new Map(
      quotedGroup.candidateQuotes.map((candidate) => [
        candidate.repId,
        candidate,
      ]),
    );
    const options: Array<{
      row: Record<string, unknown>;
      quote?: BookingCalendarQuote;
    }> = [];
    for (const candidate of candidates) {
      const repId = String(candidate.id);
      if (excludedRepIds.has(repId)) continue;
      if (!group.requiredForAvailability) {
        options.push({ row: candidate });
        continue;
      }
      const candidateQuote = quoteByRepId.get(repId);
      if (
        candidateQuote &&
        (await bookingParticipantsAreAvailable(
          transaction,
          { ...candidateQuote, requiredCohosts: [], cohostGroups: [] },
          startsAt,
          protectedRange,
        ))
      ) {
        options.push({ row: candidate, quote: candidateQuote });
      }
    }
    if (options.length === 0) throw new CalendarSlotUnavailableError();
    groupOptions.push(options);
  }

  function chooseUniqueGroupMembers(
    index: number,
    used: Set<string>,
  ): Array<{
    row: Record<string, unknown>;
    quote?: BookingCalendarQuote;
  }> | null {
    if (index === groupOptions.length) return [];
    for (const option of groupOptions[index]!) {
      const repId = String(option.row.id);
      if (used.has(repId)) continue;
      used.add(repId);
      const rest = chooseUniqueGroupMembers(index + 1, used);
      used.delete(repId);
      if (rest) return [option, ...rest];
    }
    return null;
  }

  const selectedOptions = chooseUniqueGroupMembers(0, new Set());
  if (!selectedOptions) throw new CalendarSlotUnavailableError();
  const selectedGroups = selectedOptions.map((option, index) => {
    const group = groupRows[index]!;
    return {
      poolId: String(group.poolId),
      poolName: String(group.poolName),
      repId: String(option.row.id),
      name: String(option.row.name),
      email: String(option.row.email),
      crmOwnerProperty: group.crmOwnerProperty
        ? String(group.crmOwnerProperty)
        : null,
      requiredForAvailability: Boolean(group.requiredForAvailability),
      position: Number(group.position),
    } satisfies SelectedCohostGroup;
  });
  const selectedRequiredQuotes = selectedOptions.flatMap((option, index) =>
    groupRows[index]?.requiredForAvailability && option.quote
      ? [option.quote]
      : [],
  );
  for (const selectedQuote of selectedRequiredQuotes) {
    await lockMatchingAvailabilityQuote(transaction, selectedQuote, {
      requireActiveProvider: true,
      includeProviderDefault: false,
    });
  }
  return {
    quote: {
      ...quote,
      requiredCohosts: [...requiredQuotes, ...selectedRequiredQuotes].sort(
        (left, right) => left.repId.localeCompare(right.repId),
      ),
    },
    cohostEmails: [
      ...new Set([
        ...fixedCohostEmails,
        ...selectedGroups.map((group) => group.email),
      ]),
    ],
    selectedGroups,
  };
}

async function persistSelectedCohostGroups(
  transaction: TransactionSql,
  bookingId: string,
  selectedGroups: SelectedCohostGroup[],
): Promise<void> {
  for (const group of selectedGroups) {
    await transaction`
      INSERT INTO booking_cohosts (
        booking_id, rep_id, name, email, required_for_availability,
        position, source_pool_id, source_pool_name
      ) VALUES (
        ${bookingId}, ${group.repId}, ${group.name}, ${group.email},
        ${group.requiredForAvailability}, ${10 + group.position},
        ${group.poolId}, ${group.poolName}
      )
    `;
    if (group.requiredForAvailability) {
      await transaction`
        INSERT INTO booking_rep_reservations (
          booking_id, rep_id, role, status, starts_at, ends_at,
          reserved_starts_at, reserved_ends_at,
          previous_starts_at, previous_ends_at,
          previous_reserved_starts_at, previous_reserved_ends_at
        )
        SELECT id, ${group.repId}, 'required_cohost', status, starts_at, ends_at,
               reserved_starts_at, reserved_ends_at,
               previous_starts_at, previous_ends_at,
               previous_reserved_starts_at, previous_reserved_ends_at
        FROM bookings
        WHERE id = ${bookingId}
      `;
    }
    await transaction`
      INSERT INTO assignment_state (
        pool_id, rep_id, assignments, last_assigned_at
      ) VALUES (${group.poolId}, ${group.repId}, 1, now())
      ON CONFLICT (pool_id, rep_id) DO UPDATE SET
        assignments = assignment_state.assignments + 1,
        last_assigned_at = EXCLUDED.last_assigned_at
    `;
  }
}

async function cohostRoleOwnersForBooking(
  transaction: TransactionSql,
  input: {
    organizationId: string;
    selectedGroups: SelectedCohostGroup[];
  },
): Promise<Array<{ propertyName: string; ownerEmail: string }>> {
  const roleOwners = input.selectedGroups.flatMap((group) =>
    group.crmOwnerProperty
      ? [
          {
            propertyName: group.crmOwnerProperty,
            ownerEmail: group.email,
          },
        ]
      : [],
  );
  if (roleOwners.length === 0) return [];
  const [hubspotConnection] = await transaction`
    SELECT 1
    FROM oauth_connections
    WHERE organization_id = ${input.organizationId}
      AND provider = 'hubspot'
  `;
  return hubspotConnection ? roleOwners : [];
}

async function enqueueConfirmedCohostRoleWriteback(
  transaction: TransactionSql,
  bookingId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const roleOwners = payload.crmRoleOwners;
  if (roleOwners === undefined) return;
  if (
    !Array.isArray(roleOwners) ||
    roleOwners.length < 1 ||
    roleOwners.length > 5 ||
    roleOwners.some(
      (role) =>
        !role ||
        typeof role !== "object" ||
        Array.isArray(role) ||
        typeof (role as Record<string, unknown>).propertyName !== "string" ||
        typeof (role as Record<string, unknown>).ownerEmail !== "string",
    ) ||
    typeof payload.crmLeadEmail !== "string" ||
    typeof payload.organizationSlug !== "string"
  ) {
    throw new Error("The calendar job has invalid CRM role writeback data.");
  }
  await transaction`
    INSERT INTO jobs (organization_id, type, payload)
    SELECT booking.organization_id, 'crm.roles.writeback',
           ${transaction.json({
             adapter: "hubspot",
             organizationSlug: payload.organizationSlug,
             bookingId,
             ...(payload.decisionId
               ? { decisionId: String(payload.decisionId) }
               : {}),
             leadEmail: payload.crmLeadEmail,
             roleOwners,
           } as JSONValue)}
    FROM bookings booking
    WHERE booking.id = ${bookingId}
    ON CONFLICT DO NOTHING
  `;
}

async function lockBookingCohosts(
  transaction: TransactionSql,
  bookingId: string,
  organizerRepId: string,
  quote: BookingCandidateQuote,
): Promise<string[]> {
  const rows = await transaction`
    SELECT cohost.rep_id, cohost.email, cohost.required_for_availability,
           cohost.source_pool_id, rep.active
    FROM booking_cohosts cohost
    JOIN reps rep ON rep.id = cohost.rep_id
    WHERE cohost.booking_id = ${bookingId}
      AND cohost.rep_id <> ${organizerRepId}
    ORDER BY cohost.position
    FOR SHARE OF cohost, rep
  `;
  const requiredRows = rows.filter((row) => row.requiredForAvailability);
  if (requiredRows.some((row) => !row.active)) {
    throw new CalendarAccountIdentityError(
      "A required co-host is no longer active.",
    );
  }
  const directRequiredQuotes = quote.requiredCohosts ?? [];
  const pooledRequiredQuotes = requiredRows.flatMap((row) => {
    if (!row.sourcePoolId) return [];
    const group = (quote.cohostGroups ?? []).find(
      (candidate) => candidate.poolId === String(row.sourcePoolId),
    );
    const selected = group?.candidateQuotes.find(
      (candidate) => candidate.repId === String(row.repId),
    );
    return selected ? [selected] : [];
  });
  const requiredQuotes = [...directRequiredQuotes, ...pooledRequiredQuotes];
  if (
    JSON.stringify(requiredRows.map((row) => String(row.repId)).sort()) !==
    JSON.stringify(requiredQuotes.map((cohost) => cohost.repId).sort())
  ) {
    throw new CalendarAccountIdentityError(
      "The booking's required co-hosts changed after availability was checked.",
    );
  }
  for (const requiredQuote of requiredQuotes) {
    await lockMatchingAvailabilityQuote(transaction, requiredQuote, {
      requireActiveProvider: true,
      includeProviderDefault: false,
    });
  }
  return rows.map((row) => String(row.email));
}

function normalizeCalendarName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 300 || nonPrintablePattern.test(name)) {
    throw new Error("Calendar names must be 1–300 printable characters.");
  }
  return name;
}

function normalizeRouterFormSourceField(value: string): string {
  const field = value.trim();
  if (
    field.length < 1 ||
    field.length > 160 ||
    nonPrintablePattern.test(field) ||
    unsafeRouterFieldSegments.has(field)
  ) {
    throw new RouterFormBridgeValidationError(
      "Form source fields must be safe, printable, and 1–160 characters.",
    );
  }
  return field;
}

function normalizeRouterFormOrigin(value: string): string {
  const candidate = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new RouterFormBridgeValidationError(
      "Allowed origins must be valid HTTPS origins.",
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback =
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
  ) {
    throw new RouterFormBridgeValidationError(
      "Allowed origins must use HTTPS; HTTP is limited to loopback development.",
    );
  }
  return parsed.origin;
}

function normalizeRouterSuccessRedirect(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const candidate = value.trim();
  if (candidate.length > 2_048) {
    throw new RouterLinkValidationError(
      "Post-booking redirect URLs must be 2,048 characters or fewer.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new RouterLinkValidationError(
      "Enter a valid HTTPS post-booking redirect URL.",
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback =
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
  ) {
    throw new RouterLinkValidationError(
      "Post-booking redirects must use HTTPS; HTTP is limited to loopback development, and credentials or fragments are not allowed.",
    );
  }
  return parsed.toString();
}

function normalizeRouterFormBridge(input: SaveRouterFormBridge) {
  const name = input.name.trim();
  if (name.length < 2 || name.length > 120) {
    throw new RouterFormBridgeValidationError(
      "Bridge names must be 2–120 characters.",
    );
  }
  if (!uuidPattern.test(input.routerLinkId)) {
    throw new RouterFormBridgeValidationError("Smart Router Link not found.");
  }
  if (input.provider !== "hubspot" && input.provider !== "manual") {
    throw new RouterFormBridgeValidationError("Unsupported form provider.");
  }
  const formId = input.formId?.trim() || null;
  if (
    input.provider === "hubspot" &&
    (!formId || formId.length > 160 || nonPrintablePattern.test(formId))
  ) {
    throw new RouterFormBridgeValidationError(
      "HubSpot bridges require an exact form ID.",
    );
  }
  if (input.provider === "manual" && formId !== null) {
    throw new RouterFormBridgeValidationError(
      "Manual bridges do not use a HubSpot form ID.",
    );
  }
  if (input.allowedOrigins.length < 1 || input.allowedOrigins.length > 10) {
    throw new RouterFormBridgeValidationError(
      "Choose between 1 and 10 allowed origins.",
    );
  }
  const allowedOrigins = input.allowedOrigins.map(normalizeRouterFormOrigin);
  if (new Set(allowedOrigins).size !== allowedOrigins.length) {
    throw new RouterFormBridgeValidationError(
      "Each allowed origin can appear only once.",
    );
  }
  if (
    input.attendeeNameFields.length < 1 ||
    input.attendeeNameFields.length > 4
  ) {
    throw new RouterFormBridgeValidationError(
      "Choose between 1 and 4 attendee name fields.",
    );
  }
  const attendeeNameFields = input.attendeeNameFields.map(
    normalizeRouterFormSourceField,
  );
  if (new Set(attendeeNameFields).size !== attendeeNameFields.length) {
    throw new RouterFormBridgeValidationError(
      "Each attendee name field can appear only once.",
    );
  }
  const attendeeEmailField = normalizeRouterFormSourceField(
    input.attendeeEmailField,
  );
  if (
    !input.answerMappings ||
    typeof input.answerMappings !== "object" ||
    Array.isArray(input.answerMappings)
  ) {
    throw new RouterFormBridgeValidationError(
      "Question mappings must be an object.",
    );
  }
  const answerMappings = Object.fromEntries(
    Object.entries(input.answerMappings).map(([field, sourceField]) => {
      if (typeof sourceField !== "string") {
        throw new RouterFormBridgeValidationError(
          "Every question needs a printable source field.",
        );
      }
      return [field, normalizeRouterFormSourceField(sourceField)];
    }),
  );
  return {
    name,
    provider: input.provider,
    formId,
    allowedOrigins,
    attendeeNameFields,
    attendeeEmailField,
    answerMappings,
    active: Boolean(input.active),
  };
}

function validateRouterQuestion(
  question: RouterLinkQuestion,
): RouterLinkQuestion {
  const field = question.field.trim();
  const label = question.label.trim();
  const placeholder = question.placeholder.trim();
  const helpText = question.helpText.trim();
  if (
    field.length > 120 ||
    !routerFieldPattern.test(field) ||
    field
      .split(".")
      .some((segment) => unsafeRouterFieldSegments.has(segment)) ||
    field === "email" ||
    field === "name" ||
    field === "attendee_name" ||
    field === "current_owner_email"
  ) {
    throw new RouterLinkValidationError(`Invalid routing field: ${field}.`);
  }
  if (label.length < 1 || label.length > 120) {
    throw new RouterLinkValidationError(
      "Question labels must be 1–120 characters.",
    );
  }
  if (placeholder.length > 160 || helpText.length > 300) {
    throw new RouterLinkValidationError(
      "Question placeholder or help text is too long.",
    );
  }
  if (!(["text", "number", "select"] as const).includes(question.type)) {
    throw new RouterLinkValidationError(
      "Unsupported Smart Link question type.",
    );
  }
  const options = question.options.map((option) => option.trim());
  if (
    options.length > 50 ||
    options.some((option) => option.length < 1 || option.length > 100) ||
    new Set(options).size !== options.length
  ) {
    throw new RouterLinkValidationError(
      "Select options must be unique and 1–100 characters.",
    );
  }
  if (question.type === "select" && options.length === 0) {
    throw new RouterLinkValidationError(
      "Select questions need at least one option.",
    );
  }
  if (question.type !== "select" && options.length > 0) {
    throw new RouterLinkValidationError(
      "Only select questions can define options.",
    );
  }
  return {
    field,
    label,
    type: question.type,
    required: Boolean(question.required),
    placeholder,
    helpText,
    options,
  };
}

function normalizeRouterQuestions(
  questions: RouterLinkQuestion[],
): RouterLinkQuestion[] {
  if (questions.length > 20) {
    throw new RouterLinkValidationError(
      "Smart Router Links support at most 20 questions.",
    );
  }
  const normalized = questions.map(validateRouterQuestion);
  const fields = normalized.map((question) => question.field);
  if (new Set(fields).size !== fields.length) {
    throw new RouterLinkValidationError(
      "Each routing field can be asked once.",
    );
  }
  for (const field of fields) {
    if (
      fields.some(
        (candidate) =>
          candidate !== field &&
          (candidate.startsWith(`${field}.`) ||
            field.startsWith(`${candidate}.`)),
      )
    ) {
      throw new RouterLinkValidationError(
        "Routing question fields cannot contain one another.",
      );
    }
  }
  return normalized;
}

function predicateKinds(
  predicate: Rule["conditions"][string],
): RouterFieldKind[] {
  if ("gte" in predicate || "lte" in predicate) return ["number"];
  if ("contains" in predicate) return ["string"];
  if ("eq" in predicate) return [typeof predicate.eq as RouterFieldKind];
  if ("in" in predicate) {
    return [
      ...new Set(predicate.in.map((value) => typeof value as RouterFieldKind)),
    ];
  }
  return [];
}

function routingFieldKinds(rules: Rule[]): Map<string, RouterFieldKind> {
  const kinds = new Map<string, Set<RouterFieldKind>>();
  for (const rule of rules) {
    for (const [field, predicate] of Object.entries(rule.conditions)) {
      const fieldKinds = kinds.get(field) ?? new Set<RouterFieldKind>();
      for (const kind of predicateKinds(predicate)) fieldKinds.add(kind);
      kinds.set(field, fieldKinds);
    }
  }
  const resolved = new Map<string, RouterFieldKind>();
  for (const [field, fieldKinds] of kinds) {
    if (fieldKinds.size > 1) {
      throw new RouterLinkValidationError(
        `Routing field ${field} uses incompatible value types.`,
      );
    }
    const [kind] = fieldKinds;
    if (kind) resolved.set(field, kind);
  }
  return resolved;
}

function routerFieldsRequiringQuestions(rules: Rule[]): Set<string> {
  const required = new Set<string>();
  for (const rule of rules) {
    for (const [field, predicate] of Object.entries(rule.conditions)) {
      if (!("exists" in predicate && predicate.exists === false)) {
        required.add(field);
      }
    }
  }
  return required;
}

function validateQuestionKinds(
  questions: RouterLinkQuestion[],
  kinds: Map<string, RouterFieldKind>,
): void {
  for (const question of questions) {
    const kind = kinds.get(question.field);
    if (
      (question.type === "number" && kind && kind !== "number") ||
      (question.type === "text" && kind && kind !== "string")
    ) {
      throw new RouterLinkValidationError(
        `Question ${question.field} does not match its routing predicates.`,
      );
    }
    if (question.type === "select" && kind === "boolean") {
      if (
        question.options.some(
          (option) => option !== "true" && option !== "false",
        )
      ) {
        throw new RouterLinkValidationError(
          `Boolean question ${question.field} can only use true and false options.`,
        );
      }
    }
    if (
      question.type === "select" &&
      kind === "number" &&
      question.options.some(
        (option) => option.trim() === "" || !Number.isFinite(Number(option)),
      )
    ) {
      throw new RouterLinkValidationError(
        `Numeric question ${question.field} has a non-numeric option.`,
      );
    }
  }
}

function setLeadValue(
  lead: Lead,
  path: string,
  value: string | number | boolean,
) {
  const parts = path.split(".");
  let target = lead as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const existing = target[part];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      target = existing as Record<string, unknown>;
      continue;
    }
    const nested: Record<string, unknown> = {};
    target[part] = nested;
    target = nested;
  }
  target[parts.at(-1)!] = value;
}

function leadFromRouterAnswers(input: {
  attendeeName: string;
  attendeeEmail: string;
  answers: Record<string, unknown>;
  questions: RouterLinkQuestion[];
  fieldKinds: Map<string, RouterFieldKind>;
}): { attendeeName: string; attendeeEmail: string; lead: Lead } {
  const attendeeName = input.attendeeName.trim();
  const attendeeEmail = input.attendeeEmail.trim().toLocaleLowerCase();
  if (attendeeName.length < 2 || attendeeName.length > 80) {
    throw new RouterLinkValidationError(
      "Enter a name between 2 and 80 characters.",
    );
  }
  if (
    attendeeEmail.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(attendeeEmail)
  ) {
    throw new RouterLinkValidationError("Enter a valid email address.");
  }
  const allowedFields = new Set(
    input.questions.map((question) => question.field),
  );
  const unknownField = Object.keys(input.answers).find(
    (field) => !allowedFields.has(field),
  );
  if (unknownField) {
    throw new RouterLinkValidationError(
      `Unknown routing field: ${unknownField}.`,
    );
  }

  const lead: Lead = { email: attendeeEmail, name: attendeeName };
  for (const question of input.questions) {
    const raw = input.answers[question.field];
    const missing = raw === undefined || raw === null || raw === "";
    if (missing) {
      if (question.required) {
        throw new RouterLinkValidationError(`${question.label} is required.`);
      }
      continue;
    }

    let value: string | number | boolean;
    if (question.type === "number") {
      value = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(value)) {
        throw new RouterLinkValidationError(
          `${question.label} must be a number.`,
        );
      }
    } else {
      if (typeof raw !== "string") {
        throw new RouterLinkValidationError(`${question.label} must be text.`);
      }
      const normalized = raw.trim();
      if (normalized.length > 500) {
        throw new RouterLinkValidationError(`${question.label} is too long.`);
      }
      if (
        question.type === "select" &&
        !question.options.includes(normalized)
      ) {
        throw new RouterLinkValidationError(
          `Choose a valid option for ${question.label}.`,
        );
      }
      const kind = input.fieldKinds.get(question.field);
      if (question.type === "select" && kind === "boolean") {
        value = normalized === "true";
      } else if (question.type === "select" && kind === "number") {
        value = Number(normalized);
      } else {
        value = normalized;
      }
    }
    setLeadValue(lead, question.field, value);
  }
  return { attendeeName, attendeeEmail, lead };
}

function normalizedCurrentOwnerEmail(value: string | undefined) {
  if (value === undefined) return undefined;
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new RouterLinkValidationError(
      "The trusted contact owner email is invalid.",
    );
  }
  return email;
}

const maximumAdditionalAttendees = 5;

function normalizedAdditionalAttendeeEmails(
  values: readonly string[] | undefined,
  primaryEmail: string,
): string[] {
  const primary = primaryEmail.trim().toLowerCase();
  const unique = new Set<string>();
  for (const value of values ?? []) {
    const email = value.trim().toLowerCase();
    if (
      email.length < 3 ||
      email.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      throw new Error("Enter valid email addresses for additional guests.");
    }
    if (email !== primary) unique.add(email);
  }
  if (unique.size > maximumAdditionalAttendees) {
    throw new Error(
      `Invite no more than ${maximumAdditionalAttendees} additional guests.`,
    );
  }
  return [...unique];
}

function validBookingChangeCutoff(value: number | null | undefined): boolean {
  return (
    value === undefined ||
    value === null ||
    (Number.isInteger(value) && value >= 0 && value <= 43_200)
  );
}

function normalizedCrmOwnerProperty(
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const property = value.trim();
  if (
    !/^[a-z][a-z0-9_]{0,99}$/.test(property) ||
    property === "hubspot_owner_id"
  ) {
    throw new Error(
      "CRM owner properties must start with a lowercase letter, use only lowercase letters, numbers, or underscores, and cannot replace the primary owner field.",
    );
  }
  return property;
}

function validatedInviteeLimit(
  scope: InviteeLimitScope | undefined,
  count: number | null | undefined,
): { scope: InviteeLimitScope; count: number | null } {
  if (scope === undefined) return { scope: "none", count: null };
  if (scope === "none") {
    if (count !== undefined && count !== null) {
      throw new Error(
        "Unlimited invitee booking policies cannot have a limit.",
      );
    }
    return { scope, count: null };
  }
  if (!Number.isInteger(count) || Number(count) < 1 || Number(count) > 100) {
    throw new Error("Invitee booking limits must be between 1 and 100.");
  }
  return { scope, count: Number(count) };
}

async function enforceInviteeBookingLimit(
  transaction: TransactionSql,
  input: {
    organizationId: string;
    meetingTypeId: string;
    attendeeEmail: string;
    scope: InviteeLimitScope;
    count: number | null;
    excludeExternalId?: string;
    excludeRouterSessionId?: string;
  },
): Promise<void> {
  if (input.scope === "none") return;
  if (!Number.isInteger(input.count) || Number(input.count) < 1) {
    throw new Error("The meeting type has an invalid invitee booking limit.");
  }
  const email = input.attendeeEmail.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) {
    throw new Error("The attendee email is invalid.");
  }
  const identity = input.scope === "email" ? email : email.slice(at + 1);
  await transaction`
    SELECT pg_advisory_xact_lock(
      hashtextextended(
        ${`invitee-booking:${input.organizationId}:${input.meetingTypeId}:${input.scope}:${identity}`},
        0
      )
    )
  `;
  const [usage] = await transaction`
    SELECT count(*)::int AS active_count
    FROM bookings booking
    WHERE booking.organization_id = ${input.organizationId}
      AND booking.meeting_type_id = ${input.meetingTypeId}
      AND booking.status IN (
        'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
      )
      AND booking.ends_at > now()
      AND (
        (${input.scope} = 'email' AND lower(booking.attendee_email) = ${identity})
        OR (
          ${input.scope} = 'domain'
          AND split_part(lower(booking.attendee_email), '@', 2) = ${identity}
        )
      )
      AND (
        ${input.excludeExternalId ?? null}::text IS NULL
        OR booking.external_id IS DISTINCT FROM ${input.excludeExternalId ?? null}
      )
      AND (
        ${input.excludeRouterSessionId ?? null}::uuid IS NULL
        OR booking.router_session_id IS DISTINCT FROM ${input.excludeRouterSessionId ?? null}
      )
  `;
  if (Number(usage?.activeCount ?? 0) >= Number(input.count)) {
    throw new InviteeBookingLimitError(input.scope);
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function requestHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function meetingTypeFromRow(
  row: Record<string, unknown>,
): RouterLinkMeetingType {
  return {
    slug: String(row.meetingTypeSlug),
    title: String(row.meetingTypeTitle),
    description: String(row.meetingTypeDescription),
    durationMinutes: Number(row.durationMinutes),
    minimumNoticeMinutes: Number(row.minimumNoticeMinutes),
    bookingWindowDays: Number(row.bookingWindowDays),
    conferenceProvider: row.conferenceProvider as ConferenceProvider,
    reminderMinutes: Number(row.reminderMinutes),
  };
}

function publicBookingStatusFromRow(
  row: Record<string, unknown>,
): PublicBookingStatus {
  return {
    status: row.status as PublicBookingStatus["status"],
    error: row.lastError ? String(row.lastError) : null,
    managePath: safeManagePathFromRow(row),
    conferenceUrl: row.conferenceUrl ? String(row.conferenceUrl) : null,
    repName: row.repName ? String(row.repName) : null,
    startsAt: new Date(String(row.startsAt)).toISOString(),
    endsAt: new Date(String(row.endsAt)).toISOString(),
  };
}

async function routingContext(
  sql: Sql | TransactionSql,
  organizationId: string,
): Promise<{ context: RoutingContext; rules: RuleRow[] }> {
  const rules = (await sql`
    SELECT rr.id, rr.name, rr.priority, rr.conditions, rr.pool_id, rp.name AS pool_name
    FROM routing_rules rr
    JOIN routing_pools rp ON rp.id = rr.pool_id
    WHERE rr.organization_id = ${organizationId} AND rr.active = true
    ORDER BY rr.priority ASC
  `) as unknown as RuleRow[];

  const reps = (await sql`
    SELECT r.id, r.name, r.email, r.timezone, r.weight, r.active, r.availability,
           r.availability_overrides, rpm.pool_id
    FROM reps r
    JOIN routing_pool_members rpm ON rpm.rep_id = r.id
    JOIN routing_pools rp ON rp.id = rpm.pool_id
    WHERE rp.organization_id = ${organizationId}
  `) as unknown as RepRow[];

  const state = (await sql`
    SELECT ast.pool_id, ast.rep_id, ast.assignments, ast.last_assigned_at
    FROM assignment_state ast
    JOIN routing_pools rp ON rp.id = ast.pool_id
    WHERE rp.organization_id = ${organizationId}
  `) as unknown as AssignmentStateRow[];

  const pools: Record<string, Rep[]> = {};
  for (const rep of reps) {
    const { poolId, ...member } = rep;
    (pools[poolId] ??= []).push(member);
  }

  const assignmentState: Record<string, AssignmentState[]> = {};
  for (const item of state) {
    const { poolId, ...repState } = item;
    (assignmentState[poolId] ??= []).push(repState);
  }

  return {
    context: {
      rules: rules.map(({ poolName: _poolName, ...rule }) => rule),
      pools,
      assignmentState,
    },
    rules,
  };
}

function decisionFromRow(row: Record<string, unknown>): RouteDecision {
  return {
    id: String(row.id),
    leadEmail: String(row.leadEmail),
    repName: String(row.repName),
    repEmail: String(row.repEmail),
    ruleName: String(row.ruleName),
    poolName: String(row.poolName),
    reason: row.reason as RouteDecision["reason"],
    createdAt: new Date(String(row.createdAt)).toISOString(),
    writebackStatus: String(row.writebackStatus),
    availabilitySource:
      row.availabilitySource as RouteDecision["availabilitySource"],
  };
}

function reportPercentage(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 1_000) / 10;
}

function dashboardRepFromRow(row: Record<string, unknown>): DashboardRep {
  const activeCalendarProvider = row.activeCalendarProvider
    ? (String(row.activeCalendarProvider) as CalendarOAuthProvider)
    : null;
  const googleCalendars = calendarSourcesFromValue(row.googleCalendars);
  const microsoftCalendars = calendarSourcesFromValue(row.microsoftCalendars);
  return {
    id: String(row.repId),
    name: String(row.repName),
    email: String(row.email),
    weight: Number(row.weight),
    active: Boolean(row.active),
    timezone: String(row.timezone),
    availability: row.availability as DashboardRep["availability"],
    availabilityOverrides: (row.availabilityOverrides ??
      {}) as DashboardRep["availabilityOverrides"],
    availabilityScheduleId: row.availabilityScheduleId
      ? String(row.availabilityScheduleId)
      : null,
    availabilityScheduleName: row.availabilityScheduleName
      ? String(row.availabilityScheduleName)
      : null,
    dailyMeetingLimit:
      row.dailyMeetingLimit === null || row.dailyMeetingLimit === undefined
        ? null
        : Number(row.dailyMeetingLimit),
    weeklyMeetingLimit:
      row.weeklyMeetingLimit === null || row.weeklyMeetingLimit === undefined
        ? null
        : Number(row.weeklyMeetingLimit),
    assignments: Number(row.assignments ?? 0),
    schedulingSlug: String(row.schedulingSlug),
    meetingDurationMinutes: Number(row.meetingDurationMinutes),
    activeCalendarProvider,
    googleCalendar: {
      connected: Boolean(row.googleConnected),
      accountName: row.googleAccountName ? String(row.googleAccountName) : null,
      checkConflicts:
        Boolean(row.googleConnected) &&
        googleCalendars.some((calendar) => calendar.selected),
      canSyncCalendars:
        Boolean(row.googleConnected) &&
        Array.isArray(row.googleScopes) &&
        row.googleScopes.includes(googleCalendarListScope),
      calendarCatalogSyncedAt: row.googleCatalogSyncedAt
        ? new Date(String(row.googleCatalogSyncedAt)).toISOString()
        : null,
      calendarCatalogError: row.googleCatalogError
        ? String(row.googleCatalogError)
        : null,
      calendars: googleCalendars,
    },
    microsoftCalendar: {
      connected: Boolean(row.microsoftConnected),
      accountName: row.microsoftAccountName
        ? String(row.microsoftAccountName)
        : null,
      checkConflicts:
        Boolean(row.microsoftConnected) &&
        microsoftCalendars.some((calendar) => calendar.selected),
      canSyncCalendars: Boolean(row.microsoftConnected),
      calendarCatalogSyncedAt: row.microsoftCatalogSyncedAt
        ? new Date(String(row.microsoftCatalogSyncedAt)).toISOString()
        : null,
      calendarCatalogError: row.microsoftCatalogError
        ? String(row.microsoftCatalogError)
        : null,
      calendars: microsoftCalendars,
    },
  };
}

function availabilityScheduleFromRow(
  row: Record<string, unknown>,
): AvailabilitySchedule {
  return {
    id: String(row.id),
    name: String(row.name),
    availability: row.availability as AvailabilitySchedule["availability"],
    assignedRepCount: Number(row.assignedRepCount ?? 0),
  };
}

function bookingStatusFromRow(row: Record<string, unknown>): BookingStatus {
  const result = (row.result ?? {}) as Record<string, unknown>;
  const managePath = safeManagePathFromRow(row);
  return {
    id: Number(row.id),
    status: row.status as BookingStatus["status"],
    externalEventId: result.externalEventId
      ? String(result.externalEventId)
      : null,
    webLink: result.webLink ? String(result.webLink) : null,
    error: row.lastError ? String(row.lastError) : null,
    managePath: row.managePath ? String(row.managePath) : managePath,
    conferenceUrl: result.conferenceUrl
      ? String(result.conferenceUrl)
      : row.conferenceUrl
        ? String(row.conferenceUrl)
        : null,
  };
}

function safeManagePathFromRow(row: Record<string, unknown>): string | null {
  const manageTokenHash = row.manageTokenHash
    ? String(row.manageTokenHash)
    : null;
  if (!manageTokenHash) return null;
  const payloadManageToken = row.manageToken ? String(row.manageToken) : null;
  const externalId = row.externalId ? String(row.externalId) : null;
  for (const candidate of [payloadManageToken, externalId]) {
    if (
      candidate &&
      uuidPattern.test(candidate) &&
      tokenHash(candidate) === manageTokenHash
    ) {
      return `/schedule/manage/${candidate}`;
    }
  }
  return null;
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const emailToolTokenHashPattern = /^[0-9a-f]{64}$/;
const operatorSessionTokenHashPattern = /^[0-9a-f]{64}$/;
const operatorAccessTokenHashPattern = /^[0-9a-f]{64}$/;
const repCalendarOAuthStateHashPattern = /^[0-9a-f]{64}$/;
const emailToolClientTypes = new Set<EmailToolClientType>(["gmail", "outlook"]);

function emailToolAccessKeyFromRow(
  row: Record<string, unknown>,
): EmailToolAccessKeyRecord {
  return {
    id: String(row.id),
    organizationSlug: String(row.organizationSlug),
    repId: String(row.repId),
    clientType: row.clientType as EmailToolClientType,
    label: String(row.label),
    createdAt: new Date(String(row.createdAt)),
    lastUsedAt: row.lastUsedAt ? new Date(String(row.lastUsedAt)) : null,
    revokedAt: row.revokedAt ? new Date(String(row.revokedAt)) : null,
    outlookIdentityLinked: Boolean(row.outlookIdentityLinked),
  };
}

function operatorMemberFromRow(row: Record<string, unknown>): OperatorMember {
  return {
    operatorId: String(row.operatorId),
    login: String(row.login),
    displayName: String(row.displayName),
    role: row.role as OperatorRole,
    active: Boolean(row.active),
    joinedAt: new Date(String(row.joinedAt)),
    lastSeenAt: row.lastSeenAt ? new Date(String(row.lastSeenAt)) : null,
    activeSessionCount: Number(row.activeSessionCount),
    repId: row.repId ? String(row.repId) : null,
    repName: row.repName ? String(row.repName) : null,
    googleConnected: Boolean(row.googleConnected),
    microsoftConnected: Boolean(row.microsoftConnected),
  };
}

function operatorInvitationFromRow(
  row: Record<string, unknown>,
): OperatorInvitation {
  return {
    id: String(row.id),
    login: String(row.login),
    displayName: String(row.displayName),
    role: row.role as OperatorRole,
    createdAt: new Date(String(row.createdAt)),
    expiresAt: new Date(String(row.expiresAt)),
  };
}

function operatorAccessLinkFromRow(
  row: Record<string, unknown>,
): OperatorAccessLink {
  return {
    id: String(row.id),
    purpose: row.purpose as OperatorAccessLink["purpose"],
    organizationId: String(row.organizationId),
    organizationSlug: String(row.organizationSlug),
    organizationName: String(row.organizationName),
    operatorId: row.operatorId ? String(row.operatorId) : null,
    login: String(row.login),
    displayName: String(row.displayName),
    role: row.role as OperatorRole,
    expiresAt: new Date(String(row.expiresAt)),
  };
}

async function operatorManagerRole(
  transaction: TransactionSql,
  organizationId: string,
  operatorId: string,
): Promise<"owner" | "admin"> {
  const [membership] = await transaction`
    SELECT role
    FROM organization_memberships
    WHERE organization_id = ${organizationId}
      AND operator_id = ${operatorId}
      AND active = true
    FOR UPDATE
  `;
  if (membership?.role !== "owner" && membership?.role !== "admin") {
    throw new OperatorAccessError(
      "forbidden",
      "Administrator access is required.",
    );
  }
  return membership.role;
}

function assertOperatorManagerScope(
  managerRole: "owner" | "admin",
  currentRole: OperatorRole | null,
  requestedRole: OperatorRole | null,
): void {
  if (
    managerRole !== "owner" &&
    (currentRole === "owner" || requestedRole === "owner")
  ) {
    throw new OperatorAccessError(
      "forbidden",
      "Only an owner can manage another owner.",
    );
  }
}

async function repHasBookingCapacity(
  transaction: TransactionSql,
  repId: string,
  startsAt: Date,
  excludeBookingId?: string,
): Promise<boolean> {
  const [capacity] = await transaction`
    SELECT
      rep.daily_meeting_limit IS NULL OR (
        SELECT count(DISTINCT reservation.booking_id)
        FROM booking_rep_reservations reservation
        CROSS JOIN LATERAL (
          SELECT DISTINCT candidate.starts_at
          FROM (
            VALUES
              (reservation.starts_at),
              (
                CASE
                  WHEN reservation.status IN ('reschedule_pending', 'cancel_pending')
                    THEN reservation.previous_starts_at
                  ELSE NULL
                END
              )
          ) AS candidate(starts_at)
          WHERE candidate.starts_at IS NOT NULL
        ) active_start
        WHERE reservation.rep_id = rep.id
          AND (${excludeBookingId ?? null}::uuid IS NULL
            OR reservation.booking_id <> ${excludeBookingId ?? null})
          AND reservation.status IN (
            'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
          )
          AND (active_start.starts_at AT TIME ZONE rep.timezone)::date =
            (${startsAt}::timestamptz AT TIME ZONE rep.timezone)::date
      ) < rep.daily_meeting_limit AS daily_available,
      rep.weekly_meeting_limit IS NULL OR (
        SELECT count(DISTINCT reservation.booking_id)
        FROM booking_rep_reservations reservation
        CROSS JOIN LATERAL (
          SELECT DISTINCT candidate.starts_at
          FROM (
            VALUES
              (reservation.starts_at),
              (
                CASE
                  WHEN reservation.status IN ('reschedule_pending', 'cancel_pending')
                    THEN reservation.previous_starts_at
                  ELSE NULL
                END
              )
          ) AS candidate(starts_at)
          WHERE candidate.starts_at IS NOT NULL
        ) active_start
        WHERE reservation.rep_id = rep.id
          AND (${excludeBookingId ?? null}::uuid IS NULL
            OR reservation.booking_id <> ${excludeBookingId ?? null})
          AND reservation.status IN (
            'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
          )
          AND date_trunc(
            'week', active_start.starts_at AT TIME ZONE rep.timezone
          )::date = date_trunc(
            'week', ${startsAt}::timestamptz AT TIME ZONE rep.timezone
          )::date
      ) < rep.weekly_meeting_limit AS weekly_available
    FROM reps rep
    WHERE rep.id = ${repId}
  `;
  return (
    Boolean(capacity?.dailyAvailable) && Boolean(capacity?.weeklyAvailable)
  );
}

export class HotPotatoRepository {
  constructor(private readonly sql: Sql = createDatabase()) {}

  async close(): Promise<void> {
    await this.sql.end();
  }

  async health(): Promise<boolean> {
    const [row] = await this.sql`SELECT 1 AS healthy`;
    return row?.healthy === 1;
  }

  async operatorCredential(
    organizationSlug: string,
    login: string,
  ): Promise<OperatorCredential | null> {
    const normalizedLogin = login.trim().toLowerCase();
    if (normalizedLogin.length < 3 || normalizedLogin.length > 254) return null;
    const [row] = await this.sql`
      SELECT account.id AS operator_id, membership.organization_id,
             organization.slug AS organization_slug, account.login,
             account.display_name, account.password_hash, membership.role
      FROM operator_accounts account
      JOIN organization_memberships membership
        ON membership.operator_id = account.id
      JOIN organizations organization
        ON organization.id = membership.organization_id
      WHERE organization.slug = ${organizationSlug}
        AND account.login_normalized = ${normalizedLogin}
        AND account.active = true
        AND membership.active = true
    `;
    return row
      ? {
          operatorId: String(row.operatorId),
          organizationId: String(row.organizationId),
          organizationSlug: String(row.organizationSlug),
          login: String(row.login),
          displayName: String(row.displayName),
          passwordHash: String(row.passwordHash),
          role: row.role as OperatorRole,
        }
      : null;
  }

  async createOperatorSession(input: {
    organizationId: string;
    operatorId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string | null;
  }): Promise<boolean> {
    if (
      !operatorSessionTokenHashPattern.test(input.tokenHash) ||
      input.expiresAt.getTime() <= Date.now()
    ) {
      return false;
    }
    const userAgent = input.userAgent?.trim().slice(0, 512) || null;
    const [created] = await this.sql`
      INSERT INTO operator_sessions (
        organization_id, operator_id, token_hash, expires_at, user_agent
      )
      SELECT membership.organization_id, membership.operator_id,
             ${input.tokenHash}, ${input.expiresAt}, ${userAgent}
      FROM organization_memberships membership
      JOIN operator_accounts account ON account.id = membership.operator_id
      WHERE membership.organization_id = ${input.organizationId}
        AND membership.operator_id = ${input.operatorId}
        AND account.active = true
        AND membership.active = true
      RETURNING id
    `;
    return Boolean(created);
  }

  async resolveOperatorSession(
    organizationSlug: string,
    tokenHash: string,
  ): Promise<OperatorSessionIdentity | null> {
    if (!operatorSessionTokenHashPattern.test(tokenHash)) return null;
    const [row] = await this.sql`
      UPDATE operator_sessions session
      SET last_seen_at = CASE
        WHEN session.last_seen_at < now() - interval '15 minutes' THEN now()
        ELSE session.last_seen_at
      END
      FROM operator_accounts account,
           organization_memberships membership,
           organizations organization
      WHERE session.token_hash = ${tokenHash}
        AND session.revoked_at IS NULL
        AND session.expires_at > now()
        AND account.id = session.operator_id
        AND account.active = true
        AND membership.organization_id = session.organization_id
        AND membership.operator_id = session.operator_id
        AND membership.active = true
        AND organization.id = session.organization_id
        AND organization.slug = ${organizationSlug}
      RETURNING session.id AS session_id, session.operator_id,
                session.organization_id, organization.slug AS organization_slug,
                account.login, account.display_name, membership.role,
                session.expires_at
    `;
    return row
      ? {
          sessionId: String(row.sessionId),
          operatorId: String(row.operatorId),
          organizationId: String(row.organizationId),
          organizationSlug: String(row.organizationSlug),
          login: String(row.login),
          displayName: String(row.displayName),
          role: row.role as OperatorRole,
          expiresAt: new Date(String(row.expiresAt)),
        }
      : null;
  }

  async revokeOperatorSession(tokenHash: string): Promise<boolean> {
    if (!operatorSessionTokenHashPattern.test(tokenHash)) return false;
    const [revoked] = await this.sql`
      UPDATE operator_sessions
      SET revoked_at = COALESCE(revoked_at, now())
      WHERE token_hash = ${tokenHash}
      RETURNING id
    `;
    return Boolean(revoked);
  }

  async operatorAccessOverview(
    organizationSlug: string,
  ): Promise<OperatorAccessOverview> {
    const members = await this.sql`
      SELECT account.id AS operator_id, account.login, account.display_name,
             membership.role, membership.active,
             membership.created_at AS joined_at,
             (
               SELECT max(session.last_seen_at)
               FROM operator_sessions session
               WHERE session.organization_id = membership.organization_id
                 AND session.operator_id = membership.operator_id
             ) AS last_seen_at,
             (
               SELECT count(*)::int
               FROM operator_sessions session
               WHERE session.organization_id = membership.organization_id
                 AND session.operator_id = membership.operator_id
                 AND session.revoked_at IS NULL
                 AND session.expires_at > now()
             ) AS active_session_count,
             rep.id AS rep_id, rep.name AS rep_name,
             EXISTS (
               SELECT 1 FROM rep_calendar_connections connection
               WHERE connection.rep_id = rep.id AND connection.provider = 'google'
             ) AS google_connected,
             EXISTS (
               SELECT 1 FROM rep_calendar_connections connection
               WHERE connection.rep_id = rep.id AND connection.provider = 'microsoft'
             ) AS microsoft_connected
      FROM organization_memberships membership
      JOIN organizations organization
        ON organization.id = membership.organization_id
      JOIN operator_accounts account ON account.id = membership.operator_id
      LEFT JOIN reps rep
        ON rep.organization_id = membership.organization_id
       AND lower(btrim(rep.email)) = account.login_normalized
      WHERE organization.slug = ${organizationSlug}
      ORDER BY membership.active DESC,
               CASE membership.role
                 WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3
               END,
               account.display_name, account.login
    `;
    const invitations = await this.sql`
      SELECT link.id, link.invite_login AS login,
             link.invite_display_name AS display_name,
             link.invite_role AS role, link.created_at, link.expires_at
      FROM operator_access_links link
      JOIN organizations organization ON organization.id = link.organization_id
      WHERE organization.slug = ${organizationSlug}
        AND link.purpose = 'invite'
        AND link.used_at IS NULL
        AND link.revoked_at IS NULL
        AND link.expires_at > now()
      ORDER BY link.created_at DESC, link.id
    `;
    return {
      members: members.map((row) => operatorMemberFromRow(row)),
      invitations: invitations.map((row) => operatorInvitationFromRow(row)),
    };
  }

  async createOperatorInvitation(input: {
    organizationId: string;
    createdBy: string;
    login: string;
    displayName: string;
    role: OperatorRole;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<OperatorInvitation> {
    const login = input.login.trim();
    const normalizedLogin = login.toLowerCase();
    const displayName = input.displayName.trim();
    if (
      !operatorAccessTokenHashPattern.test(input.tokenHash) ||
      login.length < 3 ||
      login.length > 254 ||
      displayName.length < 1 ||
      displayName.length > 120 ||
      nonPrintablePattern.test(login) ||
      nonPrintablePattern.test(displayName) ||
      !(["owner", "admin", "operator"] as OperatorRole[]).includes(
        input.role,
      ) ||
      input.expiresAt.getTime() <= Date.now()
    ) {
      throw new OperatorAccessError("invalid", "Invalid invitation details.");
    }
    return this.sql.begin(async (transaction) => {
      const managerRole = await operatorManagerRole(
        transaction,
        input.organizationId,
        input.createdBy,
      );
      assertOperatorManagerScope(managerRole, null, input.role);
      await transaction`
        SELECT pg_advisory_xact_lock(
          hashtext(${`${input.organizationId}:${normalizedLogin}`})
        )
      `;
      const [existing] = await transaction`
        SELECT id FROM operator_accounts
        WHERE login_normalized = ${normalizedLogin}
      `;
      if (existing) {
        throw new OperatorAccessError(
          "conflict",
          "That login already belongs to a Hot Potato member.",
        );
      }
      await transaction`
        UPDATE operator_access_links
        SET revoked_at = COALESCE(revoked_at, now())
        WHERE organization_id = ${input.organizationId}
          AND purpose = 'invite'
          AND invite_login_normalized = ${normalizedLogin}
          AND used_at IS NULL
          AND revoked_at IS NULL
      `;
      const [created] = await transaction`
        INSERT INTO operator_access_links (
          organization_id, purpose, invite_login, invite_display_name,
          invite_role, token_hash, created_by, expires_at
        ) VALUES (
          ${input.organizationId}, 'invite', ${login}, ${displayName},
          ${input.role}, ${input.tokenHash}, ${input.createdBy},
          ${input.expiresAt}
        )
        RETURNING id, invite_login AS login,
                  invite_display_name AS display_name, invite_role AS role,
                  created_at, expires_at
      `;
      if (!created) {
        throw new OperatorAccessError(
          "invalid",
          "The invitation could not be created.",
        );
      }
      return operatorInvitationFromRow(created);
    });
  }

  async updateOperatorMembership(input: {
    organizationId: string;
    updatedBy: string;
    operatorId: string;
    role?: OperatorRole;
    active?: boolean;
  }): Promise<void> {
    if (
      !uuidPattern.test(input.organizationId) ||
      !uuidPattern.test(input.updatedBy) ||
      !uuidPattern.test(input.operatorId) ||
      (input.role === undefined && input.active === undefined)
    ) {
      throw new OperatorAccessError("invalid", "Invalid member update.");
    }
    await this.sql.begin(async (transaction) => {
      const managerRole = await operatorManagerRole(
        transaction,
        input.organizationId,
        input.updatedBy,
      );
      const [target] = await transaction`
        SELECT role, active
        FROM organization_memberships
        WHERE organization_id = ${input.organizationId}
          AND operator_id = ${input.operatorId}
        FOR UPDATE
      `;
      if (!target) {
        throw new OperatorAccessError("not_found", "Member not found.");
      }
      if (input.updatedBy === input.operatorId) {
        throw new OperatorAccessError(
          "self",
          "Use your personal security settings for your own account.",
        );
      }
      const currentRole = target.role as OperatorRole;
      const nextRole = input.role ?? currentRole;
      const currentActive = Boolean(target.active);
      const nextActive = input.active ?? currentActive;
      assertOperatorManagerScope(managerRole, currentRole, nextRole);
      if (
        currentRole === "owner" &&
        currentActive &&
        (nextRole !== "owner" || !nextActive)
      ) {
        const owners = await transaction`
          SELECT operator_id
          FROM organization_memberships
          WHERE organization_id = ${input.organizationId}
            AND role = 'owner'
            AND active = true
          FOR UPDATE
        `;
        if (owners.length <= 1) {
          throw new OperatorAccessError(
            "last_owner",
            "Add another owner before changing the last active owner.",
          );
        }
      }
      if (currentRole === nextRole && currentActive === nextActive) return;
      await transaction`
        UPDATE organization_memberships
        SET role = ${nextRole}, active = ${nextActive}, updated_at = now()
        WHERE organization_id = ${input.organizationId}
          AND operator_id = ${input.operatorId}
      `;
      await transaction`
        UPDATE operator_sessions
        SET revoked_at = COALESCE(revoked_at, now())
        WHERE organization_id = ${input.organizationId}
          AND operator_id = ${input.operatorId}
          AND revoked_at IS NULL
      `;
    });
  }

  async revokeOperatorInvitation(input: {
    organizationId: string;
    revokedBy: string;
    invitationId: string;
  }): Promise<void> {
    if (!uuidPattern.test(input.invitationId)) {
      throw new OperatorAccessError("invalid", "Invalid invitation.");
    }
    await this.sql.begin(async (transaction) => {
      const managerRole = await operatorManagerRole(
        transaction,
        input.organizationId,
        input.revokedBy,
      );
      const [invitation] = await transaction`
        SELECT invite_role
        FROM operator_access_links
        WHERE id = ${input.invitationId}
          AND organization_id = ${input.organizationId}
          AND purpose = 'invite'
          AND used_at IS NULL
          AND revoked_at IS NULL
        FOR UPDATE
      `;
      if (!invitation) {
        throw new OperatorAccessError("not_found", "Invitation not found.");
      }
      assertOperatorManagerScope(
        managerRole,
        invitation.inviteRole as OperatorRole,
        null,
      );
      await transaction`
        UPDATE operator_access_links
        SET revoked_at = now()
        WHERE id = ${input.invitationId}
      `;
    });
  }

  async createOperatorPasswordReset(input: {
    organizationId: string;
    createdBy: string;
    operatorId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<{ id: string; expiresAt: Date }> {
    if (
      !uuidPattern.test(input.operatorId) ||
      !operatorAccessTokenHashPattern.test(input.tokenHash) ||
      input.expiresAt.getTime() <= Date.now()
    ) {
      throw new OperatorAccessError("invalid", "Invalid reset request.");
    }
    return this.sql.begin(async (transaction) => {
      const managerRole = await operatorManagerRole(
        transaction,
        input.organizationId,
        input.createdBy,
      );
      if (input.createdBy === input.operatorId) {
        throw new OperatorAccessError(
          "self",
          "Change your own password from Personal security.",
        );
      }
      const [target] = await transaction`
        SELECT role, active
        FROM organization_memberships
        WHERE organization_id = ${input.organizationId}
          AND operator_id = ${input.operatorId}
        FOR UPDATE
      `;
      if (!target || !target.active) {
        throw new OperatorAccessError("not_found", "Active member not found.");
      }
      assertOperatorManagerScope(
        managerRole,
        target.role as OperatorRole,
        null,
      );
      await transaction`
        UPDATE operator_access_links
        SET revoked_at = COALESCE(revoked_at, now())
        WHERE organization_id = ${input.organizationId}
          AND operator_id = ${input.operatorId}
          AND purpose = 'password_reset'
          AND used_at IS NULL
          AND revoked_at IS NULL
      `;
      const [created] = await transaction`
        INSERT INTO operator_access_links (
          organization_id, purpose, operator_id, token_hash,
          created_by, expires_at
        ) VALUES (
          ${input.organizationId}, 'password_reset', ${input.operatorId},
          ${input.tokenHash}, ${input.createdBy}, ${input.expiresAt}
        )
        RETURNING id, expires_at
      `;
      if (!created) {
        throw new OperatorAccessError(
          "invalid",
          "The password-reset link could not be created.",
        );
      }
      return {
        id: String(created.id),
        expiresAt: new Date(String(created.expiresAt)),
      };
    });
  }

  async operatorAccessLink(
    organizationSlug: string,
    tokenHash: string,
  ): Promise<OperatorAccessLink | null> {
    if (!operatorAccessTokenHashPattern.test(tokenHash)) return null;
    const [row] = await this.sql`
      SELECT link.id, link.purpose, link.organization_id,
             organization.slug AS organization_slug,
             organization.name AS organization_name,
             link.operator_id,
             coalesce(link.invite_login, account.login) AS login,
             coalesce(link.invite_display_name, account.display_name) AS display_name,
             coalesce(link.invite_role, membership.role) AS role,
             link.expires_at
      FROM operator_access_links link
      JOIN organizations organization ON organization.id = link.organization_id
      LEFT JOIN operator_accounts account ON account.id = link.operator_id
      LEFT JOIN organization_memberships membership
        ON membership.organization_id = link.organization_id
       AND membership.operator_id = link.operator_id
      WHERE organization.slug = ${organizationSlug}
        AND link.token_hash = ${tokenHash}
        AND link.used_at IS NULL
        AND link.revoked_at IS NULL
        AND link.expires_at > now()
        AND (
          link.purpose = 'invite'
          OR (account.active = true AND membership.active = true)
        )
    `;
    return row ? operatorAccessLinkFromRow(row) : null;
  }

  async consumeOperatorAccessLink(input: {
    organizationSlug: string;
    tokenHash: string;
    passwordHash: string;
    session?: {
      tokenHash: string;
      expiresAt: Date;
      userAgent?: string | null;
    };
  }): Promise<OperatorCredential> {
    if (
      !operatorAccessTokenHashPattern.test(input.tokenHash) ||
      input.passwordHash.length < 80 ||
      input.passwordHash.length > 512 ||
      (input.session !== undefined &&
        (!operatorSessionTokenHashPattern.test(input.session.tokenHash) ||
          input.session.expiresAt.getTime() <= Date.now()))
    ) {
      throw new OperatorAccessError(
        "invalid",
        "This access link is not valid.",
      );
    }
    return this.sql.begin(async (transaction) => {
      const [link] = await transaction`
        SELECT link.*, organization.slug AS organization_slug
        FROM operator_access_links link
        JOIN organizations organization ON organization.id = link.organization_id
        WHERE organization.slug = ${input.organizationSlug}
          AND link.token_hash = ${input.tokenHash}
          AND link.used_at IS NULL
          AND link.revoked_at IS NULL
          AND link.expires_at > now()
        FOR UPDATE OF link
      `;
      if (!link) {
        throw new OperatorAccessError(
          "not_found",
          "This access link has expired or was already used.",
        );
      }
      let operatorId: string;
      let login: string;
      let displayName: string;
      let role: OperatorRole;
      if (link.purpose === "invite") {
        const normalizedLogin = String(link.inviteLogin).trim().toLowerCase();
        const [existing] = await transaction`
          SELECT id FROM operator_accounts
          WHERE login_normalized = ${normalizedLogin}
        `;
        if (existing) {
          throw new OperatorAccessError(
            "conflict",
            "That login already belongs to a Hot Potato member.",
          );
        }
        const [account] = await transaction`
          INSERT INTO operator_accounts (
            login, display_name, password_hash, active
          ) VALUES (
            ${link.inviteLogin}, ${link.inviteDisplayName},
            ${input.passwordHash}, true
          )
          RETURNING id, login, display_name
        `;
        if (!account) {
          throw new OperatorAccessError(
            "invalid",
            "The member account could not be created.",
          );
        }
        operatorId = String(account.id);
        login = String(account.login);
        displayName = String(account.displayName);
        role = link.inviteRole as OperatorRole;
        await transaction`
          INSERT INTO organization_memberships (
            organization_id, operator_id, role, active
          ) VALUES (${link.organizationId}, ${operatorId}, ${role}, true)
        `;
      } else {
        const [account] = await transaction`
          SELECT account.id, account.login, account.display_name,
                 membership.role
          FROM operator_accounts account
          JOIN organization_memberships membership
            ON membership.operator_id = account.id
          WHERE account.id = ${link.operatorId}
            AND membership.organization_id = ${link.organizationId}
            AND account.active = true
            AND membership.active = true
          FOR UPDATE OF account, membership
        `;
        if (!account) {
          throw new OperatorAccessError(
            "not_found",
            "This member is no longer active.",
          );
        }
        operatorId = String(account.id);
        login = String(account.login);
        displayName = String(account.displayName);
        role = account.role as OperatorRole;
        await transaction`
          UPDATE operator_accounts
          SET password_hash = ${input.passwordHash}, updated_at = now()
          WHERE id = ${operatorId}
        `;
        await transaction`
          UPDATE operator_sessions
          SET revoked_at = COALESCE(revoked_at, now())
          WHERE organization_id = ${link.organizationId}
            AND operator_id = ${operatorId}
            AND revoked_at IS NULL
        `;
      }
      await transaction`
        UPDATE operator_access_links
        SET used_at = now()
        WHERE id = ${link.id}
      `;
      if (input.session) {
        const userAgent = input.session.userAgent?.trim().slice(0, 512) || null;
        const [session] = await transaction`
          INSERT INTO operator_sessions (
            organization_id, operator_id, token_hash, expires_at, user_agent
          ) VALUES (
            ${link.organizationId}, ${operatorId}, ${input.session.tokenHash},
            ${input.session.expiresAt}, ${userAgent}
          )
          RETURNING id
        `;
        if (!session) {
          throw new OperatorAccessError(
            "invalid",
            "The signed-in session could not be created.",
          );
        }
      }
      return {
        operatorId,
        organizationId: String(link.organizationId),
        organizationSlug: String(link.organizationSlug),
        login,
        displayName,
        passwordHash: input.passwordHash,
        role,
      };
    });
  }

  async updateOperatorPassword(input: {
    organizationId: string;
    operatorId: string;
    currentSessionId: string;
    expectedPasswordHash: string;
    passwordHash: string;
  }): Promise<boolean> {
    if (
      !uuidPattern.test(input.currentSessionId) ||
      input.expectedPasswordHash.length < 80 ||
      input.expectedPasswordHash.length > 512 ||
      input.passwordHash.length < 80 ||
      input.passwordHash.length > 512
    ) {
      return false;
    }
    return this.sql.begin(async (transaction) => {
      const [updated] = await transaction`
        UPDATE operator_accounts account
        SET password_hash = ${input.passwordHash}, updated_at = now()
        FROM organization_memberships membership
        WHERE account.id = ${input.operatorId}
          AND account.active = true
          AND account.password_hash = ${input.expectedPasswordHash}
          AND membership.organization_id = ${input.organizationId}
          AND membership.operator_id = account.id
          AND membership.active = true
        RETURNING account.id
      `;
      if (!updated) return false;
      await transaction`
        UPDATE operator_sessions
        SET revoked_at = COALESCE(revoked_at, now())
        WHERE organization_id = ${input.organizationId}
          AND operator_id = ${input.operatorId}
          AND id <> ${input.currentSessionId}
          AND revoked_at IS NULL
      `;
      return true;
    });
  }

  async listOperatorSessions(input: {
    organizationId: string;
    operatorId: string;
  }): Promise<OperatorSessionRecord[]> {
    const rows = await this.sql`
      SELECT id AS session_id, created_at, last_seen_at, expires_at, user_agent
      FROM operator_sessions
      WHERE organization_id = ${input.organizationId}
        AND operator_id = ${input.operatorId}
        AND revoked_at IS NULL
        AND expires_at > now()
      ORDER BY last_seen_at DESC, created_at DESC
    `;
    return rows.map((row) => ({
      sessionId: String(row.sessionId),
      createdAt: new Date(String(row.createdAt)),
      lastSeenAt: new Date(String(row.lastSeenAt)),
      expiresAt: new Date(String(row.expiresAt)),
      userAgent: row.userAgent ? String(row.userAgent) : null,
    }));
  }

  async revokeOperatorSessionById(input: {
    organizationId: string;
    operatorId: string;
    sessionId: string;
    currentSessionId: string;
  }): Promise<boolean> {
    if (
      !uuidPattern.test(input.sessionId) ||
      input.sessionId === input.currentSessionId
    ) {
      return false;
    }
    const [revoked] = await this.sql`
      UPDATE operator_sessions
      SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = ${input.sessionId}
        AND organization_id = ${input.organizationId}
        AND operator_id = ${input.operatorId}
        AND revoked_at IS NULL
      RETURNING id
    `;
    return Boolean(revoked);
  }

  async operatorRepCalendarProfile(
    organizationSlug: string,
    operatorId: string,
  ): Promise<OperatorRepCalendarProfile | null> {
    if (!uuidPattern.test(operatorId)) return null;
    const rows = await this.sql`
      SELECT organization.id AS organization_id,
             organization.name AS organization_name,
             organization.slug AS organization_slug,
             rep.id AS rep_id, rep.name AS rep_name, rep.email, rep.weight,
             rep.active, rep.timezone, rep.availability,
             rep.availability_overrides,
             rep.availability_schedule_id,
             schedule.name AS availability_schedule_name,
             rep.daily_meeting_limit, rep.weekly_meeting_limit,
             rep.scheduling_slug, rep.meeting_duration_minutes,
             rep.active_calendar_provider,
             coalesce((
               SELECT sum(state.assignments)::int
               FROM assignment_state state
               WHERE state.rep_id = rep.id
             ), 0) AS assignments,
             google.external_account_name AS google_account_name,
             google.rep_id IS NOT NULL AS google_connected,
             google.scopes AS google_scopes,
             google.calendar_catalog_synced_at AS google_catalog_synced_at,
             google.calendar_catalog_error AS google_catalog_error,
             coalesce((
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'calendarId', source.provider_calendar_id,
                   'name', source.display_name,
                   'isDefault', source.is_provider_default,
                   'selected', source.selected_for_conflicts,
                   'available', source.missing_since IS NULL,
                   'lastSeenAt', source.last_seen_at,
                   'missingSince', source.missing_since
                 )
                 ORDER BY source.is_provider_default DESC,
                          source.display_name, source.provider_calendar_id
               )
               FROM rep_calendar_sources source
               WHERE source.rep_id = rep.id AND source.provider = 'google'
             ), '[]'::jsonb) AS google_calendars,
             microsoft.external_account_name AS microsoft_account_name,
             microsoft.rep_id IS NOT NULL AS microsoft_connected,
             microsoft.scopes AS microsoft_scopes,
             microsoft.calendar_catalog_synced_at AS microsoft_catalog_synced_at,
             microsoft.calendar_catalog_error AS microsoft_catalog_error,
             coalesce((
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'calendarId', source.provider_calendar_id,
                   'name', source.display_name,
                   'isDefault', source.is_provider_default,
                   'selected', source.selected_for_conflicts,
                   'available', source.missing_since IS NULL,
                   'lastSeenAt', source.last_seen_at,
                   'missingSince', source.missing_since
                 )
                 ORDER BY source.is_provider_default DESC,
                          source.display_name, source.provider_calendar_id
               )
               FROM rep_calendar_sources source
               WHERE source.rep_id = rep.id AND source.provider = 'microsoft'
             ), '[]'::jsonb) AS microsoft_calendars
      FROM organization_memberships membership
      JOIN operator_accounts account ON account.id = membership.operator_id
      JOIN organizations organization
        ON organization.id = membership.organization_id
      JOIN reps rep
        ON rep.organization_id = organization.id
       AND lower(btrim(rep.email)) = account.login_normalized
       AND rep.active = true
      LEFT JOIN rep_calendar_connections google
        ON google.rep_id = rep.id AND google.provider = 'google'
      LEFT JOIN rep_calendar_connections microsoft
        ON microsoft.rep_id = rep.id AND microsoft.provider = 'microsoft'
      LEFT JOIN availability_schedules schedule
        ON schedule.id = rep.availability_schedule_id
       AND schedule.organization_id = rep.organization_id
      WHERE organization.slug = ${organizationSlug}
        AND membership.operator_id = ${operatorId}
        AND membership.active = true
        AND account.active = true
      ORDER BY rep.id
      LIMIT 2
    `;
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    const scheduleRows = await this.sql`
      SELECT schedule.id, schedule.name, schedule.availability,
             count(rep.id)::int AS assigned_rep_count
      FROM availability_schedules schedule
      LEFT JOIN reps rep ON rep.availability_schedule_id = schedule.id
      WHERE schedule.organization_id = ${row.organizationId}
      GROUP BY schedule.id
      ORDER BY lower(schedule.name), schedule.id
    `;
    return {
      organization: {
        id: String(row.organizationId),
        name: String(row.organizationName),
        slug: String(row.organizationSlug),
      },
      rep: dashboardRepFromRow(row),
      availabilitySchedules: scheduleRows.map((schedule) =>
        availabilityScheduleFromRow(schedule),
      ),
    };
  }

  async operatorCanManageRepCalendar(input: {
    organizationId: string;
    operatorId: string;
    repId: string;
  }): Promise<boolean> {
    if (
      !uuidPattern.test(input.organizationId) ||
      !uuidPattern.test(input.operatorId) ||
      !uuidPattern.test(input.repId)
    ) {
      return false;
    }
    const [access] = await this.sql`
      SELECT 1
      FROM organization_memberships membership
      JOIN operator_accounts account ON account.id = membership.operator_id
      JOIN reps rep ON rep.organization_id = membership.organization_id
      WHERE membership.organization_id = ${input.organizationId}
        AND membership.operator_id = ${input.operatorId}
        AND membership.active = true
        AND account.active = true
        AND rep.id = ${input.repId}
        AND (
          membership.role IN ('owner', 'admin')
          OR (
            rep.active = true
            AND lower(btrim(rep.email)) = account.login_normalized
            AND 1 = (
              SELECT count(*)
              FROM reps matching_rep
              WHERE matching_rep.organization_id = membership.organization_id
                AND matching_rep.active = true
                AND lower(btrim(matching_rep.email)) = account.login_normalized
            )
          )
        )
    `;
    return Boolean(access);
  }

  async createRepCalendarOAuthAttempt(input: {
    organizationId: string;
    operatorId: string;
    repId: string;
    provider: CalendarOAuthProvider;
    stateHash: string;
    returnTo: RepCalendarOAuthReturnTo;
    expiresAt: Date;
  }): Promise<void> {
    if (
      !uuidPattern.test(input.organizationId) ||
      !uuidPattern.test(input.operatorId) ||
      !uuidPattern.test(input.repId) ||
      !repCalendarOAuthStateHashPattern.test(input.stateHash) ||
      !["google", "microsoft"].includes(input.provider) ||
      !["calendar-readiness", "my-calendar"].includes(input.returnTo) ||
      input.expiresAt.getTime() <= Date.now()
    ) {
      throw new OperatorAccessError("invalid", "Invalid calendar connection.");
    }
    await this.sql.begin(async (transaction) => {
      const [access] = await transaction`
        SELECT membership.role, rep.active,
               lower(btrim(rep.email)) = account.login_normalized AS email_matches,
               (
                 SELECT count(*)::int
                 FROM reps matching_rep
                 WHERE matching_rep.organization_id = membership.organization_id
                   AND matching_rep.active = true
                   AND lower(btrim(matching_rep.email)) = account.login_normalized
               ) AS matching_reps
        FROM organization_memberships membership
        JOIN operator_accounts account ON account.id = membership.operator_id
        JOIN reps rep ON rep.organization_id = membership.organization_id
        WHERE membership.organization_id = ${input.organizationId}
          AND membership.operator_id = ${input.operatorId}
          AND membership.active = true
          AND account.active = true
          AND rep.id = ${input.repId}
        FOR UPDATE OF membership, rep
      `;
      const allowed =
        access &&
        (["owner", "admin"].includes(String(access.role)) ||
          (Boolean(access.active) &&
            Boolean(access.emailMatches) &&
            Number(access.matchingReps) === 1));
      if (!allowed) {
        throw new OperatorAccessError(
          "forbidden",
          "You can connect only the calendar assigned to your login.",
        );
      }
      await transaction`
        UPDATE rep_calendar_oauth_attempts
        SET used_at = coalesce(used_at, now())
        WHERE organization_id = ${input.organizationId}
          AND operator_id = ${input.operatorId}
          AND provider = ${input.provider}
          AND used_at IS NULL
      `;
      await transaction`
        INSERT INTO rep_calendar_oauth_attempts (
          organization_id, operator_id, rep_id, provider, state_hash,
          return_to, expires_at
        ) VALUES (
          ${input.organizationId}, ${input.operatorId}, ${input.repId},
          ${input.provider}, ${input.stateHash}, ${input.returnTo},
          ${input.expiresAt}
        )
      `;
    });
  }

  async consumeRepCalendarOAuthAttempt(input: {
    organizationId: string;
    operatorId: string;
    provider: CalendarOAuthProvider;
    stateHash: string;
  }): Promise<RepCalendarOAuthAttempt | null> {
    if (
      !uuidPattern.test(input.organizationId) ||
      !uuidPattern.test(input.operatorId) ||
      !repCalendarOAuthStateHashPattern.test(input.stateHash) ||
      !["google", "microsoft"].includes(input.provider)
    ) {
      return null;
    }
    return this.sql.begin(async (transaction) => {
      const [attempt] = await transaction`
        SELECT oauth.id, oauth.rep_id, oauth.provider, oauth.return_to,
               membership.role, rep.active,
               lower(btrim(rep.email)) = account.login_normalized AS email_matches,
               (
                 SELECT count(*)::int
                 FROM reps matching_rep
                 WHERE matching_rep.organization_id = oauth.organization_id
                   AND matching_rep.active = true
                   AND lower(btrim(matching_rep.email)) = account.login_normalized
               ) AS matching_reps
        FROM rep_calendar_oauth_attempts oauth
        JOIN organization_memberships membership
          ON membership.organization_id = oauth.organization_id
         AND membership.operator_id = oauth.operator_id
        JOIN operator_accounts account ON account.id = membership.operator_id
        JOIN reps rep
          ON rep.id = oauth.rep_id
         AND rep.organization_id = oauth.organization_id
        WHERE oauth.organization_id = ${input.organizationId}
          AND oauth.operator_id = ${input.operatorId}
          AND oauth.provider = ${input.provider}
          AND oauth.state_hash = ${input.stateHash}
          AND oauth.used_at IS NULL
          AND oauth.expires_at > now()
          AND membership.active = true
          AND account.active = true
        FOR UPDATE OF oauth, membership, rep
      `;
      if (!attempt) return null;
      const allowed =
        ["owner", "admin"].includes(String(attempt.role)) ||
        (Boolean(attempt.active) &&
          Boolean(attempt.emailMatches) &&
          Number(attempt.matchingReps) === 1);
      if (!allowed) return null;
      await transaction`
        UPDATE rep_calendar_oauth_attempts
        SET used_at = now()
        WHERE id = ${attempt.id}
      `;
      return {
        repId: String(attempt.repId),
        provider: attempt.provider as CalendarOAuthProvider,
        returnTo: attempt.returnTo as RepCalendarOAuthReturnTo,
      };
    });
  }

  async listEmailToolAccessKeys(
    organizationSlug: string,
    repId: string,
  ): Promise<EmailToolAccessKeyRecord[]> {
    const rows = await this.sql`
      SELECT k.id, o.slug AS organization_slug, k.rep_id, k.client_type,
             k.label, k.created_at, k.last_used_at, k.revoked_at,
             (i.id IS NOT NULL) AS outlook_identity_linked
      FROM email_tool_access_keys k
      JOIN organizations o ON o.id = k.organization_id
      JOIN reps r ON r.id = k.rep_id AND r.organization_id = o.id
      LEFT JOIN outlook_email_identities i ON i.bootstrap_key_id = k.id
      WHERE o.slug = ${organizationSlug} AND r.id = ${repId}
      ORDER BY k.created_at DESC, k.id
    `;
    return rows.map((row) => emailToolAccessKeyFromRow(row));
  }

  async createEmailToolAccessKey(
    input: CreateEmailToolAccessKey,
  ): Promise<EmailToolAccessKeyRecord> {
    const label = input.label.trim();
    if (label.length < 1 || label.length > 120) {
      throw new Error("Email tool access-key labels must be 1–120 characters.");
    }
    if (!emailToolClientTypes.has(input.clientType)) {
      throw new Error("Unsupported email tool client type.");
    }
    if (!emailToolTokenHashPattern.test(input.tokenHash)) {
      throw new Error("Email tool access keys require a SHA-256 token hash.");
    }

    const [created] = await this.sql`
      WITH inserted AS (
        INSERT INTO email_tool_access_keys (
          organization_id, rep_id, client_type, label, token_hash
        )
        SELECT o.id, r.id, ${input.clientType}, ${label}, ${input.tokenHash}
        FROM organizations o
        JOIN reps r ON r.organization_id = o.id
        WHERE o.slug = ${input.organizationSlug} AND r.id = ${input.repId}
          AND r.active = true
        RETURNING id, organization_id, rep_id, client_type, label,
                  created_at, last_used_at, revoked_at
      )
      SELECT inserted.id, o.slug AS organization_slug, inserted.rep_id,
             inserted.client_type, inserted.label, inserted.created_at,
             inserted.last_used_at, inserted.revoked_at
      FROM inserted
      JOIN organizations o ON o.id = inserted.organization_id
    `;
    if (!created) {
      throw new Error("Active representative not found.");
    }
    return emailToolAccessKeyFromRow(created);
  }

  async revokeEmailToolAccessKey(input: {
    organizationSlug: string;
    repId: string;
    keyId: string;
  }): Promise<EmailToolAccessKeyRecord | null> {
    const [revoked] = await this.sql`
      UPDATE email_tool_access_keys k
      SET revoked_at = coalesce(k.revoked_at, now())
      FROM organizations o, reps r
      WHERE k.id = ${input.keyId}
        AND k.organization_id = o.id AND o.slug = ${input.organizationSlug}
        AND k.rep_id = r.id AND r.organization_id = o.id
        AND r.id = ${input.repId}
      RETURNING k.id, o.slug AS organization_slug, k.rep_id, k.client_type,
                k.label, k.created_at, k.last_used_at, k.revoked_at,
                EXISTS (
                  SELECT 1 FROM outlook_email_identities i
                  WHERE i.bootstrap_key_id = k.id
                ) AS outlook_identity_linked
    `;
    return revoked ? emailToolAccessKeyFromRow(revoked) : null;
  }

  async resolveEmailToolAccessKey(
    tokenHashValue: string,
  ): Promise<ResolvedEmailToolAccess | null> {
    if (!emailToolTokenHashPattern.test(tokenHashValue)) return null;
    const [resolved] = await this.sql`
      UPDATE email_tool_access_keys k
      SET last_used_at = now()
      FROM organizations o, reps r
      WHERE k.token_hash = ${tokenHashValue} AND k.revoked_at IS NULL
        AND k.organization_id = o.id
        AND k.rep_id = r.id AND r.organization_id = o.id
        AND r.active = true
      RETURNING k.id AS key_id, k.client_type, k.label, k.created_at,
                k.last_used_at, o.id AS organization_id,
                o.slug AS organization_slug, o.name AS organization_name,
                r.id AS rep_id, r.name AS rep_name, r.email AS rep_email
    `;
    if (!resolved) return null;
    return {
      keyId: String(resolved.keyId),
      clientType: resolved.clientType as EmailToolClientType,
      label: String(resolved.label),
      createdAt: new Date(String(resolved.createdAt)),
      lastUsedAt: new Date(String(resolved.lastUsedAt)),
      organization: {
        id: String(resolved.organizationId),
        slug: String(resolved.organizationSlug),
        name: String(resolved.organizationName),
      },
      rep: {
        id: String(resolved.repId),
        name: String(resolved.repName),
        email: String(resolved.repEmail),
      },
    };
  }

  async resolveOutlookEmailIdentity(
    input: Pick<OutlookEmailIdentity, "tenantId" | "subject">,
  ): Promise<ResolvedEmailToolAccess | null> {
    const tenantId = input.tenantId.trim().toLowerCase();
    const subject = input.subject.trim();
    if (
      !uuidPattern.test(tenantId) ||
      subject.length < 1 ||
      subject.length > 255
    ) {
      return null;
    }
    const [resolved] = await this.sql`
      UPDATE outlook_email_identities i
      SET last_used_at = now()
      FROM organizations o, reps r, email_tool_access_keys k
      WHERE i.tenant_id = ${tenantId}::uuid AND i.subject = ${subject}
        AND i.organization_id = o.id
        AND i.rep_id = r.id AND r.organization_id = o.id AND r.active = true
        AND i.bootstrap_key_id = k.id
        AND k.organization_id = i.organization_id AND k.rep_id = i.rep_id
        AND k.client_type = 'outlook' AND k.revoked_at IS NULL
      RETURNING i.id AS identity_id, i.created_at, i.last_used_at,
                o.id AS organization_id, o.slug AS organization_slug,
                o.name AS organization_name, r.id AS rep_id,
                r.name AS rep_name, r.email AS rep_email
    `;
    if (!resolved) return null;
    return {
      keyId: `entra:${String(resolved.identityId)}`,
      clientType: "outlook",
      label: "Microsoft Entra",
      createdAt: new Date(String(resolved.createdAt)),
      lastUsedAt: new Date(String(resolved.lastUsedAt)),
      organization: {
        id: String(resolved.organizationId),
        slug: String(resolved.organizationSlug),
        name: String(resolved.organizationName),
      },
      rep: {
        id: String(resolved.repId),
        name: String(resolved.repName),
        email: String(resolved.repEmail),
      },
    };
  }

  async bindOutlookEmailIdentity(
    input: BindOutlookEmailIdentity,
  ): Promise<ResolvedEmailToolAccess | null> {
    const tenantId = input.tenantId.trim().toLowerCase();
    const subject = input.subject.trim();
    const assertedEmail = input.assertedEmail?.trim().toLowerCase() || null;
    if (
      !uuidPattern.test(tenantId) ||
      subject.length < 1 ||
      subject.length > 255 ||
      (assertedEmail !== null &&
        (assertedEmail.length < 3 ||
          assertedEmail.length > 320 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(assertedEmail))) ||
      !emailToolTokenHashPattern.test(input.bootstrapTokenHash)
    ) {
      return null;
    }
    try {
      return await this.sql.begin(async (transaction) => {
        const [key] = await transaction`
        SELECT k.id, k.organization_id, k.rep_id, k.created_at,
               o.slug AS organization_slug, o.name AS organization_name,
               r.name AS rep_name, r.email AS rep_email
        FROM email_tool_access_keys k
        JOIN organizations o ON o.id = k.organization_id
        JOIN reps r ON r.id = k.rep_id AND r.organization_id = o.id
        WHERE k.token_hash = ${input.bootstrapTokenHash}
          AND k.client_type = 'outlook' AND k.revoked_at IS NULL
          AND r.active = true
        FOR UPDATE OF k
      `;
        if (!key) return null;

        const existing = await transaction`
        SELECT id, organization_id, rep_id, bootstrap_key_id, tenant_id,
               subject
        FROM outlook_email_identities
        WHERE (tenant_id = ${tenantId}::uuid AND subject = ${subject})
           OR bootstrap_key_id = ${key.id}
        FOR UPDATE
      `;
        if (
          existing.some(
            (row) =>
              String(row.organizationId) !== String(key.organizationId) ||
              String(row.repId) !== String(key.repId) ||
              String(row.bootstrapKeyId) !== String(key.id) ||
              String(row.tenantId) !== tenantId ||
              String(row.subject) !== subject,
          )
        ) {
          return null;
        }

        const [identity] = await transaction`
        INSERT INTO outlook_email_identities (
          organization_id, rep_id, bootstrap_key_id, tenant_id, subject,
          asserted_email
        )
        VALUES (
          ${key.organizationId}, ${key.repId}, ${key.id}, ${tenantId}::uuid,
          ${subject}, ${assertedEmail}
        )
        ON CONFLICT (tenant_id, subject) DO UPDATE
        SET asserted_email = EXCLUDED.asserted_email, last_used_at = now()
        RETURNING id, created_at, last_used_at
      `;
        if (!identity) return null;
        await transaction`
        UPDATE email_tool_access_keys SET last_used_at = now()
        WHERE id = ${key.id}
      `;
        return {
          keyId: `entra:${String(identity.id)}`,
          clientType: "outlook" as const,
          label: "Microsoft Entra",
          createdAt: new Date(String(identity.createdAt)),
          lastUsedAt: new Date(String(identity.lastUsedAt)),
          organization: {
            id: String(key.organizationId),
            slug: String(key.organizationSlug),
            name: String(key.organizationName),
          },
          rep: {
            id: String(key.repId),
            name: String(key.repName),
            email: String(key.repEmail),
          },
        };
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        return null;
      }
      throw error;
    }
  }

  async repIdentityForVerifiedEmail(
    email: string,
  ): Promise<VerifiedRepIdentity | null> {
    const normalizedEmail = email.trim().toLowerCase();
    if (
      normalizedEmail.length < 3 ||
      normalizedEmail.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    ) {
      return null;
    }
    const rows = await this.sql`
      SELECT o.id AS organization_id, o.slug AS organization_slug,
             o.name AS organization_name, r.id AS rep_id, r.name AS rep_name,
             r.email AS rep_email
      FROM reps r
      JOIN organizations o ON o.id = r.organization_id
      WHERE r.active = true AND lower(r.email) = ${normalizedEmail}
      ORDER BY o.id, r.id
      LIMIT 2
    `;
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    return {
      organization: {
        id: String(row.organizationId),
        slug: String(row.organizationSlug),
        name: String(row.organizationName),
      },
      rep: {
        id: String(row.repId),
        name: String(row.repName),
        email: String(row.repEmail),
      },
    };
  }

  async emailToolSchedulingCatalog(
    organizationSlug: string,
    repId: string,
  ): Promise<EmailToolSchedulingCatalog | null> {
    return this.sql.begin(async (transaction) => {
      const [identity] = await transaction`
        SELECT o.id AS organization_id, o.name AS organization_name,
               o.slug AS organization_slug, r.id AS rep_id, r.name AS rep_name
        FROM organizations o
        JOIN reps r ON r.organization_id = o.id
        WHERE o.slug = ${organizationSlug} AND r.id = ${repId}
          AND r.active = true
      `;
      if (!identity) return null;

      const meetingTypes = await transaction`
        SELECT mt.id, mt.slug, mt.title, mt.description, mt.duration_minutes,
               mt.conference_provider, mt.rep_id,
               coalesce(target_rep.name, target_pool.name) AS target_name
        FROM meeting_types mt
        LEFT JOIN reps target_rep
          ON target_rep.id = mt.rep_id
         AND target_rep.organization_id = mt.organization_id
        LEFT JOIN routing_pools target_pool
          ON target_pool.id = mt.pool_id
         AND target_pool.organization_id = mt.organization_id
        WHERE mt.organization_id = ${identity.organizationId}
          AND mt.active = true
          AND (
            mt.rep_id = ${identity.repId}
            OR EXISTS (
              SELECT 1
              FROM routing_pool_members access_membership
              WHERE access_membership.pool_id = mt.pool_id
                AND access_membership.rep_id = ${identity.repId}
            )
          )
          AND EXISTS (
            SELECT 1
            FROM reps available_rep
            JOIN rep_calendar_connections booking_calendar
              ON booking_calendar.rep_id = available_rep.id
             AND booking_calendar.provider = available_rep.active_calendar_provider
            WHERE available_rep.organization_id = mt.organization_id
              AND available_rep.active = true
              AND (
                (mt.rep_id IS NOT NULL AND available_rep.id = mt.rep_id)
                OR (
                  mt.pool_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                    FROM routing_pool_members available_membership
                    WHERE available_membership.pool_id = mt.pool_id
                      AND available_membership.rep_id = available_rep.id
                  )
                )
              )
              AND (
                mt.conference_provider IN ('none', 'zoom')
                OR (
                  mt.conference_provider = 'google_meet'
                  AND booking_calendar.provider = 'google'
                )
                OR (
                  mt.conference_provider = 'microsoft_teams'
                  AND booking_calendar.provider = 'microsoft'
                )
              )
          )
        ORDER BY (mt.rep_id = ${identity.repId}) DESC, mt.title, mt.slug
      `;
      const smartRouterLinks = await transaction`
        SELECT rl.id, rl.slug, rl.title, rl.description, rl.button_label,
               rl.accent_color
        FROM router_links rl
        WHERE rl.organization_id = ${identity.organizationId}
          AND rl.active = true
        ORDER BY rl.title, rl.slug
      `;
      const recentAssets = await transaction`
        SELECT purpose, asset_kind, meeting_type_id, router_link_id, updated_at
        FROM email_tool_recent_assets
        WHERE organization_id = ${identity.organizationId}
          AND rep_id = ${identity.repId}
        ORDER BY updated_at DESC, purpose
      `;
      const meetingTypeIds = new Set(meetingTypes.map((row) => String(row.id)));
      const routerLinkIds = new Set(
        smartRouterLinks.map((row) => String(row.id)),
      );
      const recentLink = recentAssets.find((row) => row.purpose === "link");
      const recentTimes = recentAssets.find((row) => row.purpose === "times");
      const recentLinkAssetId = recentLink
        ? recentLink.assetKind === "meeting_type"
          ? meetingTypeIds.has(String(recentLink.meetingTypeId))
            ? String(recentLink.meetingTypeId)
            : null
          : routerLinkIds.has(String(recentLink.routerLinkId))
            ? String(recentLink.routerLinkId)
            : null
        : null;
      const recentMeetingTypeId =
        recentTimes?.assetKind === "meeting_type" &&
        meetingTypeIds.has(String(recentTimes.meetingTypeId))
          ? String(recentTimes.meetingTypeId)
          : null;
      const recentPurpose =
        recentAssets.find(
          (row) =>
            (row.purpose === "link" && recentLinkAssetId) ||
            (row.purpose === "times" && recentMeetingTypeId),
        )?.purpose ?? null;

      return {
        organizationName: String(identity.organizationName),
        organizationSlug: String(identity.organizationSlug),
        repId: String(identity.repId),
        repName: String(identity.repName),
        recentLinkAssetId,
        recentMeetingTypeId,
        recentPurpose: recentPurpose as "link" | "times" | null,
        meetingTypes: meetingTypes.map((row) => ({
          id: String(row.id),
          slug: String(row.slug),
          title: String(row.title),
          description: String(row.description),
          durationMinutes: Number(row.durationMinutes),
          conferenceProvider: row.conferenceProvider as ConferenceProvider,
          targetType: row.repId ? ("rep" as const) : ("pool" as const),
          targetName: String(row.targetName),
        })),
        smartRouterLinks: smartRouterLinks.map((row) => ({
          id: String(row.id),
          slug: String(row.slug),
          title: String(row.title),
          description: String(row.description),
          buttonLabel: String(row.buttonLabel),
          accentColor: String(row.accentColor),
        })),
      };
    });
  }

  async rememberEmailToolRecentAsset(input: {
    organizationSlug: string;
    repId: string;
    purpose: "link" | "times";
    assetId: string;
  }): Promise<boolean> {
    if (!uuidPattern.test(input.repId) || !uuidPattern.test(input.assetId)) {
      return false;
    }
    const catalog = await this.emailToolSchedulingCatalog(
      input.organizationSlug,
      input.repId,
    );
    if (!catalog) return false;

    const meetingType = catalog.meetingTypes.find(
      (candidate) => candidate.id === input.assetId,
    );
    const routerLink = catalog.smartRouterLinks.find(
      (candidate) => candidate.id === input.assetId,
    );
    if (!meetingType && (!routerLink || input.purpose === "times")) {
      return false;
    }

    const assetKind = meetingType ? "meeting_type" : "router_link";
    const meetingTypeId = meetingType?.id ?? null;
    const routerLinkId = routerLink?.id ?? null;
    const [stored] = await this.sql`
      INSERT INTO email_tool_recent_assets (
        organization_id, rep_id, purpose, asset_kind,
        meeting_type_id, router_link_id, updated_at
      )
      SELECT o.id, r.id, ${input.purpose}, ${assetKind},
             ${meetingTypeId}::uuid, ${routerLinkId}::uuid, now()
      FROM organizations o
      JOIN reps r ON r.organization_id = o.id
      WHERE o.slug = ${input.organizationSlug}
        AND r.id = ${input.repId}
        AND r.active = true
      ON CONFLICT (organization_id, rep_id, purpose) DO UPDATE
      SET asset_kind = EXCLUDED.asset_kind,
          meeting_type_id = EXCLUDED.meeting_type_id,
          router_link_id = EXCLUDED.router_link_id,
          updated_at = now()
      RETURNING purpose
    `;
    return Boolean(stored);
  }

  async route(request: RouteRequest): Promise<RouteDecision> {
    return this.sql.begin(async (transaction) => {
      const [organization] = (await transaction`
        SELECT id, name, slug FROM organizations WHERE slug = ${request.organizationSlug}
      `) as unknown as OrganizationRow[];
      if (!organization) {
        throw new Error(`Unknown organization: ${request.organizationSlug}`);
      }

      if (request.externalId) {
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtext(${`${organization.id}:${request.externalId}`})
          )
        `;
        const [existing] = await transaction`
          SELECT rd.id, rd.lead_email, rd.reason, rd.created_at, r.name AS rep_name,
                 r.email AS rep_email, rr.name AS rule_name, rp.name AS pool_name,
                 coalesce(j.status, 'missing') AS writeback_status,
                 rd.availability_source
          FROM routing_decisions rd
          JOIN reps r ON r.id = rd.rep_id
          JOIN routing_rules rr ON rr.id = rd.rule_id
          JOIN routing_pools rp ON rp.id = rd.pool_id
          LEFT JOIN jobs j ON j.payload->>'decisionId' = rd.id::text
            AND j.type = 'crm.owner.writeback'
          WHERE rd.organization_id = ${organization.id}
            AND rd.external_id = ${request.externalId}
          LIMIT 1
        `;
        if (existing) return decisionFromRow(existing);
      }

      let loaded = await routingContext(transaction, organization.id);
      const preliminary = evaluateRoute(
        request.lead,
        loaded.context,
        request.now,
        { unavailableRepEmails: request.unavailableRepEmails },
      );

      await transaction`
        SELECT pg_advisory_xact_lock(hashtext(${preliminary.rule.poolId}))
      `;
      loaded = await routingContext(transaction, organization.id);
      const result = evaluateRoute(request.lead, loaded.context, request.now, {
        unavailableRepEmails: request.unavailableRepEmails,
      });

      const [hubspotConnection] = await transaction`
        SELECT 1 FROM oauth_connections
        WHERE organization_id = ${organization.id} AND provider = 'hubspot'
      `;
      const crmAdapter = hubspotConnection ? "hubspot" : "development";
      const availabilitySource =
        request.availabilitySourceByRepEmail?.[result.rep.email] ??
        request.availabilitySource ??
        "weekly_schedule";

      const [decision] = await transaction`
        INSERT INTO routing_decisions (
          organization_id, external_id, lead_email, lead, rule_id, pool_id, rep_id,
          reason, availability_source
        ) VALUES (
          ${organization.id}, ${request.externalId ?? null}, ${request.lead.email},
          ${transaction.json(request.lead as JSONValue)}, ${result.rule.id}, ${result.rule.poolId},
          ${result.rep.id}, ${result.reason}, ${availabilitySource}
        )
        ON CONFLICT (organization_id, external_id)
        DO UPDATE SET external_id = EXCLUDED.external_id
        RETURNING id, created_at
      `;

      await transaction`
        INSERT INTO assignment_state (pool_id, rep_id, assignments, last_assigned_at)
        VALUES (${result.rule.poolId}, ${result.rep.id}, 1, ${result.evaluatedAt})
        ON CONFLICT (pool_id, rep_id) DO UPDATE SET
          assignments = assignment_state.assignments + 1,
          last_assigned_at = EXCLUDED.last_assigned_at
      `;

      await transaction`
        INSERT INTO jobs (organization_id, type, payload)
        VALUES (
          ${organization.id},
          'crm.owner.writeback',
          ${transaction.json({
            adapter: crmAdapter,
            organizationSlug: organization.slug,
            decisionId: decision!.id,
            leadEmail: request.lead.email,
            ownerEmail: result.rep.email,
          })}
        )
      `;

      const ruleRow = loaded.rules.find((rule) => rule.id === result.rule.id)!;
      return {
        id: String(decision!.id),
        leadEmail: request.lead.email,
        repName: result.rep.name,
        repEmail: result.rep.email,
        ruleName: result.rule.name,
        poolName: ruleRow.poolName,
        reason: result.reason,
        createdAt: new Date(String(decision!.createdAt)).toISOString(),
        writebackStatus: "pending",
        availabilitySource,
      };
    });
  }

  async routeCandidates(
    request: Pick<RouteRequest, "organizationSlug" | "lead" | "now">,
  ): Promise<string[]> {
    return (await this.routeCandidateReps(request)).map((rep) => rep.email);
  }

  async routeCandidateReps(
    request: Pick<RouteRequest, "organizationSlug" | "lead" | "now">,
  ): Promise<RouteCandidate[]> {
    const [organization] = (await this.sql`
      SELECT id, name, slug FROM organizations WHERE slug = ${request.organizationSlug}
    `) as unknown as OrganizationRow[];
    if (!organization)
      throw new Error(`Unknown organization: ${request.organizationSlug}`);

    const loaded = await routingContext(this.sql, organization.id);
    return eligibleRepsForLead(
      request.lead,
      loaded.context,
      request.now,
    ).reps.map((rep) => ({ id: rep.id, email: rep.email }));
  }

  async decisionByExternalId(
    organizationSlug: string,
    externalId: string,
  ): Promise<RouteDecision | null> {
    const [row] = await this.sql`
      SELECT rd.id, rd.lead_email, rd.reason, rd.created_at, r.name AS rep_name,
             r.email AS rep_email, rr.name AS rule_name, rp.name AS pool_name,
             coalesce(j.status, 'missing') AS writeback_status,
             rd.availability_source
      FROM routing_decisions rd
      JOIN organizations o ON o.id = rd.organization_id
      JOIN reps r ON r.id = rd.rep_id
      JOIN routing_rules rr ON rr.id = rd.rule_id
      JOIN routing_pools rp ON rp.id = rd.pool_id
      LEFT JOIN jobs j ON j.payload->>'decisionId' = rd.id::text
        AND j.type = 'crm.owner.writeback'
      WHERE o.slug = ${organizationSlug} AND rd.external_id = ${externalId}
    `;
    return row ? decisionFromRow(row) : null;
  }

  async dashboard(organizationSlug: string): Promise<Dashboard> {
    const [organization] = (await this.sql`
      SELECT id, name, slug FROM organizations WHERE slug = ${organizationSlug}
    `) as unknown as OrganizationRow[];
    if (!organization)
      throw new Error(`Unknown organization: ${organizationSlug}`);

    const [stats] = await this.sql`
      SELECT
        (SELECT count(*)::int FROM routing_decisions WHERE organization_id = ${organization.id}
          AND created_at >= date_trunc('day', now())) AS routes_today,
        (SELECT count(*)::int FROM reps WHERE organization_id = ${organization.id} AND active) AS active_reps,
        (SELECT count(*)::int FROM routing_rules WHERE organization_id = ${organization.id} AND active) AS active_rules,
        (SELECT count(*)::int FROM jobs WHERE organization_id = ${organization.id}
          AND status IN ('pending', 'processing')) AS pending_jobs
    `;

    const repRows = await this.sql`
      SELECT r.id AS rep_id, r.name AS rep_name, r.email, r.weight, r.active,
             r.timezone, r.availability, r.availability_overrides,
             r.availability_schedule_id,
             schedule.name AS availability_schedule_name,
             r.daily_meeting_limit, r.weekly_meeting_limit,
             r.scheduling_slug,
             r.meeting_duration_minutes, r.active_calendar_provider,
             coalesce(sum(ast.assignments), 0)::int AS assignments,
             google.external_account_name AS google_account_name,
             google.rep_id IS NOT NULL AS google_connected,
             google.check_conflicts AS google_check_conflicts,
             google.scopes AS google_scopes,
             google.calendar_catalog_synced_at AS google_catalog_synced_at,
             google.calendar_catalog_error AS google_catalog_error,
             coalesce((
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'calendarId', source.provider_calendar_id,
                   'name', source.display_name,
                   'isDefault', source.is_provider_default,
                   'selected', source.selected_for_conflicts,
                   'available', source.missing_since IS NULL,
                   'lastSeenAt', source.last_seen_at,
                   'missingSince', source.missing_since
                 )
                 ORDER BY source.is_provider_default DESC,
                          source.display_name, source.provider_calendar_id
               )
               FROM rep_calendar_sources source
               WHERE source.rep_id = r.id AND source.provider = 'google'
             ), '[]'::jsonb) AS google_calendars,
             microsoft.external_account_name AS microsoft_account_name,
             microsoft.rep_id IS NOT NULL AS microsoft_connected,
             microsoft.check_conflicts AS microsoft_check_conflicts,
             microsoft.scopes AS microsoft_scopes,
             microsoft.calendar_catalog_synced_at AS microsoft_catalog_synced_at,
             microsoft.calendar_catalog_error AS microsoft_catalog_error,
             coalesce((
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'calendarId', source.provider_calendar_id,
                   'name', source.display_name,
                   'isDefault', source.is_provider_default,
                   'selected', source.selected_for_conflicts,
                   'available', source.missing_since IS NULL,
                   'lastSeenAt', source.last_seen_at,
                   'missingSince', source.missing_since
                 )
                 ORDER BY source.is_provider_default DESC,
                          source.display_name, source.provider_calendar_id
               )
               FROM rep_calendar_sources source
               WHERE source.rep_id = r.id AND source.provider = 'microsoft'
             ), '[]'::jsonb) AS microsoft_calendars
      FROM reps r
      LEFT JOIN assignment_state ast ON ast.rep_id = r.id
      LEFT JOIN rep_calendar_connections google
        ON google.rep_id = r.id AND google.provider = 'google'
      LEFT JOIN rep_calendar_connections microsoft
        ON microsoft.rep_id = r.id AND microsoft.provider = 'microsoft'
      LEFT JOIN availability_schedules schedule
        ON schedule.id = r.availability_schedule_id
       AND schedule.organization_id = r.organization_id
      WHERE r.organization_id = ${organization.id}
      GROUP BY r.id, google.external_account_name, google.rep_id,
               google.check_conflicts, google.scopes,
               google.calendar_catalog_synced_at, google.calendar_catalog_error,
               microsoft.external_account_name, microsoft.rep_id,
               microsoft.check_conflicts, microsoft.scopes,
               microsoft.calendar_catalog_synced_at,
               microsoft.calendar_catalog_error, schedule.name
      ORDER BY r.active DESC, r.name, r.email
    `;

    const poolRows = await this.sql`
      SELECT rp.id, rp.name, rp.slug, rp.strategy, r.id AS rep_id,
             r.name AS rep_name, r.email, r.weight, r.active, r.timezone,
             r.availability, r.availability_overrides,
             r.availability_schedule_id,
             schedule.name AS availability_schedule_name,
             r.daily_meeting_limit, r.weekly_meeting_limit,
             r.scheduling_slug, r.meeting_duration_minutes,
             coalesce(ast.assignments, 0)::int AS assignments,
             google.external_account_name AS google_account_name,
             google.rep_id IS NOT NULL AS google_connected,
             google.check_conflicts AS google_check_conflicts,
             google.scopes AS google_scopes,
             google.calendar_catalog_synced_at AS google_catalog_synced_at,
             google.calendar_catalog_error AS google_catalog_error,
             coalesce((
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'calendarId', source.provider_calendar_id,
                   'name', source.display_name,
                   'isDefault', source.is_provider_default,
                   'selected', source.selected_for_conflicts,
                   'available', source.missing_since IS NULL,
                   'lastSeenAt', source.last_seen_at,
                   'missingSince', source.missing_since
                 )
                 ORDER BY source.is_provider_default DESC,
                          source.display_name, source.provider_calendar_id
               )
               FROM rep_calendar_sources source
               WHERE source.rep_id = r.id AND source.provider = 'google'
             ), '[]'::jsonb) AS google_calendars,
             microsoft.external_account_name AS microsoft_account_name,
             microsoft.rep_id IS NOT NULL AS microsoft_connected,
             microsoft.check_conflicts AS microsoft_check_conflicts,
             microsoft.scopes AS microsoft_scopes,
             microsoft.calendar_catalog_synced_at AS microsoft_catalog_synced_at,
             microsoft.calendar_catalog_error AS microsoft_catalog_error,
             coalesce((
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'calendarId', source.provider_calendar_id,
                   'name', source.display_name,
                   'isDefault', source.is_provider_default,
                   'selected', source.selected_for_conflicts,
                   'available', source.missing_since IS NULL,
                   'lastSeenAt', source.last_seen_at,
                   'missingSince', source.missing_since
                 )
                 ORDER BY source.is_provider_default DESC,
                          source.display_name, source.provider_calendar_id
               )
               FROM rep_calendar_sources source
               WHERE source.rep_id = r.id AND source.provider = 'microsoft'
             ), '[]'::jsonb) AS microsoft_calendars,
             r.active_calendar_provider
      FROM routing_pools rp
      LEFT JOIN routing_pool_members rpm ON rpm.pool_id = rp.id
      LEFT JOIN reps r ON r.id = rpm.rep_id
      LEFT JOIN assignment_state ast ON ast.pool_id = rp.id AND ast.rep_id = r.id
      LEFT JOIN rep_calendar_connections google
        ON google.rep_id = r.id AND google.provider = 'google'
      LEFT JOIN rep_calendar_connections microsoft
        ON microsoft.rep_id = r.id AND microsoft.provider = 'microsoft'
      LEFT JOIN availability_schedules schedule
        ON schedule.id = r.availability_schedule_id
       AND schedule.organization_id = r.organization_id
      WHERE rp.organization_id = ${organization.id}
      ORDER BY rp.name, r.name
    `;

    const availabilityScheduleRows = await this.sql`
      SELECT schedule.id, schedule.name, schedule.availability,
             count(rep.id)::int AS assigned_rep_count
      FROM availability_schedules schedule
      LEFT JOIN reps rep ON rep.availability_schedule_id = schedule.id
      WHERE schedule.organization_id = ${organization.id}
      GROUP BY schedule.id
      ORDER BY lower(schedule.name), schedule.id
    `;

    const pools = new Map<string, Dashboard["pools"][number]>();
    for (const row of poolRows) {
      const id = String(row.id);
      const pool = pools.get(id) ?? {
        id,
        name: String(row.name),
        slug: String(row.slug),
        strategy: String(row.strategy),
        members: [],
      };
      if (row.email) {
        pool.members.push(dashboardRepFromRow(row));
      }
      pools.set(id, pool);
    }

    const rules = await this.sql`
      SELECT rr.id, rr.name, rr.priority, rr.conditions, rr.pool_id,
             rr.active, rp.name AS pool_name
      FROM routing_rules rr
      JOIN routing_pools rp ON rp.id = rr.pool_id
      WHERE rr.organization_id = ${organization.id}
      ORDER BY rr.active DESC, rr.priority, rr.name
    `;

    const decisionRows = await this.sql`
      SELECT rd.id, rd.lead_email, rd.reason, rd.created_at, r.name AS rep_name,
             r.email AS rep_email, rr.name AS rule_name, rp.name AS pool_name,
             coalesce(j.status, 'missing') AS writeback_status,
             rd.availability_source
      FROM routing_decisions rd
      JOIN reps r ON r.id = rd.rep_id
      JOIN routing_rules rr ON rr.id = rd.rule_id
      JOIN routing_pools rp ON rp.id = rd.pool_id
      LEFT JOIN jobs j ON j.payload->>'decisionId' = rd.id::text
        AND j.type = 'crm.owner.writeback'
      WHERE rd.organization_id = ${organization.id}
      ORDER BY rd.created_at DESC
      LIMIT 12
    `;

    const meetingTypeRows = await this.sql`
      SELECT mt.id, mt.slug, mt.title, mt.description, mt.duration_minutes,
             mt.buffer_before_minutes, mt.buffer_after_minutes,
             mt.minimum_notice_minutes, mt.booking_window_days,
             mt.invitee_limit_scope, mt.invitee_limit_count,
             mt.reschedule_cutoff_minutes, mt.cancel_cutoff_minutes,
             mt.conference_provider, mt.zoom_join_url, mt.reminder_minutes,
             mt.active, mt.rep_id, mt.pool_id,
             coalesce(r.name, rp.name) AS target_name,
             coalesce((
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'repId', cohost.rep_id,
                   'name', cohost_rep.name,
                   'requiredForAvailability', cohost.required_for_availability
                 )
                 ORDER BY cohost.position
               )
               FROM meeting_type_cohosts cohost
               JOIN reps cohost_rep ON cohost_rep.id = cohost.rep_id
               WHERE cohost.meeting_type_id = mt.id
             ), '[]'::jsonb) AS cohosts,
             coalesce((
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'poolId', cohost_group.pool_id,
                   'poolName', cohost_pool.name,
                   'crmOwnerProperty', cohost_group.crm_owner_property,
                   'requiredForAvailability',
                     cohost_group.required_for_availability
                 )
                 ORDER BY cohost_group.position
               )
               FROM meeting_type_cohost_groups cohost_group
               JOIN routing_pools cohost_pool
                 ON cohost_pool.id = cohost_group.pool_id
               WHERE cohost_group.meeting_type_id = mt.id
             ), '[]'::jsonb) AS cohost_groups
      FROM meeting_types mt
      LEFT JOIN reps r ON r.id = mt.rep_id
      LEFT JOIN routing_pools rp ON rp.id = mt.pool_id
      WHERE mt.organization_id = ${organization.id}
      ORDER BY mt.active DESC, mt.title, mt.slug
    `;

    const routerLinkRows = await this.sql`
      SELECT rl.id, rl.name, rl.slug, rl.title, rl.description,
             rl.button_label, rl.no_match_message, rl.accent_color,
             rl.success_redirect_url, rl.success_redirect_delay_seconds,
             rl.questions, rl.active, rld.pool_id, rp.name AS pool_name,
             rld.meeting_type_id, mt.title AS meeting_type_title,
             mt.slug AS meeting_type_slug
      FROM router_links rl
      LEFT JOIN router_link_destinations rld ON rld.router_link_id = rl.id
      LEFT JOIN routing_pools rp ON rp.id = rld.pool_id
      LEFT JOIN meeting_types mt ON mt.id = rld.meeting_type_id
      WHERE rl.organization_id = ${organization.id}
      ORDER BY rl.active DESC, rl.name, rl.slug, rp.name
    `;
    const routerFormBridgeRows = await this.sql`
      SELECT rfb.id, o.slug AS organization_slug, rfb.router_link_id,
             rl.name AS router_link_name, rl.slug AS router_link_slug,
             rfb.name, rfb.provider, rfb.form_id, rfb.allowed_origins,
             rfb.attendee_name_fields, rfb.attendee_email_field,
             rfb.answer_mappings, rfb.active, rfb.link_config_version,
             rl.config_version AS current_link_config_version,
             rfb.created_at, rfb.updated_at
      FROM router_form_bridges rfb
      JOIN organizations o ON o.id = rfb.organization_id
      JOIN router_links rl
        ON rl.id = rfb.router_link_id
       AND rl.organization_id = rfb.organization_id
      WHERE rfb.organization_id = ${organization.id}
      ORDER BY rfb.active DESC, rfb.name, rfb.created_at
    `;
    const routerLinks = new Map<string, RouterLink>();
    for (const row of routerLinkRows) {
      const id = String(row.id);
      const routerLink = routerLinks.get(id) ?? {
        id,
        name: String(row.name),
        slug: String(row.slug),
        title: String(row.title),
        description: String(row.description),
        buttonLabel: String(row.buttonLabel),
        noMatchMessage: String(row.noMatchMessage),
        successRedirectUrl: row.successRedirectUrl
          ? String(row.successRedirectUrl)
          : null,
        successRedirectDelaySeconds: Number(row.successRedirectDelaySeconds),
        accentColor: String(row.accentColor),
        active: Boolean(row.active),
        questions: row.questions as RouterLinkQuestion[],
        destinations: [],
      };
      if (row.poolId) {
        routerLink.destinations.push({
          poolId: String(row.poolId),
          poolName: String(row.poolName),
          meetingTypeId: String(row.meetingTypeId),
          meetingTypeTitle: String(row.meetingTypeTitle),
          meetingTypeSlug: String(row.meetingTypeSlug),
        });
      }
      routerLinks.set(id, routerLink);
    }

    return {
      organization: { name: organization.name, slug: organization.slug },
      stats: {
        routesToday: Number(stats?.routesToday ?? 0),
        activeReps: Number(stats?.activeReps ?? 0),
        activeRules: Number(stats?.activeRules ?? 0),
        pendingJobs: Number(stats?.pendingJobs ?? 0),
      },
      reps: repRows.map((row) => dashboardRepFromRow(row)),
      availabilitySchedules: availabilityScheduleRows.map((row) =>
        availabilityScheduleFromRow(row),
      ),
      pools: [...pools.values()],
      rules: rules.map((rule) => ({
        id: String(rule.id),
        name: String(rule.name),
        priority: Number(rule.priority),
        conditions: rule.conditions as Dashboard["rules"][number]["conditions"],
        poolId: String(rule.poolId),
        poolName: String(rule.poolName),
        active: Boolean(rule.active),
      })),
      meetingTypes: meetingTypeRows.map(
        (row): MeetingType => ({
          id: String(row.id),
          slug: String(row.slug),
          title: String(row.title),
          description: String(row.description),
          durationMinutes: Number(row.durationMinutes),
          bufferBeforeMinutes: Number(row.bufferBeforeMinutes),
          bufferAfterMinutes: Number(row.bufferAfterMinutes),
          minimumNoticeMinutes: Number(row.minimumNoticeMinutes),
          bookingWindowDays: Number(row.bookingWindowDays),
          inviteeLimitScope: row.inviteeLimitScope as InviteeLimitScope,
          inviteeLimitCount:
            row.inviteeLimitCount === null ||
            row.inviteeLimitCount === undefined
              ? null
              : Number(row.inviteeLimitCount),
          rescheduleCutoffMinutes:
            row.rescheduleCutoffMinutes === null ||
            row.rescheduleCutoffMinutes === undefined
              ? null
              : Number(row.rescheduleCutoffMinutes),
          cancelCutoffMinutes:
            row.cancelCutoffMinutes === null ||
            row.cancelCutoffMinutes === undefined
              ? null
              : Number(row.cancelCutoffMinutes),
          conferenceProvider: row.conferenceProvider as ConferenceProvider,
          zoomJoinUrl: row.zoomJoinUrl ? String(row.zoomJoinUrl) : null,
          reminderMinutes: Number(row.reminderMinutes),
          active: Boolean(row.active),
          targetType: row.repId ? "rep" : "pool",
          targetId: String(row.repId ?? row.poolId),
          targetName: String(row.targetName),
          cohosts: (row.cohosts as Array<Record<string, unknown>>).map(
            (cohost) => ({
              repId: String(cohost.repId),
              name: String(cohost.name),
              requiredForAvailability: Boolean(cohost.requiredForAvailability),
            }),
          ),
          cohostGroups: (
            row.cohostGroups as Array<Record<string, unknown>>
          ).map((group) => ({
            poolId: String(group.poolId),
            poolName: String(group.poolName),
            crmOwnerProperty: group.crmOwnerProperty
              ? String(group.crmOwnerProperty)
              : null,
            requiredForAvailability: Boolean(group.requiredForAvailability),
          })),
        }),
      ),
      routerLinks: [...routerLinks.values()],
      routerFormBridges: routerFormBridgeRows.map(
        (row): RouterFormBridge => ({
          id: String(row.id),
          organizationSlug: String(row.organizationSlug),
          routerLinkId: String(row.routerLinkId),
          routerLinkName: String(row.routerLinkName),
          routerLinkSlug: String(row.routerLinkSlug),
          name: String(row.name),
          provider: row.provider as RouterFormBridge["provider"],
          formId: row.formId ? String(row.formId) : null,
          allowedOrigins: row.allowedOrigins as string[],
          attendeeNameFields: row.attendeeNameFields as string[],
          attendeeEmailField: String(row.attendeeEmailField),
          answerMappings: row.answerMappings as Record<string, string>,
          active: Boolean(row.active),
          linkConfigVersion: Number(row.linkConfigVersion),
          currentLinkConfigVersion: Number(row.currentLinkConfigVersion),
          createdAt: new Date(row.createdAt as Date).toISOString(),
          updatedAt: new Date(row.updatedAt as Date).toISOString(),
        }),
      ),
      decisions: decisionRows.map((row) => decisionFromRow(row)),
    };
  }

  async reporting(
    organizationSlug: string,
    rangeDays: ReportingRangeDays,
    now = new Date(),
  ): Promise<ReportingSnapshot> {
    if (
      ![1, 7, 30, 90].includes(rangeDays) ||
      !Number.isFinite(now.getTime())
    ) {
      throw new Error("Choose a valid reporting range.");
    }
    const startsAt = new Date(now.getTime() - rangeDays * 86_400_000);
    const [organization] = await this.sql`
      SELECT id FROM organizations WHERE slug = ${organizationSlug}
    `;
    if (!organization) {
      throw new Error(`Unknown organization: ${organizationSlug}`);
    }

    const [
      [funnelRow],
      [bookingHealthRow],
      routerRows,
      repRows,
      deliveryRows,
      recentMeetingRows,
    ] = await Promise.all([
      this.sql`
        SELECT
          count(*)::int AS submissions,
          count(*) FILTER (WHERE e.outcome = 'matched')::int AS qualified,
          count(*) FILTER (WHERE e.outcome = 'no_match')::int AS no_match,
          count(*) FILTER (WHERE e.booked_at IS NOT NULL)::int AS bookings
        FROM router_funnel_events e
        WHERE e.organization_id = ${organization.id}
          AND e.submitted_at >= ${startsAt}
          AND e.submitted_at < ${now}
      `,
      this.sql`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
          count(*) FILTER (
            WHERE status IN (
              'pending', 'reschedule_pending', 'cancel_pending'
            )
          )::int AS in_progress,
          count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
          count(*) FILTER (WHERE status = 'failed')::int AS failed,
          count(*) FILTER (WHERE attendance_outcome = 'no_show')::int AS no_shows
        FROM bookings
        WHERE organization_id = ${organization.id}
          AND created_at >= ${startsAt}
          AND created_at < ${now}
      `,
      this.sql`
        SELECT rl.id, rl.name, rl.active,
               count(e.session_id)::int AS submissions,
               count(e.session_id) FILTER (
                 WHERE e.outcome = 'matched'
               )::int AS qualified,
               count(e.session_id) FILTER (
                 WHERE e.booked_at IS NOT NULL
               )::int AS bookings,
               max(e.submitted_at) AS last_activity_at
        FROM router_links rl
        LEFT JOIN router_funnel_events e
          ON e.router_link_id = rl.id
         AND e.submitted_at >= ${startsAt}
         AND e.submitted_at < ${now}
        WHERE rl.organization_id = ${organization.id}
        GROUP BY rl.id
        ORDER BY count(e.session_id) DESC, rl.active DESC, rl.name
      `,
      this.sql`
        WITH route_counts AS (
          SELECT rep_id, count(*)::int AS routes
          FROM routing_decisions
          WHERE organization_id = ${organization.id}
            AND created_at >= ${startsAt}
            AND created_at < ${now}
          GROUP BY rep_id
        ), meeting_counts AS (
          SELECT rep_id, count(*)::int AS meetings,
                 count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
                 count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                 count(*) FILTER (
                   WHERE attendance_outcome = 'no_show'
                 )::int AS no_shows
          FROM bookings
          WHERE organization_id = ${organization.id}
            AND created_at >= ${startsAt}
            AND created_at < ${now}
          GROUP BY rep_id
        )
        SELECT r.id, r.name, r.active,
               coalesce(rc.routes, 0)::int AS routes,
               coalesce(mc.meetings, 0)::int AS meetings,
               coalesce(mc.confirmed, 0)::int AS confirmed,
               coalesce(mc.cancelled, 0)::int AS cancelled,
               coalesce(mc.no_shows, 0)::int AS no_shows,
               sum(coalesce(rc.routes, 0)) OVER ()::int AS total_routes
        FROM reps r
        LEFT JOIN route_counts rc ON rc.rep_id = r.id
        LEFT JOIN meeting_counts mc ON mc.rep_id = r.id
        WHERE r.organization_id = ${organization.id}
        ORDER BY coalesce(rc.routes, 0) DESC, coalesce(mc.meetings, 0) DESC,
                 r.active DESC, r.name
      `,
      this.sql`
        SELECT calendar_provider AS provider,
               count(*)::int AS total,
               count(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
               count(*) FILTER (
                 WHERE status IN (
                   'pending', 'reschedule_pending', 'cancel_pending'
                 )
               )::int AS in_progress,
               count(*) FILTER (WHERE status = 'failed')::int AS failed,
               count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
        FROM bookings
        WHERE organization_id = ${organization.id}
          AND created_at >= ${startsAt}
          AND created_at < ${now}
        GROUP BY calendar_provider
        ORDER BY calendar_provider
      `,
      this.sql`
        SELECT b.id, b.attendee_name, b.attendee_email,
               mt.title AS meeting_title, r.name AS rep_name,
               b.calendar_provider, b.status, b.attendance_outcome,
               b.starts_at, b.ends_at,
               CASE
                 WHEN b.router_session_id IS NOT NULL THEN 'smart_router'
                 WHEN b.routing_decision_id IS NOT NULL THEN 'routing_api'
                 ELSE 'scheduling_link'
               END AS source
        FROM bookings b
        JOIN meeting_types mt ON mt.id = b.meeting_type_id
        JOIN reps r ON r.id = b.rep_id
        WHERE b.organization_id = ${organization.id}
          AND b.created_at >= ${startsAt}
          AND b.created_at < ${now}
        ORDER BY b.created_at DESC
        LIMIT 30
      `,
    ]);

    const submissions = Number(funnelRow?.submissions ?? 0);
    const qualified = Number(funnelRow?.qualified ?? 0);
    const bookings = Number(funnelRow?.bookings ?? 0);
    const deliveriesByProvider = new Map(
      deliveryRows.map((row) => [String(row.provider), row]),
    );

    return {
      rangeDays,
      startsAt: startsAt.toISOString(),
      generatedAt: now.toISOString(),
      funnel: {
        submissions,
        qualified,
        noMatch: Number(funnelRow?.noMatch ?? 0),
        bookings,
        conversionRate: reportPercentage(bookings, submissions),
      },
      bookingHealth: {
        total: Number(bookingHealthRow?.total ?? 0),
        confirmed: Number(bookingHealthRow?.confirmed ?? 0),
        inProgress: Number(bookingHealthRow?.inProgress ?? 0),
        cancelled: Number(bookingHealthRow?.cancelled ?? 0),
        failed: Number(bookingHealthRow?.failed ?? 0),
        noShows: Number(bookingHealthRow?.noShows ?? 0),
      },
      routerLinks: routerRows.map((row) => {
        const routerSubmissions = Number(row.submissions ?? 0);
        const routerBookings = Number(row.bookings ?? 0);
        return {
          id: String(row.id),
          name: String(row.name),
          active: Boolean(row.active),
          submissions: routerSubmissions,
          qualified: Number(row.qualified ?? 0),
          bookings: routerBookings,
          conversionRate: reportPercentage(routerBookings, routerSubmissions),
          lastActivityAt: row.lastActivityAt
            ? new Date(String(row.lastActivityAt)).toISOString()
            : null,
        };
      }),
      reps: repRows.map((row) => {
        const routes = Number(row.routes ?? 0);
        return {
          id: String(row.id),
          name: String(row.name),
          active: Boolean(row.active),
          routes,
          routeShare: reportPercentage(routes, Number(row.totalRoutes ?? 0)),
          meetings: Number(row.meetings ?? 0),
          confirmed: Number(row.confirmed ?? 0),
          cancelled: Number(row.cancelled ?? 0),
          noShows: Number(row.noShows ?? 0),
        };
      }),
      calendarDelivery: (["google", "microsoft"] as const).map((provider) => {
        const row = deliveriesByProvider.get(provider);
        return {
          provider,
          total: Number(row?.total ?? 0),
          confirmed: Number(row?.confirmed ?? 0),
          inProgress: Number(row?.inProgress ?? 0),
          failed: Number(row?.failed ?? 0),
          cancelled: Number(row?.cancelled ?? 0),
        };
      }),
      recentMeetings: recentMeetingRows.map((row) => ({
        id: String(row.id),
        attendeeName: String(row.attendeeName),
        attendeeEmail: String(row.attendeeEmail),
        meetingTitle: String(row.meetingTitle),
        repName: String(row.repName),
        calendarProvider: row.calendarProvider as CalendarOAuthProvider,
        status:
          row.status as ReportingSnapshot["recentMeetings"][number]["status"],
        attendanceOutcome: row.attendanceOutcome as BookingAttendanceOutcome,
        startsAt: new Date(String(row.startsAt)).toISOString(),
        endsAt: new Date(String(row.endsAt)).toISOString(),
        source:
          row.source as ReportingSnapshot["recentMeetings"][number]["source"],
      })),
    };
  }

  async recordBookingAttendance(input: {
    organizationSlug: string;
    bookingId: string;
    outcome: BookingAttendanceOutcome;
    now?: Date;
  }): Promise<boolean> {
    if (
      !uuidPattern.test(input.bookingId) ||
      !["unknown", "attended", "no_show"].includes(input.outcome)
    ) {
      return false;
    }
    const now = input.now ?? new Date();
    if (!Number.isFinite(now.getTime())) return false;
    const [updated] = await this.sql`
      UPDATE bookings b
      SET attendance_outcome = ${input.outcome},
          attendance_recorded_at = CASE
            WHEN ${input.outcome} = 'unknown' THEN NULL
            ELSE ${now}
          END,
          updated_at = now()
      FROM organizations o
      WHERE b.organization_id = o.id
        AND o.slug = ${input.organizationSlug}
        AND b.id = ${input.bookingId}
        AND b.status = 'confirmed'
        AND b.ends_at <= ${now}
      RETURNING b.id
    `;
    return Boolean(updated);
  }

  async saveRoutingRep(input: SaveRoutingRep): Promise<string> {
    const defaultAvailability = {
      monday: [{ start: "09:00", end: "17:00" }],
      tuesday: [{ start: "09:00", end: "17:00" }],
      wednesday: [{ start: "09:00", end: "17:00" }],
      thursday: [{ start: "09:00", end: "17:00" }],
      friday: [{ start: "09:00", end: "17:00" }],
    };

    return this.sql.begin(async (transaction) => {
      const [organization] = await transaction`
        SELECT id FROM organizations WHERE slug = ${input.organizationSlug}
      `;
      if (!organization) {
        throw new Error(`Unknown organization: ${input.organizationSlug}`);
      }

      let repId: string;
      let previousSchedulingSlug: string | null = null;
      if (input.id) {
        const [existing] = await transaction`
          SELECT scheduling_slug
          FROM reps
          WHERE id = ${input.id} AND organization_id = ${organization.id}
        `;
        if (!existing) throw new Error("Representative not found.");
        previousSchedulingSlug = String(existing.schedulingSlug);
        const [updated] = await transaction`
          UPDATE reps
          SET name = ${input.name}, email = ${input.email},
              timezone = ${input.timezone}, weight = ${input.weight},
              active = ${input.active}, scheduling_slug = ${input.schedulingSlug}
          WHERE id = ${input.id} AND organization_id = ${organization.id}
          RETURNING id
        `;
        repId = String(updated!.id);
      } else {
        const [created] = await transaction`
          INSERT INTO reps (
            organization_id, name, email, timezone, weight, active,
            availability, scheduling_slug
          ) VALUES (
            ${organization.id}, ${input.name}, ${input.email}, ${input.timezone},
            ${input.weight}, ${input.active},
            ${transaction.json(defaultAvailability)}, ${input.schedulingSlug}
          )
          RETURNING id
        `;
        repId = String(created!.id);
      }

      const [slugTarget] = await transaction`
        SELECT id, rep_id, pool_id
        FROM meeting_types
        WHERE organization_id = ${organization.id}
          AND slug = ${input.schedulingSlug}
      `;
      if (slugTarget && String(slugTarget.repId ?? "") !== repId) {
        throw new Error("That scheduling-link slug is already in use.");
      }

      if (!slugTarget) {
        const [previousDefault] = previousSchedulingSlug
          ? await transaction`
              SELECT id
              FROM meeting_types
              WHERE organization_id = ${organization.id}
                AND rep_id = ${repId}
                AND slug = ${previousSchedulingSlug}
            `
          : [];
        if (previousDefault) {
          await transaction`
            UPDATE meeting_types
            SET slug = ${input.schedulingSlug}, updated_at = now()
            WHERE id = ${previousDefault.id}
          `;
        } else {
          await transaction`
            INSERT INTO meeting_types (
              organization_id, rep_id, slug, title, description,
              duration_minutes, minimum_notice_minutes, booking_window_days,
              conference_provider, reminder_minutes, active
            ) VALUES (
              ${organization.id}, ${repId}, ${input.schedulingSlug},
              ${`${input.name} introduction`},
              'Pick a time that works for you.', 30, 60, 14, 'none', 1440, true
            )
          `;
        }
      }

      return repId;
    });
  }

  async saveRoutingPool(input: SaveRoutingPool): Promise<string> {
    return this.sql.begin(async (transaction) => {
      const [organization] = await transaction`
        SELECT id FROM organizations WHERE slug = ${input.organizationSlug}
      `;
      if (!organization) {
        throw new Error(`Unknown organization: ${input.organizationSlug}`);
      }

      const members = await transaction`
        SELECT id FROM reps
        WHERE organization_id = ${organization.id}
          AND id = ANY(${input.memberIds}::uuid[])
      `;
      if (members.length !== input.memberIds.length) {
        throw new Error("Every pool member must belong to this workspace.");
      }

      let poolId: string;
      if (input.id) {
        const [updated] = await transaction`
          UPDATE routing_pools
          SET name = ${input.name}, slug = ${input.slug}
          WHERE id = ${input.id} AND organization_id = ${organization.id}
          RETURNING id
        `;
        if (!updated) throw new Error("Routing pool not found.");
        poolId = String(updated.id);
      } else {
        const [created] = await transaction`
          INSERT INTO routing_pools (organization_id, name, slug)
          VALUES (${organization.id}, ${input.name}, ${input.slug})
          RETURNING id
        `;
        poolId = String(created!.id);
      }

      await transaction`
        DELETE FROM routing_pool_members
        WHERE pool_id = ${poolId}
          AND NOT (rep_id = ANY(${input.memberIds}::uuid[]))
      `;
      await transaction`
        INSERT INTO routing_pool_members (pool_id, rep_id)
        SELECT ${poolId}::uuid, member_id
        FROM unnest(${input.memberIds}::uuid[]) AS member_id
        ON CONFLICT DO NOTHING
      `;
      await transaction`
        INSERT INTO assignment_state (pool_id, rep_id)
        SELECT ${poolId}::uuid, member_id
        FROM unnest(${input.memberIds}::uuid[]) AS member_id
        ON CONFLICT DO NOTHING
      `;
      return poolId;
    });
  }

  async saveRoutingRule(input: SaveRoutingRule): Promise<string> {
    return this.sql.begin(async (transaction) => {
      const [organization] = await transaction`
        SELECT id FROM organizations WHERE slug = ${input.organizationSlug}
      `;
      if (!organization) {
        throw new Error(`Unknown organization: ${input.organizationSlug}`);
      }
      const [pool] = await transaction`
        SELECT id FROM routing_pools
        WHERE id = ${input.poolId} AND organization_id = ${organization.id}
      `;
      if (!pool) throw new Error("Routing pool not found.");

      if (input.id) {
        const [updated] = await transaction`
          UPDATE routing_rules
          SET name = ${input.name}, priority = ${input.priority},
              conditions = ${transaction.json(input.conditions as JSONValue)},
              pool_id = ${input.poolId}, active = ${input.active}
          WHERE id = ${input.id} AND organization_id = ${organization.id}
          RETURNING id
        `;
        if (!updated) throw new Error("Routing rule not found.");
        return String(updated.id);
      }

      const [created] = await transaction`
        INSERT INTO routing_rules (
          organization_id, name, priority, conditions, pool_id, active
        ) VALUES (
          ${organization.id}, ${input.name}, ${input.priority},
          ${transaction.json(input.conditions as JSONValue)}, ${input.poolId},
          ${input.active}
        )
        RETURNING id
      `;
      return String(created!.id);
    });
  }

  async saveRouterLink(input: SaveRouterLink): Promise<string> {
    const questions = normalizeRouterQuestions(input.questions);
    const name = input.name.trim();
    const slug = input.slug.trim();
    const title = input.title.trim();
    const description = input.description.trim();
    const buttonLabel = input.buttonLabel.trim();
    const noMatchMessage = input.noMatchMessage.trim();
    const redirectUrlProvided = input.successRedirectUrl !== undefined;
    const successRedirectUrl = normalizeRouterSuccessRedirect(
      input.successRedirectUrl,
    );
    const redirectDelayProvided =
      input.successRedirectDelaySeconds !== undefined;
    const successRedirectDelaySeconds = input.successRedirectDelaySeconds ?? 5;
    const accentColor = input.accentColor.trim();
    if (name.length < 2 || name.length > 120) {
      throw new RouterLinkValidationError(
        "Smart Link names must be 2–120 characters.",
      );
    }
    if (slug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new RouterLinkValidationError("Enter a valid Smart Link slug.");
    }
    if (title.length < 2 || title.length > 160 || description.length > 1_000) {
      throw new RouterLinkValidationError(
        "Check the Smart Link title and description.",
      );
    }
    if (buttonLabel.length < 2 || buttonLabel.length > 80) {
      throw new RouterLinkValidationError(
        "Button labels must be 2–80 characters.",
      );
    }
    if (noMatchMessage.length < 2 || noMatchMessage.length > 500) {
      throw new RouterLinkValidationError(
        "No-match messages must be 2–500 characters.",
      );
    }
    if (!/^#[0-9A-Fa-f]{6}$/.test(accentColor)) {
      throw new RouterLinkValidationError(
        "Accent colors must use a six-digit hex value.",
      );
    }
    if (
      !Number.isInteger(successRedirectDelaySeconds) ||
      successRedirectDelaySeconds < 1 ||
      successRedirectDelaySeconds > 30
    ) {
      throw new RouterLinkValidationError(
        "Post-booking redirect delays must be 1–30 seconds.",
      );
    }
    const destinationPools = input.destinations.map(
      (destination) => destination.poolId,
    );
    if (new Set(destinationPools).size !== destinationPools.length) {
      throw new RouterLinkValidationError(
        "Each routing pool can have one Smart Link destination.",
      );
    }

    return this.sql.begin(async (transaction) => {
      const [organization] = await transaction`
        SELECT id FROM organizations WHERE slug = ${input.organizationSlug}
      `;
      if (!organization) {
        throw new Error(`Unknown organization: ${input.organizationSlug}`);
      }
      const activeRuleRows = await transaction`
        SELECT id, name, priority, conditions, pool_id
        FROM routing_rules
        WHERE organization_id = ${organization.id} AND active = true
        ORDER BY priority, id
      `;
      const activeRules: Rule[] = activeRuleRows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        priority: Number(row.priority),
        conditions: row.conditions as Rule["conditions"],
        poolId: String(row.poolId),
      }));
      for (const destination of input.destinations) {
        const [valid] = await transaction`
          SELECT mt.id,
            EXISTS (
              SELECT 1
              FROM routing_pool_members rpm
              JOIN reps r ON r.id = rpm.rep_id
              JOIN rep_calendar_connections c
                ON c.rep_id = r.id AND c.provider = r.active_calendar_provider
              WHERE rpm.pool_id = mt.pool_id
                AND r.organization_id = mt.organization_id
                AND r.active = true
                AND c.external_account_id IS NOT NULL
                AND length(c.external_account_id) BETWEEN 1 AND 1024
                AND c.external_account_id !~ '[[:cntrl:]]'
                AND (
                  mt.conference_provider IN ('none', 'zoom')
                  OR (mt.conference_provider = 'google_meet' AND c.provider = 'google')
                  OR (mt.conference_provider = 'microsoft_teams' AND c.provider = 'microsoft')
                )
            ) AS has_ready_rep
          FROM meeting_types mt
          JOIN routing_pools rp ON rp.id = mt.pool_id
          WHERE mt.id = ${destination.meetingTypeId}
            AND mt.pool_id = ${destination.poolId}
            AND mt.organization_id = ${organization.id}
            AND rp.organization_id = ${organization.id}
            AND mt.active = true
        `;
        if (!valid) {
          throw new RouterLinkValidationError(
            "Every destination must use an active pool meeting type from this workspace.",
          );
        }
        if (input.active && !valid.hasReadyRep) {
          throw new RouterLinkValidationError(
            "Every published destination needs an active member with a compatible calendar.",
          );
        }
      }

      if (input.active) {
        if (activeRules.length === 0) {
          throw new RouterLinkValidationError(
            "Publish at least one active routing rule first.",
          );
        }
        const fieldKinds = routingFieldKinds(activeRules);
        validateQuestionKinds(questions, fieldKinds);
        const builtInFields = new Set(["email", "name"]);
        const questionFields = new Set(
          questions.map((question) => question.field),
        );
        const missingQuestion = [
          ...routerFieldsRequiringQuestions(activeRules),
        ].find(
          (field) => !builtInFields.has(field) && !questionFields.has(field),
        );
        if (missingQuestion) {
          throw new RouterLinkValidationError(
            `Add a question for routing field ${missingQuestion}.`,
          );
        }
        const destinationSet = new Set(destinationPools);
        const missingPool = activeRules.find(
          (rule) => !destinationSet.has(rule.poolId),
        );
        if (missingPool) {
          throw new RouterLinkValidationError(
            `Add a meeting destination for ${missingPool.name}.`,
          );
        }
      }

      let routerLinkId: string;
      if (input.id) {
        const [updated] = await transaction`
          UPDATE router_links
          SET name = ${name}, slug = ${slug}, title = ${title},
              description = ${description}, button_label = ${buttonLabel},
              no_match_message = ${noMatchMessage}, accent_color = ${accentColor},
              success_redirect_url = CASE
                WHEN ${redirectUrlProvided} THEN ${successRedirectUrl}
                ELSE success_redirect_url
              END,
              success_redirect_delay_seconds = CASE
                WHEN ${redirectDelayProvided} THEN ${successRedirectDelaySeconds}
                ELSE success_redirect_delay_seconds
              END,
              questions = ${transaction.json(questions as JSONValue)},
              active = ${input.active}, config_version = config_version + 1,
              updated_at = now()
          WHERE id = ${input.id} AND organization_id = ${organization.id}
          RETURNING id
        `;
        if (!updated)
          throw new RouterLinkValidationError("Smart Link not found.");
        routerLinkId = String(updated.id);
      } else {
        const [created] = await transaction`
          INSERT INTO router_links (
            organization_id, name, slug, title, description, button_label,
            no_match_message, success_redirect_url,
            success_redirect_delay_seconds, accent_color, questions, active
          ) VALUES (
            ${organization.id}, ${name}, ${slug}, ${title}, ${description},
            ${buttonLabel}, ${noMatchMessage}, ${successRedirectUrl},
            ${successRedirectDelaySeconds}, ${accentColor},
            ${transaction.json(questions as JSONValue)}, ${input.active}
          )
          RETURNING id
        `;
        routerLinkId = String(created!.id);
      }

      await transaction`
        DELETE FROM router_link_destinations WHERE router_link_id = ${routerLinkId}
      `;
      for (const destination of input.destinations) {
        await transaction`
          INSERT INTO router_link_destinations (
            router_link_id, pool_id, meeting_type_id
          ) VALUES (
            ${routerLinkId}, ${destination.poolId}, ${destination.meetingTypeId}
          )
        `;
      }
      return routerLinkId;
    });
  }

  async saveRouterFormBridge(input: SaveRouterFormBridge): Promise<string> {
    const normalized = normalizeRouterFormBridge(input);
    if (input.id && !uuidPattern.test(input.id)) {
      throw new RouterFormBridgeValidationError("Form bridge not found.");
    }

    return this.sql.begin(async (transaction) => {
      const [routerLink] = await transaction`
        SELECT rl.id, rl.questions, rl.config_version
        FROM router_links rl
        JOIN organizations o ON o.id = rl.organization_id
        WHERE o.slug = ${input.organizationSlug}
          AND rl.id = ${input.routerLinkId}
        FOR SHARE OF rl
      `;
      if (!routerLink) {
        throw new RouterFormBridgeValidationError(
          "Smart Router Link not found.",
        );
      }

      const questionFields = (routerLink.questions as RouterLinkQuestion[]).map(
        (question) => question.field,
      );
      const mappingFields = Object.keys(normalized.answerMappings);
      if (
        questionFields.length !== mappingFields.length ||
        questionFields.some((field) => !mappingFields.includes(field))
      ) {
        throw new RouterFormBridgeValidationError(
          "Map every current Smart Link question exactly once.",
        );
      }

      const [organization] = await transaction`
        SELECT id FROM organizations WHERE slug = ${input.organizationSlug}
      `;
      if (!organization) {
        throw new Error(`Unknown organization: ${input.organizationSlug}`);
      }

      const values = {
        allowedOrigins: transaction.json(
          normalized.allowedOrigins as JSONValue,
        ),
        attendeeNameFields: transaction.json(
          normalized.attendeeNameFields as JSONValue,
        ),
        answerMappings: transaction.json(
          normalized.answerMappings as JSONValue,
        ),
      };

      if (input.id) {
        const [updated] = await transaction`
          UPDATE router_form_bridges
          SET router_link_id = ${input.routerLinkId},
              name = ${normalized.name}, provider = ${normalized.provider},
              form_id = ${normalized.formId},
              allowed_origins = ${values.allowedOrigins},
              attendee_name_fields = ${values.attendeeNameFields},
              attendee_email_field = ${normalized.attendeeEmailField},
              answer_mappings = ${values.answerMappings},
              active = ${normalized.active},
              link_config_version = ${Number(routerLink.configVersion)},
              updated_at = now()
          WHERE id = ${input.id}
            AND organization_id = ${organization.id}
          RETURNING id
        `;
        if (!updated) {
          throw new RouterFormBridgeValidationError("Form bridge not found.");
        }
        return String(updated.id);
      }

      const [created] = await transaction`
        INSERT INTO router_form_bridges (
          organization_id, router_link_id, name, provider, form_id,
          allowed_origins, attendee_name_fields, attendee_email_field,
          answer_mappings, active, link_config_version
        ) VALUES (
          ${organization.id}, ${input.routerLinkId}, ${normalized.name},
          ${normalized.provider}, ${normalized.formId}, ${values.allowedOrigins},
          ${values.attendeeNameFields}, ${normalized.attendeeEmailField},
          ${values.answerMappings}, ${normalized.active},
          ${Number(routerLink.configVersion)}
        )
        RETURNING id
      `;
      return String(created!.id);
    });
  }

  async deleteRouterFormBridge(
    organizationSlug: string,
    bridgeId: string,
  ): Promise<boolean> {
    if (!uuidPattern.test(bridgeId)) return false;
    const [deleted] = await this.sql`
      DELETE FROM router_form_bridges rfb
      USING organizations o
      WHERE rfb.id = ${bridgeId}
        AND rfb.organization_id = o.id
        AND o.slug = ${organizationSlug}
      RETURNING rfb.id
    `;
    return Boolean(deleted);
  }

  async publicRouterFormBridge(
    bridgeId: string,
  ): Promise<PublicRouterFormBridgeConfig | null> {
    if (!uuidPattern.test(bridgeId)) return null;
    const [row] = await this.sql`
      SELECT o.slug AS organization_slug, rl.slug AS router_link_slug,
             rfb.provider, rfb.form_id, rfb.allowed_origins,
             rfb.attendee_name_fields, rfb.attendee_email_field,
             rfb.answer_mappings
      FROM router_form_bridges rfb
      JOIN organizations o ON o.id = rfb.organization_id
      JOIN router_links rl
        ON rl.id = rfb.router_link_id
       AND rl.organization_id = rfb.organization_id
      WHERE rfb.id = ${bridgeId}
        AND rfb.active = true
        AND rl.active = true
        AND rfb.link_config_version = rl.config_version
    `;
    if (!row) return null;
    return {
      routerPath: `/r/${encodeURIComponent(String(row.organizationSlug))}/${encodeURIComponent(String(row.routerLinkSlug))}`,
      provider: row.provider as PublicRouterFormBridgeConfig["provider"],
      formId: row.formId ? String(row.formId) : null,
      allowedOrigins: row.allowedOrigins as string[],
      mapping: {
        attendeeNameFields: row.attendeeNameFields as string[],
        attendeeEmailField: String(row.attendeeEmailField),
        answerMappings: row.answerMappings as Record<string, string>,
      },
    };
  }

  async publicRouterLink(
    organizationSlug: string,
    routerSlug: string,
  ): Promise<PublicRouterLink | null> {
    const [row] = await this.sql`
      SELECT o.name AS organization_name, o.slug AS organization_slug,
             rl.id, rl.slug, rl.title, rl.description, rl.button_label,
             rl.no_match_message, rl.success_redirect_url,
             rl.success_redirect_delay_seconds, rl.accent_color, rl.questions
      FROM router_links rl
      JOIN organizations o ON o.id = rl.organization_id
      WHERE o.slug = ${organizationSlug} AND rl.slug = ${routerSlug}
        AND rl.active = true
    `;
    return row
      ? {
          organizationName: String(row.organizationName),
          organizationSlug: String(row.organizationSlug),
          id: String(row.id),
          slug: String(row.slug),
          title: String(row.title),
          description: String(row.description),
          buttonLabel: String(row.buttonLabel),
          noMatchMessage: String(row.noMatchMessage),
          successRedirectUrl: row.successRedirectUrl
            ? String(row.successRedirectUrl)
            : null,
          successRedirectDelaySeconds: Number(row.successRedirectDelaySeconds),
          accentColor: String(row.accentColor),
          questions: row.questions as RouterLinkQuestion[],
        }
      : null;
  }

  async recoverableRouterLinkIdentity(
    organizationSlug: string,
    historicalSlug: string,
  ): Promise<{
    id: string;
    organizationName: string;
    organizationSlug: string;
    slug: string;
    active: boolean;
  } | null> {
    const [row] = await this.sql`
      SELECT rl.id, rl.slug, rl.active,
             o.name AS organization_name, o.slug AS organization_slug
      FROM router_link_slug_aliases alias
      JOIN organizations o ON o.id = alias.organization_id
      JOIN router_links rl
        ON rl.id = alias.router_link_id
       AND rl.organization_id = alias.organization_id
      WHERE o.slug = ${organizationSlug} AND alias.slug = ${historicalSlug}
    `;
    return row
      ? {
          id: String(row.id),
          organizationName: String(row.organizationName),
          organizationSlug: String(row.organizationSlug),
          slug: String(row.slug),
          active: Boolean(row.active),
        }
      : null;
  }

  async consumePublicRateLimit(
    input: PublicRateLimitRequest,
  ): Promise<PublicRateLimitResult> {
    if (
      !/^[a-z0-9_.:-]{1,80}$/i.test(input.scope) ||
      input.identifier.length < 1 ||
      input.identifier.length > 500 ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 10_000 ||
      !Number.isInteger(input.windowSeconds) ||
      input.windowSeconds < 1 ||
      input.windowSeconds > 86_400
    ) {
      throw new RouterLinkValidationError("Invalid public rate-limit input.");
    }
    const [organization] = await this.sql`
      SELECT id FROM organizations WHERE slug = ${input.organizationSlug}
    `;
    if (!organization) {
      throw new Error(`Unknown organization: ${input.organizationSlug}`);
    }
    const now = input.now ?? new Date();
    const windowMs = input.windowSeconds * 1_000;
    const windowStartedAt = new Date(
      Math.floor(now.getTime() / windowMs) * windowMs,
    );
    const windowEndsAt = new Date(windowStartedAt.getTime() + windowMs);
    const keyHash = tokenHash(
      `${String(organization.id)}\u0000${input.scope}\u0000${input.identifier}`,
    );
    const [bucket] = await this.sql`
      INSERT INTO public_rate_limit_buckets (
        organization_id, scope, key_hash, window_started_at, window_ends_at
      ) VALUES (
        ${organization.id}, ${input.scope}, ${keyHash},
        ${windowStartedAt}, ${windowEndsAt}
      )
      ON CONFLICT (organization_id, scope, key_hash, window_started_at)
      DO UPDATE SET requests = public_rate_limit_buckets.requests + 1
      RETURNING requests
    `;
    const requests = Number(bucket!.requests);
    return {
      allowed: requests <= input.limit,
      remaining: Math.max(input.limit - requests, 0),
      resetAt: windowEndsAt.toISOString(),
    };
  }

  async cleanupExpiredPublicRouterData(now = new Date()): Promise<{
    deletedSessions: number;
    redactedSessions: number;
    deletedRateBuckets: number;
    deletedRepOAuthAttempts: number;
  }> {
    const bookedRedactionBefore = new Date(now.getTime() - 24 * 60 * 60_000);
    return this.sql.begin(async (transaction) => {
      const [deletedSessions] = await transaction`
        WITH deleted AS (
          DELETE FROM router_qualification_sessions s
          WHERE s.booked_at IS NULL
            AND s.expires_at <= ${now}
            AND NOT EXISTS (
              SELECT 1 FROM bookings b WHERE b.router_session_id = s.id
            )
          RETURNING 1
        )
        SELECT count(*)::int AS count FROM deleted
      `;
      const [redactedSessions] = await transaction`
        WITH redacted AS (
          UPDATE router_qualification_sessions
          SET attendee_name = 'Redacted',
              attendee_email = 'redacted@invalid.local',
              lead = ${transaction.json({
                name: "Redacted",
                email: "redacted@invalid.local",
              })},
              request_hash = repeat('0', 64),
              redacted_at = ${now}
          WHERE booked_at <= ${bookedRedactionBefore}
            AND redacted_at IS NULL
          RETURNING 1
        )
        SELECT count(*)::int AS count FROM redacted
      `;
      const [deletedRateBuckets] = await transaction`
        WITH deleted AS (
          DELETE FROM public_rate_limit_buckets
          WHERE window_ends_at <= ${now}
          RETURNING 1
        )
        SELECT count(*)::int AS count FROM deleted
      `;
      const [deletedRepOAuthAttempts] = await transaction`
        WITH deleted AS (
          DELETE FROM rep_calendar_oauth_attempts
          WHERE expires_at <= ${now}
             OR used_at <= ${new Date(now.getTime() - 24 * 60 * 60_000)}
          RETURNING 1
        )
        SELECT count(*)::int AS count FROM deleted
      `;
      return {
        deletedSessions: Number(deletedSessions!.count),
        redactedSessions: Number(redactedSessions!.count),
        deletedRateBuckets: Number(deletedRateBuckets!.count),
        deletedRepOAuthAttempts: Number(deletedRepOAuthAttempts!.count),
      };
    });
  }

  async qualifyRouterLink(
    input: QualifyRouterLinkRequest,
  ): Promise<RouterLinkQualification> {
    if (input.sessionToken.length < 16 || input.sessionToken.length > 200) {
      throw new RouterLinkValidationError("Invalid routing session token.");
    }
    const expiresInMinutes = input.expiresInMinutes ?? 30;
    if (
      !Number.isInteger(expiresInMinutes) ||
      expiresInMinutes < 1 ||
      expiresInMinutes > 1_440
    ) {
      throw new RouterLinkValidationError("Invalid routing session lifetime.");
    }
    const now = input.now ?? new Date();
    const sessionTokenHash = tokenHash(input.sessionToken);

    return this.sql.begin(async (transaction) => {
      const [routerLink] = await transaction`
        SELECT o.id AS organization_id, rl.id AS router_link_id,
               rl.config_version, rl.questions, rl.no_match_message
        FROM router_links rl
        JOIN organizations o ON o.id = rl.organization_id
        WHERE o.slug = ${input.organizationSlug} AND rl.slug = ${input.routerSlug}
          AND rl.active = true
      `;
      if (!routerLink) throw new RouterLinkNotFoundError();

      const ruleRows = await transaction`
        SELECT id, name, priority, conditions, pool_id
        FROM routing_rules
        WHERE organization_id = ${routerLink.organizationId} AND active = true
        ORDER BY priority, id
      `;
      const rules: Rule[] = ruleRows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        priority: Number(row.priority),
        conditions: row.conditions as Rule["conditions"],
        poolId: String(row.poolId),
      }));
      const questions = normalizeRouterQuestions(
        routerLink.questions as RouterLinkQuestion[],
      );
      const fieldKinds = routingFieldKinds(rules);
      validateQuestionKinds(questions, fieldKinds);
      const questionFields = new Set(
        questions.map((question) => question.field),
      );
      const missingQuestion = [...routerFieldsRequiringQuestions(rules)].find(
        (field) =>
          field !== "email" && field !== "name" && !questionFields.has(field),
      );
      if (missingQuestion) {
        throw new RouterLinkConflictError(
          "This Smart Link must be republished after its routing rules changed.",
        );
      }
      const normalized = leadFromRouterAnswers({
        attendeeName: input.attendeeName,
        attendeeEmail: input.attendeeEmail,
        answers: input.answers,
        questions,
        fieldKinds,
      });
      const currentOwnerEmail = normalizedCurrentOwnerEmail(
        input.currentOwnerEmail,
      );
      if (currentOwnerEmail) {
        normalized.lead.current_owner_email = currentOwnerEmail;
      }
      const normalizedRequestHash = requestHash(normalized);

      await transaction`
        SELECT pg_advisory_xact_lock(
          hashtext(${`router-session:${sessionTokenHash}`})
        )
      `;
      const [existing] = await transaction`
        SELECT s.request_hash, s.outcome, s.expires_at,
               s.link_config_version, s.router_link_id, s.organization_id,
               rr.name AS matched_rule_name, rp.name AS pool_name,
               mt.slug AS meeting_type_slug, mt.title AS meeting_type_title,
               mt.description AS meeting_type_description,
               mt.duration_minutes, mt.minimum_notice_minutes,
               mt.booking_window_days, mt.conference_provider,
               mt.reminder_minutes
        FROM router_qualification_sessions s
        LEFT JOIN meeting_types mt ON mt.id = s.meeting_type_id
        LEFT JOIN routing_rules rr ON rr.id = s.matched_rule_id
        LEFT JOIN routing_pools rp ON rp.id = s.pool_id
        WHERE s.token_hash = ${sessionTokenHash}
      `;
      if (existing) {
        if (
          String(existing.routerLinkId) !== String(routerLink.routerLinkId) ||
          String(existing.organizationId) !==
            String(routerLink.organizationId) ||
          String(existing.requestHash) !== normalizedRequestHash
        ) {
          throw new RouterLinkConflictError(
            "This routing session token was already used for another submission.",
          );
        }
        if (
          Number(existing.linkConfigVersion) !==
          Number(routerLink.configVersion)
        ) {
          throw new RouterLinkSessionExpiredError();
        }
        if (new Date(String(existing.expiresAt)).getTime() <= now.getTime()) {
          throw new RouterLinkSessionExpiredError();
        }
        const outcome = existing.outcome as RouterLinkQualification["outcome"];
        return {
          outcome,
          sessionToken: input.sessionToken,
          expiresAt: new Date(String(existing.expiresAt)).toISOString(),
          noMatchMessage: String(routerLink.noMatchMessage),
          matchedRuleName:
            outcome === "matched" && existing.matchedRuleName
              ? String(existing.matchedRuleName)
              : null,
          poolName:
            outcome === "matched" && existing.poolName
              ? String(existing.poolName)
              : null,
          meetingType:
            outcome === "matched" ? meetingTypeFromRow(existing) : null,
        };
      }

      const matchedRule = findMatchingRule(normalized.lead, rules);
      const destination = matchedRule
        ? (
            await transaction`
              SELECT mt.id AS meeting_type_id, mt.slug AS meeting_type_slug,
                     mt.title AS meeting_type_title,
                     mt.description AS meeting_type_description,
                     mt.duration_minutes, mt.minimum_notice_minutes,
                     mt.booking_window_days, mt.conference_provider,
                     mt.reminder_minutes, rp.name AS pool_name
              FROM router_link_destinations rld
              JOIN meeting_types mt ON mt.id = rld.meeting_type_id
              JOIN routing_pools rp ON rp.id = rld.pool_id
              WHERE rld.router_link_id = ${routerLink.routerLinkId}
                AND rld.pool_id = ${matchedRule.poolId}
                AND mt.pool_id = rld.pool_id
                AND mt.organization_id = ${routerLink.organizationId}
                AND mt.active = true
            `
          )[0]
        : null;
      if (matchedRule && !destination) {
        throw new RouterLinkConflictError(
          "This Smart Link must be republished with a meeting destination.",
        );
      }
      const outcome = matchedRule ? "matched" : "no_match";
      const expiresAt = new Date(now.getTime() + expiresInMinutes * 60_000);
      const [createdSession] = await transaction`
        INSERT INTO router_qualification_sessions (
          organization_id, router_link_id, token_hash, request_hash,
          attendee_name, attendee_email, lead, link_config_version, outcome,
          matched_rule_id, pool_id, meeting_type_id, expires_at, created_at
        ) VALUES (
          ${routerLink.organizationId}, ${routerLink.routerLinkId},
          ${sessionTokenHash}, ${normalizedRequestHash}, ${normalized.attendeeName},
          ${normalized.attendeeEmail},
          ${transaction.json(normalized.lead as JSONValue)},
          ${routerLink.configVersion}, ${outcome}, ${matchedRule?.id ?? null},
          ${matchedRule?.poolId ?? null}, ${destination?.meetingTypeId ?? null},
          ${expiresAt}, ${now}
        )
        RETURNING id
      `;
      await transaction`
        INSERT INTO router_funnel_events (
          session_id, organization_id, router_link_id, outcome, submitted_at
        ) VALUES (
          ${createdSession!.id}, ${routerLink.organizationId},
          ${routerLink.routerLinkId}, ${outcome}, ${now}
        )
      `;
      return {
        outcome,
        sessionToken: input.sessionToken,
        expiresAt: expiresAt.toISOString(),
        noMatchMessage: String(routerLink.noMatchMessage),
        matchedRuleName: matchedRule?.name ?? null,
        poolName: outcome === "matched" ? String(destination!.poolName) : null,
        meetingType:
          outcome === "matched" ? meetingTypeFromRow(destination!) : null,
      };
    });
  }

  async routerLinkSession(
    organizationSlug: string,
    routerSlug: string,
    sessionToken: string,
    now = new Date(),
  ): Promise<RouterLinkSession | null> {
    if (sessionToken.length < 16 || sessionToken.length > 200) return null;
    const [session] = await this.sql`
      SELECT s.organization_id, s.attendee_name, s.attendee_email, s.lead,
             s.expires_at,
             s.outcome, s.booked_at, s.link_config_version,
             s.matched_rule_id, s.pool_id, s.meeting_type_id,
             rl.active AS link_active, rl.config_version,
             o.slug AS organization_slug, rl.slug AS router_slug,
             mt.slug AS meeting_type_slug,
             stored_rule.name AS matched_rule_name,
             stored_pool.name AS pool_name
      FROM router_qualification_sessions s
      JOIN organizations o ON o.id = s.organization_id
      JOIN router_links rl ON rl.id = s.router_link_id
      LEFT JOIN meeting_types mt ON mt.id = s.meeting_type_id
      LEFT JOIN routing_rules stored_rule ON stored_rule.id = s.matched_rule_id
      LEFT JOIN routing_pools stored_pool ON stored_pool.id = s.pool_id
      WHERE s.token_hash = ${tokenHash(sessionToken)}
        AND o.slug = ${organizationSlug} AND rl.slug = ${routerSlug}
    `;
    if (!session || session.outcome !== "matched") return null;
    if (
      !session.bookedAt &&
      (new Date(String(session.expiresAt)).getTime() <= now.getTime() ||
        !session.linkActive ||
        Number(session.linkConfigVersion) !== Number(session.configVersion))
    ) {
      throw new RouterLinkSessionExpiredError();
    }

    const ruleRows = await this.sql`
      SELECT id, name, priority, conditions, pool_id
      FROM routing_rules
      WHERE organization_id = ${session.organizationId} AND active = true
      ORDER BY priority, id
    `;
    const currentRule = findMatchingRule(
      session.lead as Lead,
      ruleRows.map((row) => ({
        id: String(row.id),
        name: String(row.name),
        priority: Number(row.priority),
        conditions: row.conditions as Rule["conditions"],
        poolId: String(row.poolId),
      })),
    );
    if (
      !currentRule ||
      currentRule.id !== String(session.matchedRuleId) ||
      currentRule.poolId !== String(session.poolId)
    ) {
      throw new RouterLinkSessionExpiredError();
    }
    const schedule = await this.publicSchedule(
      organizationSlug,
      String(session.meetingTypeSlug),
    );
    if (
      !schedule ||
      schedule.meetingTypeId !== String(session.meetingTypeId) ||
      schedule.targetType !== "pool"
    ) {
      throw new RouterLinkSessionExpiredError();
    }
    return {
      organizationSlug,
      routerSlug,
      sessionToken,
      attendeeName: String(session.attendeeName),
      attendeeEmail: String(session.attendeeEmail),
      lead: session.lead as Lead,
      expiresAt: new Date(String(session.expiresAt)).toISOString(),
      matchedRuleName: String(session.matchedRuleName),
      poolName: String(session.poolName),
      schedule,
    };
  }

  async routerLinkBookingStatus(
    organizationSlug: string,
    _routerSlug: string,
    sessionToken: string,
    now = new Date(),
  ): Promise<PublicBookingStatus | null> {
    if (sessionToken.length < 16 || sessionToken.length > 200) return null;
    return this.sql.begin(async (transaction) => {
      const [session] = await transaction`
        SELECT s.id
        FROM router_qualification_sessions s
        JOIN organizations o ON o.id = s.organization_id
        WHERE s.token_hash = ${tokenHash(sessionToken)}
          AND o.slug = ${organizationSlug}
        FOR UPDATE OF s
      `;
      if (!session) return null;

      const [row] = await transaction`
        SELECT b.status, b.last_error, b.external_id, b.manage_token_hash,
               b.conference_url,
               b.starts_at, b.ends_at, r.name AS rep_name,
               s.booking_attempt_starts_at, s.booking_attempt_ends_at,
               s.booking_attempt_started_at
        FROM router_qualification_sessions s
        LEFT JOIN bookings b ON b.router_session_id = s.id
        LEFT JOIN reps r ON r.id = b.rep_id
        WHERE s.id = ${session.id}
      `;
      if (!row) return null;
      if (row.status) return publicBookingStatusFromRow(row);
      if (
        row.bookingAttemptStartedAt &&
        new Date(String(row.bookingAttemptStartedAt)).getTime() >
          now.getTime() - routerBookingAttemptLeaseMs
      ) {
        return {
          status: "attempting",
          error: null,
          managePath: null,
          conferenceUrl: null,
          repName: null,
          startsAt: new Date(String(row.bookingAttemptStartsAt)).toISOString(),
          endsAt: new Date(String(row.bookingAttemptEndsAt)).toISOString(),
        };
      }
      if (row.bookingAttemptStartedAt) {
        await transaction`
          UPDATE router_qualification_sessions
          SET booking_attempt_token_hash = null,
              booking_attempt_starts_at = null,
              booking_attempt_ends_at = null,
              booking_attempt_started_at = null
          WHERE id = ${session.id}
        `;
      }
      return null;
    });
  }

  async beginRouterLinkBookingAttempt(
    input: BeginRouterLinkBookingAttemptRequest,
  ): Promise<BeginRouterLinkBookingAttemptResult> {
    if (
      input.sessionToken.length < 16 ||
      input.sessionToken.length > 200 ||
      input.attemptToken.length < 16 ||
      input.attemptToken.length > 200 ||
      !Number.isFinite(input.startsAt.getTime()) ||
      !Number.isFinite(input.endsAt.getTime()) ||
      input.endsAt <= input.startsAt
    ) {
      throw new RouterLinkValidationError("Choose a valid meeting time.");
    }
    const now = input.now ?? new Date();
    const attemptTokenHash = tokenHash(input.attemptToken);
    return this.sql.begin(async (transaction) => {
      const [session] = await transaction`
        SELECT s.id, s.outcome, s.expires_at, s.link_config_version,
               s.booking_attempt_token_hash, s.booking_attempt_starts_at,
               s.booking_attempt_ends_at, s.booking_attempt_started_at,
               rl.active AS link_active, rl.config_version,
               mt.active AS meeting_type_active, mt.duration_minutes,
               mt.minimum_notice_minutes, mt.booking_window_days
        FROM router_qualification_sessions s
        JOIN organizations o ON o.id = s.organization_id
        JOIN router_links rl ON rl.id = s.router_link_id
        LEFT JOIN meeting_types mt ON mt.id = s.meeting_type_id
        WHERE s.token_hash = ${tokenHash(input.sessionToken)}
          AND o.slug = ${input.organizationSlug}
          AND rl.slug = ${input.routerSlug}
        FOR UPDATE OF s
      `;
      if (!session) throw new RouterLinkNotFoundError();

      const [existing] = await transaction`
        SELECT b.status, b.last_error, b.external_id, b.manage_token_hash,
               b.conference_url,
               b.starts_at, b.ends_at, r.name AS rep_name
        FROM bookings b
        JOIN reps r ON r.id = b.rep_id
        WHERE b.router_session_id = ${session.id}
      `;
      if (existing) {
        return {
          acquired: false,
          booking: publicBookingStatusFromRow(existing),
        };
      }

      const durationMs = Number(session.durationMinutes) * 60_000;
      if (
        session.outcome !== "matched" ||
        new Date(String(session.expiresAt)).getTime() <= now.getTime() ||
        !session.linkActive ||
        !session.meetingTypeActive ||
        Number(session.linkConfigVersion) !== Number(session.configVersion)
      ) {
        throw new RouterLinkSessionExpiredError();
      }
      if (
        input.endsAt.getTime() - input.startsAt.getTime() !== durationMs ||
        input.startsAt.getTime() <
          now.getTime() + Number(session.minimumNoticeMinutes) * 60_000 ||
        input.endsAt.getTime() >
          now.getTime() + Number(session.bookingWindowDays) * 86_400_000
      ) {
        throw new CalendarSlotUnavailableError();
      }

      const attemptActive =
        session.bookingAttemptStartedAt &&
        new Date(String(session.bookingAttemptStartedAt)).getTime() >
          now.getTime() - routerBookingAttemptLeaseMs;
      if (attemptActive) {
        if (String(session.bookingAttemptTokenHash) === attemptTokenHash) {
          if (
            new Date(String(session.bookingAttemptStartsAt)).getTime() !==
              input.startsAt.getTime() ||
            new Date(String(session.bookingAttemptEndsAt)).getTime() !==
              input.endsAt.getTime()
          ) {
            throw new RouterLinkConflictError(
              "This booking attempt is already checking a different time.",
            );
          }
          return { acquired: true };
        }
        return {
          acquired: false,
          booking: {
            status: "attempting",
            error: null,
            managePath: null,
            conferenceUrl: null,
            repName: null,
            startsAt: new Date(
              String(session.bookingAttemptStartsAt),
            ).toISOString(),
            endsAt: new Date(
              String(session.bookingAttemptEndsAt),
            ).toISOString(),
          },
        };
      }

      await transaction`
        UPDATE router_qualification_sessions
        SET booking_attempt_token_hash = ${attemptTokenHash},
            booking_attempt_starts_at = ${input.startsAt},
            booking_attempt_ends_at = ${input.endsAt},
            booking_attempt_started_at = ${now}
        WHERE id = ${session.id}
      `;
      return { acquired: true };
    });
  }

  async releaseRouterLinkBookingAttempt(
    organizationSlug: string,
    _routerSlug: string,
    sessionToken: string,
    attemptToken: string,
  ): Promise<void> {
    if (
      sessionToken.length < 16 ||
      sessionToken.length > 200 ||
      attemptToken.length < 16 ||
      attemptToken.length > 200
    ) {
      return;
    }
    await this.sql`
      UPDATE router_qualification_sessions s
      SET booking_attempt_token_hash = null,
          booking_attempt_starts_at = null,
          booking_attempt_ends_at = null,
          booking_attempt_started_at = null
      FROM organizations o
      WHERE s.organization_id = o.id
        AND o.slug = ${organizationSlug}
        AND s.token_hash = ${tokenHash(sessionToken)}
        AND s.booking_attempt_token_hash = ${tokenHash(attemptToken)}
    `;
  }

  async routerLinkBookingRetryContext(
    organizationSlug: string,
    _routerSlug: string,
    sessionToken: string,
  ): Promise<RouterLinkBookingRetryContext | null> {
    if (sessionToken.length < 16 || sessionToken.length > 200) return null;
    const [booking] = await this.sql`
      SELECT b.status, b.rep_id, b.starts_at, b.ends_at,
             b.external_id, b.external_event_id, b.calendar_provider,
             b.calendar_external_account_id,
             current_connection.external_account_id AS current_external_account_id,
             b.meeting_type_id, mt.slug AS scheduling_slug
      FROM router_qualification_sessions s
      JOIN organizations o ON o.id = s.organization_id
      JOIN bookings b ON b.router_session_id = s.id
      JOIN meeting_types mt ON mt.id = b.meeting_type_id
      LEFT JOIN rep_calendar_connections current_connection
        ON current_connection.rep_id = b.rep_id
       AND current_connection.provider = b.calendar_provider
      WHERE s.token_hash = ${tokenHash(sessionToken)}
        AND o.slug = ${organizationSlug}
    `;
    if (!booking) return null;

    return this.routerLinkBookingRetryContextFromRow(organizationSlug, booking);
  }

  async managedRouterLinkBookingRetryContext(
    manageToken: string,
  ): Promise<RouterLinkBookingRetryContext | null> {
    if (manageToken.length < 16 || manageToken.length > 200) return null;
    const [booking] = await this.sql`
      SELECT b.status, b.rep_id, b.starts_at, b.ends_at,
             b.external_id, b.external_event_id, b.calendar_provider,
             b.calendar_external_account_id,
             current_connection.external_account_id AS current_external_account_id,
             b.meeting_type_id, mt.slug AS scheduling_slug,
             o.slug AS organization_slug
      FROM bookings b
      JOIN organizations o ON o.id = b.organization_id
      JOIN meeting_types mt ON mt.id = b.meeting_type_id
      JOIN rep_calendar_connections current_connection
        ON current_connection.rep_id = b.rep_id
       AND current_connection.provider = b.calendar_provider
       AND current_connection.external_account_id =
             b.calendar_external_account_id
      WHERE b.manage_token_hash = ${tokenHash(manageToken)}
        AND b.router_session_id IS NOT NULL
        AND b.status = 'failed'
        AND b.calendar_external_account_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM jobs create_job
          WHERE create_job.organization_id = b.organization_id
            AND create_job.type = 'calendar.event.create'
            AND create_job.payload->>'bookingId' = b.id::text
            AND create_job.status IN ('failed', 'cancelled')
        )
    `;
    if (!booking) return null;
    return this.routerLinkBookingRetryContextFromRow(
      String(booking.organizationSlug),
      booking,
    );
  }

  private async routerLinkBookingRetryContextFromRow(
    organizationSlug: string,
    booking: Record<string, unknown>,
  ): Promise<RouterLinkBookingRetryContext> {
    const schedule = await this.publicSchedule(
      organizationSlug,
      String(booking.schedulingSlug),
    );
    const activeSchedule =
      schedule?.meetingTypeId === String(booking.meetingTypeId)
        ? schedule
        : null;
    return {
      status: booking.status as RouterLinkBookingRetryContext["status"],
      organizationSlug,
      schedule: activeSchedule,
      repId: String(booking.repId),
      startsAt: new Date(String(booking.startsAt)).toISOString(),
      endsAt: new Date(String(booking.endsAt)).toISOString(),
      transactionId: String(booking.externalId),
      externalEventId: booking.externalEventId
        ? String(booking.externalEventId)
        : null,
      calendarProvider:
        booking.calendarProvider as RouterLinkBookingRetryContext["calendarProvider"],
      calendarExternalAccountId: booking.calendarExternalAccountId
        ? String(booking.calendarExternalAccountId)
        : null,
      currentCalendarExternalAccountId: verifiedCalendarExternalAccountId(
        booking.currentExternalAccountId,
      ),
    };
  }

  async retryRouterLinkBooking(
    organizationSlug: string,
    _routerSlug: string,
    sessionToken: string,
    calendarQuote?: BookingCandidateQuote,
  ): Promise<PublicBookingStatus | null> {
    if (sessionToken.length < 16 || sessionToken.length > 200) return null;

    return this.retryRouterLinkBookingByCredential(
      {
        kind: "session",
        organizationSlug,
        tokenHash: tokenHash(sessionToken),
      },
      calendarQuote,
    );
  }

  async retryManagedRouterLinkBooking(
    manageToken: string,
    calendarQuote?: BookingCandidateQuote,
  ): Promise<PublicBookingStatus | null> {
    if (manageToken.length < 16 || manageToken.length > 200) return null;
    return this.retryRouterLinkBookingByCredential(
      { kind: "manage", tokenHash: tokenHash(manageToken) },
      calendarQuote,
    );
  }

  private async retryRouterLinkBookingByCredential(
    credential:
      | { kind: "session"; organizationSlug: string; tokenHash: string }
      | { kind: "manage"; tokenHash: string },
    calendarQuote?: BookingCandidateQuote,
  ): Promise<PublicBookingStatus | null> {
    try {
      return await this.sql.begin(async (transaction) => {
        const [context] =
          credential.kind === "session"
            ? await transaction`
                SELECT b.id, b.organization_id
                FROM router_qualification_sessions s
                JOIN organizations o ON o.id = s.organization_id
                JOIN bookings b ON b.router_session_id = s.id
                WHERE s.token_hash = ${credential.tokenHash}
                  AND o.slug = ${credential.organizationSlug}
              `
            : await transaction`
                SELECT b.id, b.organization_id
                FROM bookings b
                WHERE b.manage_token_hash = ${credential.tokenHash}
                  AND b.router_session_id IS NOT NULL
              `;
        if (!context) return null;
        const [job] = await transaction`
          SELECT id, status, payload FROM jobs
          WHERE organization_id = ${context.organizationId}
            AND type = 'calendar.event.create'
            AND payload->>'bookingId' = ${String(context.id)}
          FOR UPDATE
        `;
        const [booking] = await transaction`
          SELECT b.id, b.status, b.last_error, b.external_id,
                 b.manage_token_hash,
                 b.conference_url, b.rep_id, b.starts_at, b.ends_at,
                 b.reserved_starts_at, b.reserved_ends_at,
                 b.calendar_provider, b.calendar_external_account_id,
                 b.external_event_id,
                 r.name AS rep_name
          FROM bookings b
          JOIN reps r ON r.id = b.rep_id
          WHERE b.id = ${context.id}
          FOR UPDATE OF b
        `;
        if (!booking) return null;

        if (booking.status !== "failed") {
          return publicBookingStatusFromRow(booking);
        }
        if (!job || !["failed", "cancelled"].includes(String(job.status))) {
          throw new RouterLinkConflictError(
            "This failed booking does not have a terminal calendar job to retry.",
          );
        }

        const calendarExternalAccountId =
          await requireMatchingBookingCalendarAccount(transaction, booking);
        if (
          (job.payload as Record<string, unknown>).calendarExternalAccountId !==
          calendarExternalAccountId
        ) {
          throw new CalendarAccountIdentityError(
            "The calendar creation job does not match this booking's calendar account.",
          );
        }

        if (!booking.externalEventId) {
          if (!calendarQuote) throw new CalendarSlotUnavailableError();
          const normalizedQuote = normalizeBookingCandidateQuote(calendarQuote);
          if (
            normalizedQuote.repId !== String(booking.repId) ||
            normalizedQuote.calendarProvider !== booking.calendarProvider ||
            normalizedQuote.calendarExternalAccountId !==
              calendarExternalAccountId
          ) {
            throw new CalendarSlotUnavailableError();
          }
          await lockMatchingAvailabilityQuote(transaction, normalizedQuote, {
            requireActiveProvider: true,
            includeProviderDefault: false,
          });
          await lockBookingCohosts(
            transaction,
            String(booking.id),
            String(booking.repId),
            normalizedQuote,
          );
        }

        const participantRows = await transaction`
          SELECT rep_id
          FROM booking_rep_reservations
          WHERE booking_id = ${booking.id}
          ORDER BY rep_id
        `;
        const participantIds = participantRows.map((row) => String(row.repId));
        for (const repId of participantIds) {
          await transaction`
            SELECT pg_advisory_xact_lock(hashtext(${repId}))
          `;
        }
        const [overlap] = await transaction`
          SELECT 1 FROM booking_rep_reservations reservation
          WHERE reservation.rep_id = ANY(${participantIds}::uuid[])
            AND reservation.booking_id <> ${booking.id}
            AND reservation.status IN (
              'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
            )
            AND (
              (
                reservation.reserved_starts_at < ${booking.reservedEndsAt}
                AND reservation.reserved_ends_at > ${booking.reservedStartsAt}
              )
              OR (
                reservation.previous_reserved_starts_at IS NOT NULL
                AND reservation.previous_reserved_starts_at < ${booking.reservedEndsAt}
                AND reservation.previous_reserved_ends_at > ${booking.reservedStartsAt}
              )
            )
          LIMIT 1
        `;
        if (overlap) throw new CalendarSlotUnavailableError();

        await transaction`
          UPDATE bookings
          SET status = 'pending', last_error = null, updated_at = now()
          WHERE id = ${booking.id} AND status = 'failed'
        `;
        await transaction`
          UPDATE jobs
          SET status = 'pending', attempts = 0, run_at = now(),
              locked_at = null, claim_token = null, completed_at = null,
              result = null, last_error = null
          WHERE id = ${job.id} AND status IN ('failed', 'cancelled')
        `;

        return {
          status: "pending",
          error: null,
          managePath: `/schedule/manage/${String(booking.externalId)}`,
          conferenceUrl: booking.conferenceUrl
            ? String(booking.conferenceUrl)
            : null,
          repName: String(booking.repName),
          startsAt: new Date(String(booking.startsAt)).toISOString(),
          endsAt: new Date(String(booking.endsAt)).toISOString(),
        };
      });
    } catch (error) {
      if (isCalendarSlotDatabaseConflict(error)) {
        throw new CalendarSlotUnavailableError();
      }
      throw error;
    }
  }

  async abandonRouterLinkBooking(
    organizationSlug: string,
    _routerSlug: string,
    sessionToken: string,
    providerEvent: ReconciledCalendarEvent | null,
  ): Promise<PublicBookingStatus | null> {
    if (sessionToken.length < 16 || sessionToken.length > 200) return null;

    return this.abandonRouterLinkBookingByCredential(
      {
        kind: "session",
        organizationSlug,
        tokenHash: tokenHash(sessionToken),
      },
      providerEvent,
    );
  }

  async abandonManagedRouterLinkBooking(
    manageToken: string,
    providerEvent: ReconciledCalendarEvent | null,
  ): Promise<PublicBookingStatus | null> {
    if (manageToken.length < 16 || manageToken.length > 200) return null;
    return this.abandonRouterLinkBookingByCredential(
      { kind: "manage", tokenHash: tokenHash(manageToken) },
      providerEvent,
    );
  }

  private async abandonRouterLinkBookingByCredential(
    credential:
      | { kind: "session"; organizationSlug: string; tokenHash: string }
      | { kind: "manage"; tokenHash: string },
    providerEvent: ReconciledCalendarEvent | null,
  ): Promise<PublicBookingStatus | null> {
    return this.sql.begin(async (transaction) => {
      const [context] =
        credential.kind === "session"
          ? await transaction`
              SELECT b.id, b.organization_id
              FROM router_qualification_sessions s
              JOIN organizations o ON o.id = s.organization_id
              JOIN bookings b ON b.router_session_id = s.id
              WHERE s.token_hash = ${credential.tokenHash}
                AND o.slug = ${credential.organizationSlug}
            `
          : await transaction`
              SELECT b.id, b.organization_id
              FROM bookings b
              WHERE b.manage_token_hash = ${credential.tokenHash}
                AND b.router_session_id IS NOT NULL
            `;
      if (!context) return null;

      const [job] = await transaction`
        SELECT id, status, payload
        FROM jobs
        WHERE organization_id = ${context.organizationId}
          AND type = 'calendar.event.create'
          AND payload->>'bookingId' = ${String(context.id)}
        FOR UPDATE
      `;
      const [booking] = await transaction`
        SELECT b.id, b.status, b.last_error, b.external_id,
               b.manage_token_hash,
               b.external_event_id, b.external_event_web_link,
               b.conference_url, b.calendar_provider,
               b.calendar_external_account_id, b.rep_id,
               b.starts_at, b.ends_at,
               o.slug AS organization_slug, r.name AS rep_name
        FROM bookings b
        JOIN organizations o ON o.id = b.organization_id
        JOIN reps r ON r.id = b.rep_id
        WHERE b.id = ${context.id}
        FOR UPDATE OF b
      `;
      if (!booking) return null;
      if (
        booking.status === "cancelled" ||
        booking.status === "cancel_pending"
      ) {
        return publicBookingStatusFromRow(booking);
      }
      if (
        booking.status !== "failed" ||
        !job ||
        !["failed", "cancelled"].includes(String(job.status))
      ) {
        throw new RouterLinkConflictError(
          "Only a failed booking with a terminal calendar job can be abandoned.",
        );
      }
      const calendarExternalAccountId =
        await requireMatchingBookingCalendarAccount(transaction, booking);

      if (providerEvent) {
        const fields = [
          providerEvent.externalEventId,
          providerEvent.webLink,
          providerEvent.conferenceUrl,
        ];
        if (
          typeof providerEvent.externalEventId !== "string" ||
          providerEvent.externalEventId.length === 0 ||
          providerEvent.externalEventId.length > 2_048 ||
          providerEvent.externalEventId !==
            providerEvent.externalEventId.trim() ||
          fields.some(
            (value) =>
              value !== null &&
              (typeof value !== "string" ||
                value.length > 4_096 ||
                /[\u0000-\u001f\u007f]/.test(value)),
          ) ||
          (booking.externalEventId &&
            String(booking.externalEventId) !== providerEvent.externalEventId)
        ) {
          throw new RouterLinkConflictError(
            "The provider returned conflicting booking event evidence.",
          );
        }

        const [activeCancelJob] = await transaction`
          SELECT id FROM jobs
          WHERE organization_id = ${context.organizationId}
            AND type = 'calendar.event.cancel'
            AND payload->>'bookingId' = ${String(booking.id)}
            AND status IN ('pending', 'processing')
          LIMIT 1
          FOR UPDATE
        `;
        if (activeCancelJob) {
          throw new RouterLinkConflictError(
            "This booking already has a calendar cancellation in progress.",
          );
        }

        await transaction`
          UPDATE bookings
          SET status = 'cancel_pending',
              external_event_id = ${providerEvent.externalEventId},
              external_event_web_link = coalesce(
                ${providerEvent.webLink}, external_event_web_link
              ),
              conference_url = coalesce(
                ${providerEvent.conferenceUrl}, conference_url
              ),
              updated_at = now()
          WHERE id = ${booking.id} AND status = 'failed'
        `;
        await transaction`
          INSERT INTO jobs (organization_id, type, payload)
          VALUES (
            ${context.organizationId},
            'calendar.event.cancel',
            ${transaction.json({
              bookingId: String(booking.id),
              externalId: String(booking.externalId),
              externalEventId: providerEvent.externalEventId,
              organizationSlug: String(booking.organizationSlug),
              repId: String(booking.repId),
              provider: String(booking.calendarProvider),
              calendarExternalAccountId,
              suppressLifecycleEmail: true,
            } as JSONValue)}
          )
        `;
        return {
          status: "cancel_pending",
          error: booking.lastError ? String(booking.lastError) : null,
          managePath: `/schedule/manage/${String(booking.externalId)}`,
          conferenceUrl:
            providerEvent.conferenceUrl ??
            (booking.conferenceUrl ? String(booking.conferenceUrl) : null),
          repName: String(booking.repName),
          startsAt: new Date(String(booking.startsAt)).toISOString(),
          endsAt: new Date(String(booking.endsAt)).toISOString(),
        };
      }

      const [pendingClose] = await transaction`
        UPDATE bookings
        SET status = 'cancel_pending', updated_at = now()
        WHERE id = ${booking.id} AND status = 'failed'
        RETURNING id
      `;
      if (!pendingClose) {
        throw new RouterLinkConflictError(
          "This failed booking could not begin safe provider reconciliation.",
        );
      }
      const createPayload = job.payload as Record<string, unknown>;
      await transaction`
        INSERT INTO jobs (organization_id, type, payload, run_at)
        VALUES (
          ${context.organizationId}, ${createReconciliationJobType},
          ${transaction.json({
            ...createPayload,
            calendarExternalAccountId,
            reconciliationForJobId: Number(job.id),
            reconciliationIntent: "close",
          } as JSONValue)},
          now() + interval '5 seconds'
        )
      `;
      return {
        status: "cancel_pending",
        error: booking.lastError ? String(booking.lastError) : null,
        managePath: `/schedule/manage/${String(booking.externalId)}`,
        conferenceUrl: booking.conferenceUrl
          ? String(booking.conferenceUrl)
          : null,
        repName: String(booking.repName),
        startsAt: new Date(String(booking.startsAt)).toISOString(),
        endsAt: new Date(String(booking.endsAt)).toISOString(),
      };
    });
  }

  async bookRouterLinkSession(
    input: BookRouterLinkSessionRequest,
  ): Promise<PublicBookingStatus> {
    if (
      input.sessionToken.length < 16 ||
      input.sessionToken.length > 200 ||
      input.attemptToken.length < 16 ||
      input.attemptToken.length > 200
    ) {
      throw new RouterLinkValidationError("Invalid routing session token.");
    }
    const candidateQuotes = input.candidateQuotes.map(
      normalizeBookingCandidateQuote,
    );
    const candidateRepIds = candidateQuotes.map((quote) => quote.repId);
    const candidateQuoteByRepId = new Map(
      candidateQuotes.map((quote) => [quote.repId, quote]),
    );
    if (
      candidateRepIds.length < 1 ||
      candidateRepIds.length > 100 ||
      new Set(candidateRepIds).size !== candidateRepIds.length
    ) {
      throw new RouterLinkValidationError("Invalid representative candidates.");
    }
    if (
      !Number.isFinite(input.startsAt.getTime()) ||
      !Number.isFinite(input.endsAt.getTime()) ||
      input.endsAt <= input.startsAt
    ) {
      throw new RouterLinkValidationError("Choose a valid meeting time.");
    }
    try {
      return await this.sql.begin(async (transaction) => {
        const [session] = await transaction`
          SELECT s.id, s.organization_id, s.router_link_id, s.attendee_name,
                 s.attendee_email, s.lead, s.expires_at, s.outcome,
                 s.link_config_version, s.matched_rule_id, s.pool_id,
                 s.meeting_type_id, rl.active AS link_active,
                 s.booking_attempt_token_hash, s.booking_attempt_starts_at,
                 s.booking_attempt_ends_at, s.booking_attempt_started_at,
                 rl.config_version, o.slug AS organization_slug,
                 rl.slug AS router_slug
          FROM router_qualification_sessions s
          JOIN organizations o ON o.id = s.organization_id
          JOIN router_links rl ON rl.id = s.router_link_id
          WHERE s.token_hash = ${tokenHash(input.sessionToken)}
            AND o.slug = ${input.organizationSlug}
            AND rl.slug = ${input.routerSlug}
          FOR UPDATE OF s
        `;
        if (!session) throw new RouterLinkNotFoundError();
        const now = input.now ?? new Date();
        const additionalAttendeeEmails = normalizedAdditionalAttendeeEmails(
          input.additionalAttendeeEmails,
          String(session.attendeeEmail),
        );

        const [existing] = await transaction`
          SELECT b.status, b.last_error, b.external_id, b.manage_token_hash,
                 b.conference_url,
                 b.starts_at, b.ends_at,
                 r.name AS rep_name
          FROM bookings b
          JOIN reps r ON r.id = b.rep_id
          WHERE b.router_session_id = ${session.id}
        `;
        if (existing) return publicBookingStatusFromRow(existing);

        if (
          String(session.bookingAttemptTokenHash ?? "") !==
            tokenHash(input.attemptToken) ||
          !session.bookingAttemptStartedAt ||
          new Date(String(session.bookingAttemptStartedAt)).getTime() <=
            now.getTime() - routerBookingAttemptLeaseMs ||
          new Date(String(session.bookingAttemptStartsAt)).getTime() !==
            input.startsAt.getTime() ||
          new Date(String(session.bookingAttemptEndsAt)).getTime() !==
            input.endsAt.getTime()
        ) {
          throw new RouterLinkConflictError(
            "This booking attempt expired. Check booking status before trying again.",
          );
        }

        if (session.outcome !== "matched") {
          throw new RouterLinkConflictError(
            "This submission did not match a routing destination.",
          );
        }
        if (
          new Date(String(session.expiresAt)).getTime() <= now.getTime() ||
          !session.linkActive ||
          Number(session.linkConfigVersion) !== Number(session.configVersion)
        ) {
          throw new RouterLinkSessionExpiredError();
        }

        const ruleRows = await transaction`
          SELECT id, name, priority, conditions, pool_id
          FROM routing_rules
          WHERE organization_id = ${session.organizationId} AND active = true
          ORDER BY priority, id
        `;
        const rules: Rule[] = ruleRows.map((row) => ({
          id: String(row.id),
          name: String(row.name),
          priority: Number(row.priority),
          conditions: row.conditions as Rule["conditions"],
          poolId: String(row.poolId),
        }));
        const lead = session.lead as Lead;
        const matchedRule = findMatchingRule(lead, rules);
        if (
          !matchedRule ||
          matchedRule.id !== String(session.matchedRuleId) ||
          matchedRule.poolId !== String(session.poolId)
        ) {
          throw new RouterLinkSessionExpiredError();
        }

        const [meetingType] = await transaction`
          SELECT mt.id, mt.slug, mt.title, mt.description, mt.duration_minutes,
                 mt.buffer_before_minutes, mt.buffer_after_minutes,
                 mt.minimum_notice_minutes, mt.booking_window_days,
                 mt.invitee_limit_scope, mt.invitee_limit_count,
                 mt.reschedule_cutoff_minutes, mt.cancel_cutoff_minutes,
                 mt.conference_provider, mt.zoom_join_url, mt.reminder_minutes
          FROM router_link_destinations rld
          JOIN meeting_types mt ON mt.id = rld.meeting_type_id
          WHERE rld.router_link_id = ${session.routerLinkId}
            AND rld.pool_id = ${session.poolId}
            AND rld.meeting_type_id = ${session.meetingTypeId}
            AND mt.organization_id = ${session.organizationId}
            AND mt.pool_id = ${session.poolId}
            AND mt.active = true
          FOR SHARE OF mt
        `;
        if (!meetingType) throw new RouterLinkSessionExpiredError();
        const durationMs = Number(meetingType.durationMinutes) * 60_000;
        if (
          input.endsAt.getTime() - input.startsAt.getTime() !== durationMs ||
          input.startsAt.getTime() <
            now.getTime() + Number(meetingType.minimumNoticeMinutes) * 60_000 ||
          input.endsAt.getTime() >
            now.getTime() + Number(meetingType.bookingWindowDays) * 86_400_000
        ) {
          throw new CalendarSlotUnavailableError();
        }
        const protectedRange = protectedBookingRange(
          input.startsAt,
          input.endsAt,
          Number(meetingType.bufferBeforeMinutes),
          Number(meetingType.bufferAfterMinutes),
        );

        await enforceInviteeBookingLimit(transaction, {
          organizationId: String(session.organizationId),
          meetingTypeId: String(session.meetingTypeId),
          attendeeEmail: String(session.attendeeEmail),
          scope: meetingType.inviteeLimitScope as InviteeLimitScope,
          count:
            meetingType.inviteeLimitCount === null
              ? null
              : Number(meetingType.inviteeLimitCount),
          excludeRouterSessionId: String(session.id),
        });

        await lockSchedulingPools(
          transaction,
          String(session.meetingTypeId),
          String(session.poolId),
        );
        await lockBookingParticipantReps(transaction, candidateQuotes);
        const candidateRows = await transaction`
          SELECT r.id, r.name, r.email, r.timezone, r.weight, r.active,
                 r.availability, r.availability_overrides,
                 c.provider, c.external_account_id,
                 coalesce(ast.assignments, 0)::int AS assignments,
                 ast.last_assigned_at
          FROM reps r
          JOIN routing_pool_members rpm
            ON rpm.rep_id = r.id AND rpm.pool_id = ${session.poolId}
          JOIN rep_calendar_connections c
            ON c.rep_id = r.id AND c.provider = r.active_calendar_provider
          LEFT JOIN assignment_state ast
            ON ast.pool_id = ${session.poolId} AND ast.rep_id = r.id
          WHERE r.organization_id = ${session.organizationId}
            AND r.active = true
            AND r.id = ANY(${candidateRepIds}::uuid[])
            AND c.external_account_id IS NOT NULL
            AND length(c.external_account_id) BETWEEN 1 AND 1024
            AND c.external_account_id !~ '[[:cntrl:]]'
            AND (
              ${meetingType.conferenceProvider}::text IN ('none', 'zoom')
              OR (${meetingType.conferenceProvider} = 'google_meet' AND c.provider = 'google')
              OR (${meetingType.conferenceProvider} = 'microsoft_teams' AND c.provider = 'microsoft')
            )
            AND NOT EXISTS (
              SELECT 1 FROM booking_rep_reservations reservation
              WHERE reservation.rep_id = r.id
                AND reservation.status IN (
                  'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
                )
                AND (
                  (
                    reservation.reserved_starts_at < ${protectedRange.endsAt}
                    AND reservation.reserved_ends_at > ${protectedRange.startsAt}
                  ) OR (
                    reservation.previous_reserved_starts_at IS NOT NULL
                    AND reservation.previous_reserved_starts_at < ${protectedRange.endsAt}
                    AND reservation.previous_reserved_ends_at > ${protectedRange.startsAt}
                  )
                )
            )
        `;
        const candidateById = new Map(
          candidateRows.map((row) => [String(row.id), row]),
        );
        let reps = candidateRows
          .map(
            (row): Rep => ({
              id: String(row.id),
              name: String(row.name),
              email: String(row.email),
              timezone: String(row.timezone),
              weight: Number(row.weight),
              active: Boolean(row.active),
              availability: row.availability as Rep["availability"],
              availabilityOverrides: (row.availabilityOverrides ??
                {}) as Rep["availabilityOverrides"],
            }),
          )
          .filter(
            (rep) =>
              isRepScheduled(rep, input.startsAt) &&
              isRepScheduled(rep, new Date(input.endsAt.getTime() - 1)),
          );
        const assignmentState: AssignmentState[] = candidateRows.map((row) => ({
          repId: String(row.id),
          assignments: Number(row.assignments),
          lastAssignedAt: row.lastAssignedAt
            ? new Date(String(row.lastAssignedAt))
            : null,
        }));

        let result: ReturnType<typeof routeMatchedRule> | null = null;
        let context: Record<string, unknown> | undefined;
        let cohostResolution: MeetingTypeCohostResolution | undefined;
        while (reps.length > 0) {
          result = routeMatchedRule(
            lead,
            matchedRule,
            reps,
            assignmentState,
            input.startsAt,
          );
          context = candidateById.get(result.rep.id);
          const quote = candidateQuoteByRepId.get(result.rep.id);
          if (quote) {
            try {
              const candidateCohosts = await resolveMeetingTypeCohosts(
                transaction,
                String(session.meetingTypeId),
                result.rep.id,
                quote,
                input.startsAt,
                protectedRange,
              );
              if (
                await bookingParticipantsAreAvailable(
                  transaction,
                  candidateCohosts.quote,
                  input.startsAt,
                  protectedRange,
                )
              ) {
                cohostResolution = candidateCohosts;
                break;
              }
            } catch (error) {
              if (!(error instanceof CalendarSlotUnavailableError)) throw error;
            }
          }
          reps = reps.filter((rep) => rep.id !== result!.rep.id);
          result = null;
          context = undefined;
        }
        if (!result || !context || !cohostResolution) {
          throw new CalendarSlotUnavailableError();
        }
        const selectedQuote = candidateQuoteByRepId.get(result.rep.id);
        if (!selectedQuote) throw new CalendarSlotUnavailableError();
        const calendarExternalAccountId = await lockMatchingAvailabilityQuote(
          transaction,
          selectedQuote,
          { requireActiveProvider: true, includeProviderDefault: false },
        );
        const cohostEmails = cohostResolution.cohostEmails;

        const decisionExternalId = `router-session:${String(session.id)}`;
        const availabilitySource =
          context.provider === "google"
            ? "google_calendar"
            : "microsoft_calendar";
        const [decision] = await transaction`
          INSERT INTO routing_decisions (
            organization_id, external_id, lead_email, lead, rule_id, pool_id,
            rep_id, reason, availability_source
          ) VALUES (
            ${session.organizationId}, ${decisionExternalId},
            ${String(session.attendeeEmail)},
            ${transaction.json(lead as JSONValue)}, ${matchedRule.id},
            ${matchedRule.poolId}, ${result.rep.id}, ${result.reason},
            ${availabilitySource}
          )
          RETURNING id
        `;
        const externalId = randomUUID();
        const conferenceUrl =
          meetingType.conferenceProvider === "zoom" && meetingType.zoomJoinUrl
            ? String(meetingType.zoomJoinUrl)
            : null;
        const [booking] = await transaction`
          INSERT INTO bookings (
            organization_id, meeting_type_id, rep_id, external_id,
            manage_token_hash, attendee_name, attendee_email,
            additional_attendee_emails, starts_at, ends_at,
            buffer_before_minutes, buffer_after_minutes,
            reschedule_cutoff_minutes, cancel_cutoff_minutes,
            calendar_provider, calendar_external_account_id,
            conference_provider, conference_url,
            router_session_id, routing_decision_id
          ) VALUES (
            ${session.organizationId}, ${session.meetingTypeId}, ${result.rep.id},
            ${externalId}, ${tokenHash(externalId)}, ${String(session.attendeeName)},
            ${String(session.attendeeEmail)}, ${additionalAttendeeEmails},
            ${input.startsAt}, ${input.endsAt},
            ${Number(meetingType.bufferBeforeMinutes)},
            ${Number(meetingType.bufferAfterMinutes)},
            ${meetingType.rescheduleCutoffMinutes ?? null},
            ${meetingType.cancelCutoffMinutes ?? null},
            ${String(context.provider)}, ${calendarExternalAccountId},
            ${String(meetingType.conferenceProvider)},
            ${conferenceUrl}, ${session.id}, ${decision!.id}
          )
          RETURNING id, status, conference_url
        `;

        await persistSelectedCohostGroups(
          transaction,
          String(booking!.id),
          cohostResolution.selectedGroups,
        );
        const crmRoleOwners = await cohostRoleOwnersForBooking(transaction, {
          organizationId: String(session.organizationId),
          selectedGroups: cohostResolution.selectedGroups,
        });

        await transaction`
          INSERT INTO assignment_state (pool_id, rep_id, assignments, last_assigned_at)
          VALUES (${matchedRule.poolId}, ${result.rep.id}, 1, ${now})
          ON CONFLICT (pool_id, rep_id) DO UPDATE SET
            assignments = assignment_state.assignments + 1,
            last_assigned_at = EXCLUDED.last_assigned_at
        `;
        const [hubspotConnection] = await transaction`
          SELECT 1 FROM oauth_connections
          WHERE organization_id = ${session.organizationId}
            AND provider = 'hubspot'
        `;
        await transaction`
          INSERT INTO jobs (organization_id, type, payload)
          VALUES (
            ${session.organizationId}, 'crm.owner.writeback',
            ${transaction.json({
              adapter: hubspotConnection ? "hubspot" : "development",
              organizationSlug: input.organizationSlug,
              decisionId: String(decision!.id),
              leadEmail: String(session.attendeeEmail),
              ownerEmail: result.rep.email,
            })}
          )
        `;
        await transaction`
          INSERT INTO jobs (organization_id, type, payload)
          VALUES (
            ${session.organizationId}, 'calendar.event.create',
            ${transaction.json({
              bookingId: String(booking!.id),
              externalId,
              organizationSlug: input.organizationSlug,
              schedulingSlug: String(meetingType.slug),
              publicBooking: true,
              smartRouterLink: true,
              decisionId: String(decision!.id),
              repId: result.rep.id,
              repName: result.rep.name,
              repEmail: result.rep.email,
              repTimezone: result.rep.timezone,
              provider: String(context.provider),
              calendarExternalAccountId,
              startsAt: input.startsAt.toISOString(),
              endsAt: input.endsAt.toISOString(),
              subject: `${String(meetingType.title)} · ${String(session.attendeeName)}`,
              description: String(meetingType.description),
              attendeeName: String(session.attendeeName),
              attendeeEmail: String(session.attendeeEmail),
              additionalAttendeeEmails,
              cohostEmails,
              attendeeNotificationsEnabled: true,
              conferenceProvider: String(meetingType.conferenceProvider),
              conferenceUrl,
              reminderMinutes: Number(meetingType.reminderMinutes),
              ...(crmRoleOwners.length > 0
                ? {
                    crmLeadEmail: String(session.attendeeEmail),
                    crmRoleOwners,
                  }
                : {}),
            })}
          )
        `;
        await transaction`
          UPDATE router_qualification_sessions
          SET booked_at = ${now}, booking_attempt_token_hash = null,
              booking_attempt_starts_at = null,
              booking_attempt_ends_at = null,
              booking_attempt_started_at = null
          WHERE id = ${session.id}
        `;
        await transaction`
          UPDATE router_funnel_events
          SET booked_at = coalesce(booked_at, ${now})
          WHERE session_id = ${session.id}
        `;
        return {
          status: booking!.status as PublicBookingStatus["status"],
          error: null,
          managePath: `/schedule/manage/${externalId}`,
          conferenceUrl,
          repName: result.rep.name,
          startsAt: input.startsAt.toISOString(),
          endsAt: input.endsAt.toISOString(),
        };
      });
    } catch (error) {
      if (
        isCalendarSlotDatabaseConflict(error) ||
        error instanceof CalendarAccountIdentityError
      ) {
        throw new CalendarSlotUnavailableError();
      }
      throw error;
    }
  }

  async routingPreview(
    request: RoutingPreviewRequest,
  ): Promise<RoutingPreview> {
    const [organization] = await this.sql`
      SELECT id FROM organizations WHERE slug = ${request.organizationSlug}
    `;
    if (!organization) {
      throw new Error(`Unknown organization: ${request.organizationSlug}`);
    }
    const { context } = await routingContext(this.sql, String(organization.id));
    return evaluateRoutePreview(
      request.lead,
      context,
      request.evaluatedAt ?? new Date(),
      { unavailableRepEmails: request.unavailableRepEmails },
    );
  }

  async saveMeetingType(input: {
    organizationSlug: string;
    id?: string;
    slug: string;
    title: string;
    description: string;
    durationMinutes: number;
    bufferBeforeMinutes?: number;
    bufferAfterMinutes?: number;
    minimumNoticeMinutes: number;
    bookingWindowDays: number;
    inviteeLimitScope?: InviteeLimitScope;
    inviteeLimitCount?: number | null;
    rescheduleCutoffMinutes?: number | null;
    cancelCutoffMinutes?: number | null;
    conferenceProvider: ConferenceProvider;
    zoomJoinUrl?: string | null;
    reminderMinutes: number;
    active: boolean;
    targetType: "rep" | "pool";
    targetId: string;
    cohosts?: Array<{
      repId: string;
      requiredForAvailability: boolean;
    }>;
    cohostGroups?: Array<{
      poolId: string;
      requiredForAvailability: boolean;
      crmOwnerProperty?: string | null;
    }>;
  }): Promise<string> {
    if (
      input.inviteeLimitScope === undefined &&
      input.inviteeLimitCount !== undefined
    ) {
      throw new Error("Choose who the invitee booking limit applies to.");
    }
    const inviteeLimit =
      input.inviteeLimitScope === undefined
        ? null
        : validatedInviteeLimit(
            input.inviteeLimitScope,
            input.inviteeLimitCount,
          );
    if (
      !validBookingChangeCutoff(input.rescheduleCutoffMinutes) ||
      !validBookingChangeCutoff(input.cancelCutoffMinutes)
    ) {
      throw new Error(
        "Booking change cutoffs must be between 0 and 43,200 minutes.",
      );
    }
    return this.sql.begin(async (transaction) => {
      const [organization] = await transaction`
        SELECT id FROM organizations WHERE slug = ${input.organizationSlug}
      `;
      if (!organization) {
        throw new Error(`Unknown organization: ${input.organizationSlug}`);
      }

      const targetTable = input.targetType === "rep" ? "reps" : "routing_pools";
      const [target] = await transaction.unsafe(
        `SELECT id FROM ${targetTable} WHERE id = $1 AND organization_id = $2`,
        [input.targetId, organization.id],
      );
      if (!target) throw new Error("Scheduling target not found.");

      const cohosts = input.cohosts ?? [];
      const cohostGroups = (input.cohostGroups ?? []).map((group) => ({
        ...group,
        crmOwnerProperty: normalizedCrmOwnerProperty(group.crmOwnerProperty),
      }));
      if (
        cohosts.length > 10 ||
        new Set(cohosts.map((cohost) => cohost.repId)).size !== cohosts.length
      ) {
        throw new Error("Choose up to 10 unique co-hosts.");
      }
      if (
        input.targetType === "rep" &&
        cohosts.some((cohost) => cohost.repId === input.targetId)
      ) {
        throw new Error("The organizer cannot also be a co-host.");
      }
      if (
        cohostGroups.length > 5 ||
        new Set(cohostGroups.map((group) => group.poolId)).size !==
          cohostGroups.length
      ) {
        throw new Error("Choose up to 5 unique co-host pools.");
      }
      const crmOwnerProperties = cohostGroups.flatMap((group) =>
        group.crmOwnerProperty ? [group.crmOwnerProperty] : [],
      );
      if (new Set(crmOwnerProperties).size !== crmOwnerProperties.length) {
        throw new Error(
          "Map each CRM owner property to only one co-host role.",
        );
      }
      if (
        input.targetType === "pool" &&
        cohostGroups.some((group) => group.poolId === input.targetId)
      ) {
        throw new Error("The organizer pool cannot also be a co-host pool.");
      }
      if (cohosts.length > 0) {
        const cohostRows = await transaction`
          SELECT r.id, r.active,
                 c.external_account_id,
                 EXISTS (
                   SELECT 1
                   FROM rep_calendar_sources source
                   JOIN rep_calendar_connections source_connection
                     ON source_connection.rep_id = source.rep_id
                    AND source_connection.provider = source.provider
                   WHERE source.rep_id = r.id
                     AND source.selected_for_conflicts
                     AND source.missing_since IS NULL
                     AND source_connection.external_account_id IS NOT NULL
                     AND length(source_connection.external_account_id)
                       BETWEEN 1 AND 1024
                     AND source_connection.external_account_id !~ '[[:cntrl:]]'
                 ) AS has_conflict_calendar
          FROM reps r
          LEFT JOIN rep_calendar_connections c
            ON c.rep_id = r.id AND c.provider = r.active_calendar_provider
          WHERE r.organization_id = ${organization.id}
            AND r.id = ANY(${cohosts.map((cohost) => cohost.repId)}::uuid[])
          FOR SHARE OF r
        `;
        if (
          cohostRows.length !== cohosts.length ||
          cohostRows.some((row) => !row.active)
        ) {
          throw new Error(
            "Co-hosts must be active people in this organization.",
          );
        }
        const cohostById = new Map(
          cohostRows.map((row) => [String(row.id), row]),
        );
        if (
          cohosts.some((cohost) => {
            if (!cohost.requiredForAvailability) return false;
            const row = cohostById.get(cohost.repId);
            return !row?.externalAccountId || !row.hasConflictCalendar;
          })
        ) {
          throw new Error(
            "Required co-hosts need an active Google or Outlook calendar with conflict checking enabled.",
          );
        }
      }
      if (cohostGroups.length > 0) {
        const poolRows = await transaction`
          SELECT pool.id
          FROM routing_pools pool
          WHERE pool.organization_id = ${organization.id}
            AND pool.id = ANY(${cohostGroups.map((group) => group.poolId)}::uuid[])
        `;
        if (poolRows.length !== cohostGroups.length) {
          throw new Error("Co-host pools must belong to this organization.");
        }
        const memberRows = await transaction`
          SELECT member.pool_id, rep.id,
                 (
                   connection.external_account_id IS NOT NULL
                   AND length(connection.external_account_id) BETWEEN 1 AND 1024
                   AND connection.external_account_id !~ '[[:cntrl:]]'
                   AND EXISTS (
                     SELECT 1
                     FROM rep_calendar_sources source
                     JOIN rep_calendar_connections source_connection
                       ON source_connection.rep_id = source.rep_id
                      AND source_connection.provider = source.provider
                     WHERE source.rep_id = rep.id
                       AND source.selected_for_conflicts
                       AND source.missing_since IS NULL
                       AND source_connection.external_account_id IS NOT NULL
                       AND length(source_connection.external_account_id)
                         BETWEEN 1 AND 1024
                       AND source_connection.external_account_id !~ '[[:cntrl:]]'
                   )
                   AND NOT EXISTS (
                     SELECT 1
                     FROM rep_calendar_sources source
                     LEFT JOIN rep_calendar_connections source_connection
                       ON source_connection.rep_id = source.rep_id
                      AND source_connection.provider = source.provider
                     WHERE source.rep_id = rep.id
                       AND source.selected_for_conflicts
                       AND (
                         source.missing_since IS NOT NULL
                         OR source_connection.external_account_id IS NULL
                         OR length(source_connection.external_account_id)
                           NOT BETWEEN 1 AND 1024
                         OR source_connection.external_account_id ~ '[[:cntrl:]]'
                       )
                   )
                 ) AS calendar_ready
          FROM routing_pool_members member
          JOIN reps rep ON rep.id = member.rep_id AND rep.active = true
          LEFT JOIN rep_calendar_connections connection
            ON connection.rep_id = rep.id
           AND connection.provider = rep.active_calendar_provider
          WHERE member.pool_id = ANY(${cohostGroups.map((group) => group.poolId)}::uuid[])
        `;
        const excludedIds = new Set([
          ...cohosts.map((cohost) => cohost.repId),
          ...(input.targetType === "rep" ? [input.targetId] : []),
        ]);
        const optionsByGroup = cohostGroups.map((group) =>
          memberRows
            .filter(
              (row) =>
                String(row.poolId) === group.poolId &&
                !excludedIds.has(String(row.id)) &&
                (!group.requiredForAvailability || Boolean(row.calendarReady)),
            )
            .map((row) => String(row.id)),
        );
        function canAssignEveryGroup(
          index: number,
          used: Set<string>,
        ): boolean {
          if (index === optionsByGroup.length) return true;
          for (const repId of optionsByGroup[index]!) {
            if (used.has(repId)) continue;
            used.add(repId);
            if (canAssignEveryGroup(index + 1, used)) return true;
            used.delete(repId);
          }
          return false;
        }
        if (!canAssignEveryGroup(0, new Set())) {
          throw new Error(
            "Every co-host pool needs a different eligible person; required roles also need an active Google or Outlook calendar with conflict checking enabled.",
          );
        }
      }

      if (
        input.id &&
        input.cohosts === undefined &&
        input.targetType === "rep"
      ) {
        const [organizerCohost] = await transaction`
          SELECT 1
          FROM meeting_types meeting_type
          JOIN meeting_type_cohosts cohost
            ON cohost.meeting_type_id = meeting_type.id
          WHERE meeting_type.id = ${input.id}
            AND meeting_type.organization_id = ${organization.id}
            AND cohost.rep_id = ${input.targetId}
          LIMIT 1
        `;
        if (organizerCohost) {
          throw new Error("The organizer cannot also be a co-host.");
        }
      }
      if (
        input.id &&
        input.cohostGroups === undefined &&
        input.targetType === "pool"
      ) {
        const [organizerCohostPool] = await transaction`
          SELECT 1
          FROM meeting_types meeting_type
          JOIN meeting_type_cohost_groups cohost_group
            ON cohost_group.meeting_type_id = meeting_type.id
          WHERE meeting_type.id = ${input.id}
            AND meeting_type.organization_id = ${organization.id}
            AND cohost_group.pool_id = ${input.targetId}
          LIMIT 1
        `;
        if (organizerCohostPool) {
          throw new Error("The organizer pool cannot also be a co-host pool.");
        }
      }

      const repId = input.targetType === "rep" ? input.targetId : null;
      const poolId = input.targetType === "pool" ? input.targetId : null;
      if (input.id) {
        if (input.cohosts !== undefined) {
          await transaction`
            DELETE FROM meeting_type_cohosts
            WHERE meeting_type_id = ${input.id}
          `;
        }
        if (input.cohostGroups !== undefined) {
          await transaction`
            DELETE FROM meeting_type_cohost_groups
            WHERE meeting_type_id = ${input.id}
          `;
        }
        const [updated] = await transaction`
          UPDATE meeting_types
          SET slug = ${input.slug}, title = ${input.title},
              description = ${input.description},
              duration_minutes = ${input.durationMinutes},
              buffer_before_minutes = coalesce(
                ${input.bufferBeforeMinutes ?? null}::integer,
                buffer_before_minutes
              ),
              buffer_after_minutes = coalesce(
                ${input.bufferAfterMinutes ?? null}::integer,
                buffer_after_minutes
              ),
              minimum_notice_minutes = ${input.minimumNoticeMinutes},
              booking_window_days = ${input.bookingWindowDays},
              invitee_limit_scope = CASE
                WHEN ${input.inviteeLimitScope !== undefined}
                THEN ${inviteeLimit?.scope ?? "none"}
                ELSE invitee_limit_scope
              END,
              invitee_limit_count = CASE
                WHEN ${input.inviteeLimitScope !== undefined}
                THEN ${inviteeLimit?.count ?? null}
                ELSE invitee_limit_count
              END,
              reschedule_cutoff_minutes = CASE
                WHEN ${input.rescheduleCutoffMinutes !== undefined}
                THEN ${input.rescheduleCutoffMinutes ?? null}
                ELSE reschedule_cutoff_minutes
              END,
              cancel_cutoff_minutes = CASE
                WHEN ${input.cancelCutoffMinutes !== undefined}
                THEN ${input.cancelCutoffMinutes ?? null}
                ELSE cancel_cutoff_minutes
              END,
              conference_provider = ${input.conferenceProvider},
              zoom_join_url = ${input.zoomJoinUrl ?? null},
              reminder_minutes = ${input.reminderMinutes}, active = ${input.active},
              rep_id = ${repId}, pool_id = ${poolId}, updated_at = now()
          WHERE id = ${input.id} AND organization_id = ${organization.id}
          RETURNING id
        `;
        if (!updated) throw new Error("Meeting type not found.");
        if (input.cohosts !== undefined) {
          for (const [position, cohost] of cohosts.entries()) {
            await transaction`
              INSERT INTO meeting_type_cohosts (
                meeting_type_id, rep_id, required_for_availability, position
              ) VALUES (
                ${updated.id}, ${cohost.repId},
                ${cohost.requiredForAvailability}, ${position}
              )
            `;
          }
        }
        if (input.cohostGroups !== undefined) {
          for (const [position, group] of cohostGroups.entries()) {
            await transaction`
              INSERT INTO meeting_type_cohost_groups (
                meeting_type_id, pool_id, required_for_availability, position,
                crm_owner_property
              ) VALUES (
                ${updated.id}, ${group.poolId},
                ${group.requiredForAvailability}, ${position},
                ${group.crmOwnerProperty}
              )
            `;
          }
        }
        return String(updated.id);
      }

      const [created] = await transaction`
        INSERT INTO meeting_types (
          organization_id, rep_id, pool_id, slug, title, description,
          duration_minutes, buffer_before_minutes, buffer_after_minutes,
          minimum_notice_minutes, booking_window_days,
          invitee_limit_scope, invitee_limit_count,
          reschedule_cutoff_minutes, cancel_cutoff_minutes,
          conference_provider, zoom_join_url, reminder_minutes, active
        ) VALUES (
          ${organization.id}, ${repId}, ${poolId}, ${input.slug}, ${input.title},
          ${input.description}, ${input.durationMinutes},
          ${input.bufferBeforeMinutes ?? 0}, ${input.bufferAfterMinutes ?? 0},
          ${input.minimumNoticeMinutes}, ${input.bookingWindowDays},
          ${inviteeLimit?.scope ?? "none"}, ${inviteeLimit?.count ?? null},
          ${input.rescheduleCutoffMinutes ?? null},
          ${input.cancelCutoffMinutes ?? null},
          ${input.conferenceProvider}, ${input.zoomJoinUrl ?? null},
          ${input.reminderMinutes}, ${input.active}
        )
        RETURNING id
      `;
      for (const [position, cohost] of cohosts.entries()) {
        await transaction`
          INSERT INTO meeting_type_cohosts (
            meeting_type_id, rep_id, required_for_availability, position
          ) VALUES (
            ${created!.id}, ${cohost.repId},
            ${cohost.requiredForAvailability}, ${position}
          )
        `;
      }
      for (const [position, group] of cohostGroups.entries()) {
        await transaction`
          INSERT INTO meeting_type_cohost_groups (
            meeting_type_id, pool_id, required_for_availability, position,
            crm_owner_property
          ) VALUES (
            ${created!.id}, ${group.poolId},
            ${group.requiredForAvailability}, ${position},
            ${group.crmOwnerProperty}
          )
        `;
      }
      return String(created!.id);
    });
  }

  async saveAvailabilitySchedule(input: {
    organizationId: string;
    operatorId: string;
    id?: string;
    name: string;
    availability: AvailabilitySchedule["availability"];
  }): Promise<string | null> {
    if (
      !uuidPattern.test(input.organizationId) ||
      !uuidPattern.test(input.operatorId) ||
      (input.id !== undefined && !uuidPattern.test(input.id))
    ) {
      return null;
    }
    return this.sql.begin(async (transaction) => {
      const [access] = await transaction`
        SELECT membership.role
        FROM organization_memberships membership
        JOIN operator_accounts account
          ON account.id = membership.operator_id
        WHERE membership.organization_id = ${input.organizationId}
          AND membership.operator_id = ${input.operatorId}
          AND membership.active = true
          AND account.active = true
          AND membership.role IN ('owner', 'admin')
        FOR UPDATE OF membership
      `;
      if (!access) return null;

      const availability = transaction.json(input.availability as JSONValue);
      if (input.id) {
        const [updated] = await transaction`
          UPDATE availability_schedules
          SET name = ${input.name}, availability = ${availability},
              updated_at = now()
          WHERE id = ${input.id}
            AND organization_id = ${input.organizationId}
          RETURNING id
        `;
        if (!updated) return null;
        await transaction`
          UPDATE reps
          SET availability = ${availability}
          WHERE organization_id = ${input.organizationId}
            AND availability_schedule_id = ${input.id}
        `;
        return String(updated.id);
      }

      const [created] = await transaction`
        INSERT INTO availability_schedules (
          organization_id, name, availability
        ) VALUES (
          ${input.organizationId}, ${input.name}, ${availability}
        )
        RETURNING id
      `;
      return created ? String(created.id) : null;
    });
  }

  async deleteAvailabilitySchedule(input: {
    organizationId: string;
    operatorId: string;
    id: string;
  }): Promise<boolean> {
    if (
      !uuidPattern.test(input.organizationId) ||
      !uuidPattern.test(input.operatorId) ||
      !uuidPattern.test(input.id)
    ) {
      return false;
    }
    return this.sql.begin(async (transaction) => {
      const [access] = await transaction`
        SELECT membership.role
        FROM organization_memberships membership
        JOIN operator_accounts account
          ON account.id = membership.operator_id
        WHERE membership.organization_id = ${input.organizationId}
          AND membership.operator_id = ${input.operatorId}
          AND membership.active = true
          AND account.active = true
          AND membership.role IN ('owner', 'admin')
        FOR UPDATE OF membership
      `;
      if (!access) return false;
      const [schedule] = await transaction`
        SELECT id
        FROM availability_schedules
        WHERE id = ${input.id}
          AND organization_id = ${input.organizationId}
        FOR UPDATE
      `;
      if (!schedule) return false;
      await transaction`
        UPDATE reps
        SET availability_schedule_id = NULL
        WHERE organization_id = ${input.organizationId}
          AND availability_schedule_id = ${input.id}
      `;
      const [deleted] = await transaction`
        DELETE FROM availability_schedules
        WHERE id = ${input.id}
          AND organization_id = ${input.organizationId}
        RETURNING id
      `;
      return Boolean(deleted);
    });
  }

  async updateOperatorRepWorkingHours(input: {
    organizationId: string;
    operatorId: string;
    repId: string;
    timezone: string;
    availability: PublicSchedule["reps"][number]["availability"];
    availabilityOverrides?: PublicSchedule["reps"][number]["availabilityOverrides"];
    availabilityScheduleId?: string | null;
    dailyMeetingLimit?: number | null;
    weeklyMeetingLimit?: number | null;
  }): Promise<boolean> {
    if (
      !uuidPattern.test(input.organizationId) ||
      !uuidPattern.test(input.operatorId) ||
      !uuidPattern.test(input.repId) ||
      (typeof input.availabilityScheduleId === "string" &&
        !uuidPattern.test(input.availabilityScheduleId))
    ) {
      return false;
    }
    return this.sql.begin(async (transaction) => {
      let availability = input.availability;
      if (input.availabilityScheduleId) {
        const [schedule] = await transaction`
          SELECT availability
          FROM availability_schedules
          WHERE id = ${input.availabilityScheduleId}
            AND organization_id = ${input.organizationId}
          FOR SHARE
        `;
        if (!schedule) return false;
        availability = schedule.availability as typeof availability;
      }
      const availabilityOverrides = input.availabilityOverrides ?? {};
      const [updated] = await transaction`
        UPDATE reps rep
        SET timezone = ${input.timezone},
            availability = ${transaction.json(availability as JSONValue)},
            availability_schedule_id = ${input.availabilityScheduleId ?? null},
            daily_meeting_limit = CASE
              WHEN ${input.dailyMeetingLimit !== undefined}
                THEN ${input.dailyMeetingLimit ?? null}
              ELSE daily_meeting_limit
            END,
            weekly_meeting_limit = CASE
              WHEN ${input.weeklyMeetingLimit !== undefined}
                THEN ${input.weeklyMeetingLimit ?? null}
              ELSE weekly_meeting_limit
            END,
            availability_overrides = CASE
              WHEN ${input.availabilityOverrides !== undefined}
                THEN ${transaction.json(availabilityOverrides as JSONValue)}
              ELSE availability_overrides
            END
        FROM organization_memberships membership
        JOIN operator_accounts account
          ON account.id = membership.operator_id
        WHERE rep.id = ${input.repId}
          AND rep.organization_id = ${input.organizationId}
          AND membership.organization_id = ${input.organizationId}
          AND membership.operator_id = ${input.operatorId}
          AND membership.active = true
          AND account.active = true
          AND (
            membership.role IN ('owner', 'admin')
            OR (
              rep.active = true
              AND lower(btrim(rep.email)) = account.login_normalized
              AND 1 = (
                SELECT count(*)
                FROM reps matching_rep
                WHERE matching_rep.organization_id = membership.organization_id
                  AND matching_rep.active = true
                  AND lower(btrim(matching_rep.email)) = account.login_normalized
              )
            )
          )
        RETURNING rep.id
      `;
      return Boolean(updated);
    });
  }

  async claimJob(): Promise<Job | null> {
    const [job] = await this.sql.begin(
      async (transaction) =>
        transaction`
        WITH next_job AS (
          SELECT id FROM jobs
          WHERE (status = 'pending' AND run_at <= now())
             OR (status = 'processing' AND locked_at < now() - interval '5 minutes')
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE jobs SET status = 'processing', locked_at = now(),
          claim_token = gen_random_uuid(), attempts = attempts + 1
        WHERE id = (SELECT id FROM next_job)
        RETURNING id, type, payload, attempts, claim_token
      `,
    );
    if (!job) return null;
    return {
      id: Number(job.id),
      type: String(job.type),
      payload: job.payload as Record<string, unknown>,
      attempts: Number(job.attempts),
      claimToken: String(job.claimToken),
    };
  }

  async applyCurrentOwnerWriteback(
    jobId: number,
    claimToken: string,
    write: () => Promise<{ externalReference: string }>,
  ): Promise<OwnerWritebackResult> {
    if (!uuidPattern.test(claimToken)) throw new Error("Invalid job claim.");
    return this.sql.begin(async (transaction) => {
      const [job] = await transaction`
        SELECT organization_id, lower(payload->>'leadEmail') AS lead_email
        FROM jobs WHERE id = ${jobId} AND type = 'crm.owner.writeback'
      `;
      if (!job?.leadEmail)
        throw new Error(`Owner writeback job ${jobId} was not found.`);

      // Hold this contact's lock through the provider call so an older write
      // cannot finish after a newer assignment has been written.
      await transaction`
        SELECT pg_advisory_xact_lock(
          hashtext(${`owner-writeback:${job.organizationId}:${job.leadEmail}`})
        )
      `;
      const [claimed] = await transaction`
        SELECT id FROM jobs
        WHERE id = ${jobId} AND status = 'processing'
          AND claim_token = ${claimToken}::uuid
      `;
      if (!claimed)
        throw new Error("Owner writeback job claim is no longer current.");

      const [latest] = await transaction`
        SELECT id FROM jobs
        WHERE organization_id = ${job.organizationId}
          AND type = 'crm.owner.writeback'
          AND lower(payload->>'leadEmail') = ${job.leadEmail}
        ORDER BY id DESC LIMIT 1
      `;
      if (Number(latest?.id) !== jobId) return { status: "superseded" };

      const result = await write();
      return {
        status: "completed",
        externalReference: result.externalReference,
      };
    });
  }

  async completeJob(
    id: number,
    claimToken: string,
    result?: Record<string, unknown>,
  ): Promise<boolean> {
    if (!uuidPattern.test(claimToken)) return false;
    return this.sql.begin(async (transaction) => {
      const [job] = await transaction`
        WITH claimed AS (
          SELECT id, type, payload, result AS previous_result, created_at,
                 attempts
          FROM jobs
          WHERE id = ${id} AND status = 'processing'
            AND claim_token = ${claimToken}::uuid
          FOR UPDATE
        ), completed AS (
          UPDATE jobs target
          SET status = CASE
                WHEN claimed.type = 'crm.owner.writeback'
                  AND ${result?.status === "superseded"}::boolean
                  THEN 'superseded'
                ELSE 'completed'
              END,
              completed_at = now(), locked_at = null,
              claim_token = null,
              result = ${result ? transaction.json(result as JSONValue) : null}
          FROM claimed
          WHERE target.id = claimed.id
          RETURNING claimed.id, claimed.type, claimed.payload,
                    claimed.previous_result, claimed.created_at,
                    claimed.attempts
        )
        SELECT * FROM completed
      `;
      if (!job) return false;

      const payload = job.payload as Record<string, unknown>;
      const bookingId = payload.bookingId ? String(payload.bookingId) : null;
      if (!bookingId) return true;

      if (job.type === createReconciliationJobType) {
        const [reconciliationBooking] = await transaction`
          SELECT id, rep_id, calendar_provider, calendar_external_account_id
          FROM bookings
          WHERE id = ${bookingId}
          FOR UPDATE
        `;
        if (!reconciliationBooking) {
          throw new Error("Calendar reconciliation booking not found.");
        }
        const calendarExternalAccountId =
          await requireMatchingBookingCalendarAccount(
            transaction,
            reconciliationBooking,
          );
        if (payload.calendarExternalAccountId !== calendarExternalAccountId) {
          throw new CalendarAccountIdentityError(
            "The reconciliation job does not match this booking's calendar account.",
          );
        }
        if (result?.found !== true && result?.found !== false) {
          throw new Error(
            "Calendar reconciliation returned an invalid result.",
          );
        }
        const intent =
          payload.reconciliationIntent === "close" ? "close" : "resolve";
        const originalCreateJobId = Number(payload.reconciliationForJobId);
        if (!Number.isSafeInteger(originalCreateJobId)) {
          throw new Error("Calendar reconciliation is missing its create job.");
        }

        if (result.found === false) {
          const previousResult = (job.previousResult ?? {}) as Record<
            string,
            unknown
          >;
          const priorNegativeChecks = Number(
            previousResult.negativeChecks ?? 0,
          );
          const previousCheckedAt =
            typeof previousResult.lastCheckedAt === "string"
              ? new Date(previousResult.lastCheckedAt)
              : null;
          const [released] =
            priorNegativeChecks >= 1 &&
            previousCheckedAt &&
            Number.isFinite(previousCheckedAt.getTime())
              ? await transaction`
                  UPDATE bookings
                  SET status = 'cancelled', cancelled_at = now(),
                      last_error = null, updated_at = now()
                  WHERE id = ${bookingId}
                    AND status = ${intent === "close" ? "cancel_pending" : "pending"}
                    AND ${new Date(String(job.createdAt))}::timestamptz <=
                      now() - (${providerAbsenceQuietPeriodMs}::bigint * interval '1 millisecond')
                    AND ${previousCheckedAt}::timestamptz <=
                      now() - (${providerAbsenceCheckSeparationMs}::bigint * interval '1 millisecond')
                  RETURNING id
                `
              : [];
          if (!released) {
            await transaction`
              UPDATE jobs
              SET status = 'pending', completed_at = null,
                  run_at = greatest(
                    ${new Date(String(job.createdAt))}::timestamptz +
                      (${providerAbsenceQuietPeriodMs}::bigint * interval '1 millisecond'),
                    now() + (${providerAbsenceCheckSeparationMs}::bigint * interval '1 millisecond')
                  ),
                  result = jsonb_build_object(
                    'negativeChecks', ${Math.max(0, priorNegativeChecks) + 1}::int,
                    'lastCheckedAt', now()
                  )
              WHERE id = ${id} AND status = 'completed'
            `;
            return true;
          }
          if (intent === "resolve") {
            await transaction`
              UPDATE jobs
              SET result = jsonb_build_object('reconciledAbsent', true)
              WHERE id = ${originalCreateJobId}
                AND type = 'calendar.event.create'
                AND status IN ('failed', 'cancelled')
            `;
          }
          return true;
        }

        const externalEventId = String(result.externalEventId ?? "");
        const webLink = result.webLink ? String(result.webLink) : null;
        const conferenceUrl = result.conferenceUrl
          ? String(result.conferenceUrl)
          : null;
        if (
          externalEventId.length === 0 ||
          externalEventId.length > 2_048 ||
          externalEventId !== externalEventId.trim() ||
          [externalEventId, webLink, conferenceUrl].some(
            (value) =>
              value !== null &&
              (value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)),
          )
        ) {
          throw new Error(
            "Calendar reconciliation returned invalid provider evidence.",
          );
        }

        const [reconciled] = await transaction`
          UPDATE bookings
          SET status = ${intent === "close" ? "cancel_pending" : "confirmed"},
              external_event_id = ${externalEventId},
              external_event_web_link = coalesce(
                ${webLink}, external_event_web_link
              ),
              conference_url = coalesce(${conferenceUrl}, conference_url),
              last_error = CASE
                WHEN ${intent === "close"}::boolean THEN last_error
                ELSE null
              END,
              updated_at = now()
          WHERE id = ${bookingId}
            AND status = ${intent === "close" ? "cancel_pending" : "pending"}
            AND (external_event_id IS NULL OR external_event_id = ${externalEventId})
          RETURNING id, ends_at > now() AS notification_relevant
        `;
        if (!reconciled) {
          throw new Error(
            "Calendar reconciliation conflicted with the booking ledger.",
          );
        }

        if (intent === "close") {
          await transaction`
            INSERT INTO jobs (organization_id, type, payload)
            SELECT b.organization_id, 'calendar.event.cancel',
                   ${transaction.json({
                     bookingId,
                     externalId: String(payload.externalId),
                     externalEventId,
                     organizationSlug: String(payload.organizationSlug),
                     repId: String(payload.repId),
                     provider: String(payload.provider),
                     calendarExternalAccountId,
                     suppressLifecycleEmail: true,
                   } as JSONValue)}
            FROM bookings b
            WHERE b.id = ${bookingId}
              AND NOT EXISTS (
                SELECT 1 FROM jobs active_cancel
                WHERE active_cancel.type = 'calendar.event.cancel'
                  AND active_cancel.payload->>'bookingId' = ${bookingId}
                  AND active_cancel.status IN ('pending', 'processing')
              )
          `;
        } else {
          await transaction`
            UPDATE jobs
            SET status = 'completed', completed_at = now(), last_error = null,
                result = ${transaction.json({
                  externalEventId,
                  webLink,
                  conferenceUrl,
                } as JSONValue)}
            WHERE id = ${originalCreateJobId}
              AND type = 'calendar.event.create'
              AND status IN ('failed', 'cancelled')
          `;
          await enqueueConfirmedCohostRoleWriteback(
            transaction,
            bookingId,
            payload,
          );
          if (Boolean(reconciled.notificationRelevant)) {
            await this.enqueueBookingMessages(
              transaction,
              bookingId,
              "email.booking.confirmation",
              Number(payload.reminderMinutes ?? 0),
            );
          }
        }
      } else if (job.type === "calendar.event.create") {
        await transaction`
          UPDATE bookings SET status = 'confirmed',
            external_event_id = ${String(result?.externalEventId ?? "")},
            external_event_web_link = ${result?.webLink ? String(result.webLink) : null},
            conference_url = coalesce(
              ${result?.conferenceUrl ? String(result.conferenceUrl) : null},
              conference_url
            ),
            last_error = null, updated_at = now()
          WHERE id = ${bookingId}
        `;
        await enqueueConfirmedCohostRoleWriteback(
          transaction,
          bookingId,
          payload,
        );
        await this.enqueueBookingMessages(
          transaction,
          bookingId,
          "email.booking.confirmation",
          Number(payload.reminderMinutes ?? 0),
        );
      } else if (job.type === "calendar.event.update") {
        await transaction`
          UPDATE bookings SET status = 'confirmed',
            previous_starts_at = null, previous_ends_at = null,
            external_event_web_link = coalesce(
              ${result?.webLink ? String(result.webLink) : null},
              external_event_web_link
            ),
            conference_url = coalesce(
              ${result?.conferenceUrl ? String(result.conferenceUrl) : null},
              conference_url
            ),
            last_error = null, updated_at = now()
          WHERE id = ${bookingId}
        `;
        await this.enqueueBookingMessages(
          transaction,
          bookingId,
          "email.booking.rescheduled",
          Number(payload.reminderMinutes ?? 0),
        );
      } else if (job.type === "calendar.event.cancel") {
        await transaction`
          UPDATE bookings SET status = 'cancelled', cancelled_at = now(),
            previous_starts_at = null, previous_ends_at = null,
            last_error = null, updated_at = now()
          WHERE id = ${bookingId}
        `;
        if (payload.suppressLifecycleEmail !== true) {
          await this.enqueueBookingMessages(
            transaction,
            bookingId,
            "email.booking.cancelled",
            0,
          );
        }
      }
      return true;
    });
  }

  async failJob(
    id: number,
    claimToken: string,
    error: string,
  ): Promise<boolean> {
    if (!uuidPattern.test(claimToken)) return false;
    return this.sql.begin(async (transaction) => {
      const [job] = await transaction`
        UPDATE jobs SET
          status = CASE
            WHEN type = ${createReconciliationJobType} THEN 'pending'
            WHEN attempts >= 5 THEN 'failed'
            ELSE 'pending'
          END,
          run_at = now() + CASE
            WHEN type = ${createReconciliationJobType} THEN least(
              interval '5 minutes',
              interval '10 seconds' * greatest(attempts, 1)
            )
            ELSE interval '10 seconds' * greatest(attempts, 1)
          END,
          locked_at = null,
          claim_token = null,
          last_error = ${error}
        WHERE id = ${id} AND status = 'processing'
          AND claim_token = ${claimToken}::uuid
        RETURNING organization_id, type, payload, attempts, status
      `;
      if (!job) return false;
      const exhausted = job.status === "failed";

      if (!exhausted) return true;
      const payload = job.payload as Record<string, unknown>;
      const bookingId = payload.bookingId ? String(payload.bookingId) : null;
      if (!bookingId) return true;
      if (job.type === "calendar.event.create") {
        const [booking] = await transaction`
          UPDATE bookings SET status = 'pending', last_error = null,
            updated_at = now()
          WHERE id = ${bookingId}
          RETURNING id
        `;
        if (!booking) return true;
        await transaction`
          INSERT INTO jobs (organization_id, type, payload, run_at)
          VALUES (
            ${job.organizationId}, ${createReconciliationJobType},
            ${transaction.json({
              ...payload,
              reconciliationForJobId: id,
              reconciliationIntent: "resolve",
            } as JSONValue)},
            now() + interval '5 seconds'
          )
        `;
      } else if (job.type === "calendar.event.update") {
        await transaction`
          UPDATE bookings SET status = 'reschedule_pending',
            last_error = ${error}, updated_at = now()
          WHERE id = ${bookingId} AND status = 'reschedule_pending'
        `;
      } else if (job.type === "calendar.event.cancel") {
        if (payload.cancelsUncertainReschedule === true) {
          const uncertainRescheduleJobId = Number(
            payload.uncertainRescheduleJobId,
          );
          if (Number.isSafeInteger(uncertainRescheduleJobId)) {
            await transaction`
              UPDATE jobs
              SET status = 'failed'
              WHERE id = ${uncertainRescheduleJobId}
                AND type = 'calendar.event.update'
                AND status = 'cancelled'
                AND payload->>'bookingId' = ${bookingId}
            `;
          }
          await transaction`
            UPDATE bookings SET status = 'reschedule_pending',
              last_error = ${error}, updated_at = now()
            WHERE id = ${bookingId}
          `;
        } else {
          await transaction`
            UPDATE bookings SET status = 'confirmed', last_error = ${error},
              updated_at = now() WHERE id = ${bookingId}
          `;
        }
      }
      return true;
    });
  }

  private async enqueueBookingMessages(
    transaction: TransactionSql,
    bookingId: string,
    messageType:
      | "email.booking.confirmation"
      | "email.booking.rescheduled"
      | "email.booking.cancelled",
    reminderMinutes: number,
  ): Promise<void> {
    const [booking] = await transaction`
      SELECT b.id, b.external_id, b.attendee_name, b.attendee_email,
             b.manage_token_hash,
             b.attendee_notifications_enabled,
             b.starts_at, b.ends_at, b.conference_url,
             o.name AS organization_name, o.slug AS organization_slug,
             mt.title AS meeting_title, r.name AS rep_name, r.timezone
      FROM bookings b
      JOIN organizations o ON o.id = b.organization_id
      JOIN meeting_types mt ON mt.id = b.meeting_type_id
      JOIN reps r ON r.id = b.rep_id
      WHERE b.id = ${bookingId}
    `;
    if (!booking) return;

    await transaction`
      UPDATE jobs SET status = 'cancelled', completed_at = now(), locked_at = null
      WHERE type = 'email.booking.reminder'
        AND payload->>'bookingId' = ${bookingId}
        AND status = 'pending'
    `;

    if (!Boolean(booking.attendeeNotificationsEnabled)) return;

    const messagePayload = {
      bookingId,
      to: String(booking.attendeeEmail),
      attendeeName: String(booking.attendeeName),
      organizationName: String(booking.organizationName),
      organizationSlug: String(booking.organizationSlug),
      meetingTitle: String(booking.meetingTitle),
      repName: String(booking.repName),
      timezone: String(booking.timezone),
      startsAt: new Date(String(booking.startsAt)).toISOString(),
      endsAt: new Date(String(booking.endsAt)).toISOString(),
      conferenceUrl: booking.conferenceUrl
        ? String(booking.conferenceUrl)
        : null,
      managePath: safeManagePathFromRow(booking),
    };
    await transaction`
      INSERT INTO jobs (organization_id, type, payload)
      SELECT b.organization_id, ${messageType},
             ${transaction.json(messagePayload as JSONValue)}
      FROM bookings b WHERE b.id = ${bookingId}
    `;

    if (messageType === "email.booking.cancelled" || reminderMinutes <= 0) {
      return;
    }
    const reminderAt = new Date(
      new Date(String(booking.startsAt)).getTime() - reminderMinutes * 60_000,
    );
    if (reminderAt.getTime() <= Date.now() + 60_000) return;
    await transaction`
      INSERT INTO jobs (organization_id, type, payload, run_at)
      SELECT b.organization_id, 'email.booking.reminder',
             ${transaction.json(messagePayload as JSONValue)}, ${reminderAt}
      FROM bookings b WHERE b.id = ${bookingId}
      ON CONFLICT DO NOTHING
    `;
  }

  async getOAuthConnection(
    organizationSlug: string,
    provider: OAuthProvider,
  ): Promise<OAuthConnection | null> {
    const [row] = await this.sql`
      SELECT o.slug AS organization_slug, c.provider, c.encrypted_access_token,
             c.encrypted_refresh_token, c.expires_at, c.scopes,
             c.external_account_id, c.external_account_name, c.metadata, c.updated_at
      FROM oauth_connections c
      JOIN organizations o ON o.id = c.organization_id
      WHERE o.slug = ${organizationSlug} AND c.provider = ${provider}
    `;
    if (!row) return null;
    return {
      organizationSlug: String(row.organizationSlug),
      provider: row.provider as OAuthProvider,
      encryptedAccessToken: String(row.encryptedAccessToken),
      encryptedRefreshToken: String(row.encryptedRefreshToken),
      expiresAt: new Date(String(row.expiresAt)),
      scopes: row.scopes as string[],
      externalAccountId: row.externalAccountId
        ? String(row.externalAccountId)
        : null,
      externalAccountName: row.externalAccountName
        ? String(row.externalAccountName)
        : null,
      metadata: row.metadata as Record<string, unknown>,
      updatedAt: new Date(String(row.updatedAt)),
    };
  }

  async saveOAuthConnection(
    connection: SaveOAuthConnection,
    options: {
      expectedExternalAccountId?: string | null;
      expectedEncryptedRefreshToken?: string;
    } = {},
  ): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const [organization] = await transaction`
        SELECT id FROM organizations
        WHERE slug = ${connection.organizationSlug}
        FOR UPDATE
      `;
      if (!organization) {
        throw new Error(`Unknown organization: ${connection.organizationSlug}`);
      }
      const [existing] = await transaction`
        SELECT external_account_id, encrypted_refresh_token
        FROM oauth_connections
        WHERE organization_id = ${organization.id}
          AND provider = ${connection.provider}
        FOR UPDATE
      `;
      const guardsExistingConnection =
        Object.prototype.hasOwnProperty.call(
          options,
          "expectedExternalAccountId",
        ) ||
        Object.prototype.hasOwnProperty.call(
          options,
          "expectedEncryptedRefreshToken",
        );
      if (
        guardsExistingConnection &&
        (!existing ||
          (Object.prototype.hasOwnProperty.call(
            options,
            "expectedExternalAccountId",
          ) &&
            (existing.externalAccountId
              ? String(existing.externalAccountId)
              : null) !== options.expectedExternalAccountId) ||
          (Object.prototype.hasOwnProperty.call(
            options,
            "expectedEncryptedRefreshToken",
          ) &&
            String(existing.encryptedRefreshToken) !==
              options.expectedEncryptedRefreshToken))
      ) {
        throw new OAuthConnectionConflictError();
      }

      await transaction`
        INSERT INTO oauth_connections (
          organization_id, provider, encrypted_access_token, encrypted_refresh_token,
          expires_at, scopes, external_account_id, external_account_name, metadata
        ) VALUES (
          ${organization.id}, ${connection.provider}, ${connection.encryptedAccessToken},
          ${connection.encryptedRefreshToken}, ${connection.expiresAt},
          ${connection.scopes}, ${connection.externalAccountId},
          ${connection.externalAccountName},
          ${transaction.json(connection.metadata as JSONValue)}
        )
        ON CONFLICT (organization_id, provider) DO UPDATE SET
          encrypted_access_token = EXCLUDED.encrypted_access_token,
          encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
          expires_at = EXCLUDED.expires_at,
          scopes = EXCLUDED.scopes,
          external_account_id = EXCLUDED.external_account_id,
          external_account_name = EXCLUDED.external_account_name,
          metadata = EXCLUDED.metadata,
          updated_at = now()
      `;
    });
  }

  async repExists(organizationSlug: string, repId: string): Promise<boolean> {
    const [rep] = await this.sql`
      SELECT 1
      FROM reps r
      JOIN organizations o ON o.id = r.organization_id
      WHERE o.slug = ${organizationSlug} AND r.id = ${repId}
    `;
    return Boolean(rep);
  }

  async getRepCalendarConnection(
    organizationSlug: string,
    repId: string,
    provider: CalendarOAuthProvider,
  ): Promise<RepCalendarConnection | null> {
    const [row] = await this.sql`
      SELECT o.slug AS organization_slug, c.rep_id, c.provider,
             c.encrypted_access_token, c.encrypted_refresh_token, c.expires_at,
             c.scopes, c.external_account_id, c.external_account_name,
             c.metadata, c.check_conflicts, c.calendar_catalog_synced_at,
             c.calendar_catalog_error, c.updated_at
      FROM rep_calendar_connections c
      JOIN reps r ON r.id = c.rep_id
      JOIN organizations o ON o.id = r.organization_id
      WHERE o.slug = ${organizationSlug} AND c.rep_id = ${repId}
        AND c.provider = ${provider}
    `;
    if (!row) return null;
    return {
      organizationSlug: String(row.organizationSlug),
      repId: String(row.repId),
      provider: row.provider as CalendarOAuthProvider,
      encryptedAccessToken: String(row.encryptedAccessToken),
      encryptedRefreshToken: String(row.encryptedRefreshToken),
      expiresAt: new Date(String(row.expiresAt)),
      scopes: row.scopes as string[],
      externalAccountId: row.externalAccountId
        ? String(row.externalAccountId)
        : null,
      externalAccountName: row.externalAccountName
        ? String(row.externalAccountName)
        : null,
      metadata: row.metadata as Record<string, unknown>,
      checkConflicts: Boolean(row.checkConflicts),
      calendarCatalogSyncedAt: row.calendarCatalogSyncedAt
        ? new Date(String(row.calendarCatalogSyncedAt))
        : null,
      calendarCatalogError: row.calendarCatalogError
        ? String(row.calendarCatalogError)
        : null,
      updatedAt: new Date(String(row.updatedAt)),
    };
  }

  async saveRepCalendarConnection(
    connection: SaveRepCalendarConnection,
    options: {
      preserveCalendarSources?: boolean;
      expectedExternalAccountId?: string | null;
      expectedEncryptedRefreshToken?: string;
    } = {},
  ): Promise<void> {
    try {
      await this.sql.begin(async (transaction) => {
        await transaction`
        SELECT pg_advisory_xact_lock(hashtext(${connection.repId}))
      `;
        const [rep] = await transaction`
        SELECT r.id
        FROM reps r
        JOIN organizations o ON o.id = r.organization_id
        WHERE o.slug = ${connection.organizationSlug} AND r.id = ${connection.repId}
        FOR UPDATE OF r
      `;
        if (!rep) {
          throw new Error(`Unknown representative: ${connection.repId}`);
        }
        const [existing] = await transaction`
        SELECT external_account_id, encrypted_refresh_token
        FROM rep_calendar_connections
        WHERE rep_id = ${connection.repId} AND provider = ${connection.provider}
        FOR UPDATE
      `;
        const guardsExistingConnection =
          Object.prototype.hasOwnProperty.call(
            options,
            "expectedExternalAccountId",
          ) ||
          Object.prototype.hasOwnProperty.call(
            options,
            "expectedEncryptedRefreshToken",
          );
        const storedExternalAccountId = existing?.externalAccountId
          ? String(existing.externalAccountId)
          : null;
        if (
          guardsExistingConnection &&
          (!existing ||
            (Object.prototype.hasOwnProperty.call(
              options,
              "expectedExternalAccountId",
            ) &&
              storedExternalAccountId !== options.expectedExternalAccountId) ||
            (Object.prototype.hasOwnProperty.call(
              options,
              "expectedEncryptedRefreshToken",
            ) &&
              String(existing.encryptedRefreshToken) !==
                options.expectedEncryptedRefreshToken))
        ) {
          throw new CalendarAccountIdentityError(
            "The calendar connection changed while its credentials were refreshing.",
          );
        }
        const sameVerifiedAccount = Boolean(
          existing?.externalAccountId &&
            connection.externalAccountId &&
            String(existing.externalAccountId) === connection.externalAccountId,
        );
        const accountChanged = Boolean(existing && !sameVerifiedAccount);
        if (accountChanged && storedExternalAccountId) {
          const [activeBooking] = await transaction`
          SELECT id
          FROM bookings
          WHERE rep_id = ${connection.repId}
            AND calendar_provider = ${connection.provider}
            AND (
              calendar_external_account_id = ${storedExternalAccountId}
              OR calendar_external_account_id IS NULL
            )
            AND status IN (
              'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
            )
            AND greatest(
              ends_at,
              coalesce(previous_ends_at, ends_at)
            ) > now()
          LIMIT 1
          FOR UPDATE
        `;
          if (activeBooking) {
            throw new CalendarAccountIdentityError(
              "This calendar connection still has a future or unresolved booking. Prove its original account or reconcile it before reconnecting a different account.",
            );
          }
        }

        await transaction`
        INSERT INTO rep_calendar_connections (
          rep_id, provider, encrypted_access_token, encrypted_refresh_token,
          expires_at, scopes, external_account_id, external_account_name, metadata
        ) VALUES (
          ${connection.repId}, ${connection.provider},
          ${connection.encryptedAccessToken}, ${connection.encryptedRefreshToken},
          ${connection.expiresAt}, ${connection.scopes},
          ${connection.externalAccountId}, ${connection.externalAccountName},
          ${transaction.json(connection.metadata as JSONValue)}
        )
        ON CONFLICT (rep_id, provider) DO UPDATE SET
          encrypted_access_token = EXCLUDED.encrypted_access_token,
          encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
          expires_at = EXCLUDED.expires_at,
          scopes = EXCLUDED.scopes,
          external_account_id = EXCLUDED.external_account_id,
          external_account_name = EXCLUDED.external_account_name,
          metadata = EXCLUDED.metadata,
          check_conflicts = CASE
            WHEN ${accountChanged} THEN true
            ELSE rep_calendar_connections.check_conflicts
          END,
          calendar_catalog_synced_at = CASE
            WHEN ${accountChanged} THEN NULL
            ELSE rep_calendar_connections.calendar_catalog_synced_at
          END,
          calendar_catalog_error = CASE
            WHEN ${accountChanged} THEN NULL
            ELSE rep_calendar_connections.calendar_catalog_error
          END,
          updated_at = now()
      `;

        if (accountChanged) {
          await transaction`
          DELETE FROM rep_calendar_sources
          WHERE rep_id = ${connection.repId} AND provider = ${connection.provider}
        `;
        }
        await transaction`
        INSERT INTO rep_calendar_sources (
          rep_id, provider, provider_calendar_id, display_name,
          is_provider_default, selected_for_conflicts
        ) VALUES (
          ${connection.repId}, ${connection.provider},
          ${defaultCalendarId(connection.provider)},
          ${fallbackCalendarName(connection.provider)}, true, true
        )
        ON CONFLICT (rep_id, provider, provider_calendar_id) DO NOTHING
      `;
      });
    } catch (error) {
      const databaseError = error as { code?: string };
      if (databaseError.code === "23505") {
        throw new CalendarAccountIdentityError(
          "This provider account is already connected to another representative.",
        );
      }
      throw error;
    }
  }

  async getActiveRepCalendarProvider(
    organizationSlug: string,
    repId: string,
  ): Promise<CalendarOAuthProvider | null> {
    const [row] = await this.sql`
      SELECT r.active_calendar_provider
      FROM reps r
      JOIN organizations o ON o.id = r.organization_id
      WHERE o.slug = ${organizationSlug} AND r.id = ${repId}
    `;
    return row?.activeCalendarProvider
      ? (String(row.activeCalendarProvider) as CalendarOAuthProvider)
      : null;
  }

  async setActiveRepCalendarProvider(
    organizationSlug: string,
    repId: string,
    provider: CalendarOAuthProvider,
  ): Promise<void> {
    await this.updateRepCalendarSettings({
      organizationSlug,
      repId,
      provider,
      makeActive: true,
    });
  }

  async repCalendarSettings(
    organizationSlug: string,
    repId: string,
    provider: CalendarOAuthProvider,
  ) {
    const [row] = await this.sql`
      SELECT c.external_account_name, c.scopes,
             c.calendar_catalog_synced_at, c.calendar_catalog_error,
             coalesce((
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'calendarId', source.provider_calendar_id,
                   'name', source.display_name,
                   'isDefault', source.is_provider_default,
                   'selected', source.selected_for_conflicts,
                   'available', source.missing_since IS NULL,
                   'lastSeenAt', source.last_seen_at,
                   'missingSince', source.missing_since
                 )
                 ORDER BY source.is_provider_default DESC,
                          source.display_name, source.provider_calendar_id
               )
               FROM rep_calendar_sources source
               WHERE source.rep_id = c.rep_id AND source.provider = c.provider
             ), '[]'::jsonb) AS calendars
      FROM rep_calendar_connections c
      JOIN reps r ON r.id = c.rep_id
      JOIN organizations o ON o.id = r.organization_id
      WHERE o.slug = ${organizationSlug} AND c.rep_id = ${repId}
        AND c.provider = ${provider}
    `;
    if (!row) return null;
    const calendars = calendarSourcesFromValue(row.calendars);
    return {
      connected: true,
      accountName: row.externalAccountName
        ? String(row.externalAccountName)
        : null,
      checkConflicts: calendars.some((calendar) => calendar.selected),
      canSyncCalendars:
        provider === "microsoft" ||
        (Array.isArray(row.scopes) &&
          row.scopes.includes(googleCalendarListScope)),
      calendarCatalogSyncedAt: row.calendarCatalogSyncedAt
        ? new Date(String(row.calendarCatalogSyncedAt)).toISOString()
        : null,
      calendarCatalogError: row.calendarCatalogError
        ? String(row.calendarCatalogError)
        : null,
      calendars,
    };
  }

  async syncRepCalendarSources(input: {
    organizationSlug: string;
    repId: string;
    provider: CalendarOAuthProvider;
    calendars: Array<{ id: string; name: string; isDefault: boolean }>;
  }): Promise<void> {
    if (input.calendars.length < 1 || input.calendars.length > 1_000) {
      throw new Error(
        "Calendar discovery returned an invalid number of calendars.",
      );
    }
    const calendars = input.calendars.map((calendar) => ({
      id: normalizeCalendarId(calendar.id),
      name: normalizeCalendarName(calendar.name),
      isDefault: Boolean(calendar.isDefault),
    }));
    if (
      new Set(calendars.map((calendar) => calendar.id)).size !==
      calendars.length
    ) {
      throw new Error("Calendar discovery returned duplicate identifiers.");
    }
    const defaults = calendars.filter((calendar) => calendar.isDefault);
    if (
      defaults.length !== 1 ||
      defaults[0]!.id !== defaultCalendarId(input.provider)
    ) {
      throw new Error(
        "Calendar discovery must return exactly one default calendar.",
      );
    }

    await this.sql.begin(async (transaction) => {
      const [connection] = await transaction`
        SELECT c.rep_id, r.active_calendar_provider
        FROM rep_calendar_connections c
        JOIN reps r ON r.id = c.rep_id
        JOIN organizations o ON o.id = r.organization_id
        WHERE o.slug = ${input.organizationSlug} AND c.rep_id = ${input.repId}
          AND c.provider = ${input.provider}
        FOR UPDATE OF c, r
      `;
      if (!connection) {
        throw new Error(
          `Calendar connection not found for representative: ${input.repId}`,
        );
      }
      const defaultMustStaySelected =
        connection.activeCalendarProvider === input.provider;

      await transaction`
        UPDATE rep_calendar_sources
        SET missing_since = coalesce(missing_since, now()), updated_at = now()
        WHERE rep_id = ${input.repId} AND provider = ${input.provider}
      `;
      for (const calendar of calendars) {
        await transaction`
          INSERT INTO rep_calendar_sources (
            rep_id, provider, provider_calendar_id, display_name,
            is_provider_default, selected_for_conflicts, last_seen_at,
            missing_since
          ) VALUES (
            ${input.repId}, ${input.provider}, ${calendar.id}, ${calendar.name},
            ${calendar.isDefault},
            ${calendar.isDefault && defaultMustStaySelected}, now(), NULL
          )
          ON CONFLICT (rep_id, provider, provider_calendar_id) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            is_provider_default = EXCLUDED.is_provider_default,
            selected_for_conflicts = CASE
              WHEN EXCLUDED.is_provider_default AND ${defaultMustStaySelected}
                THEN true
              ELSE rep_calendar_sources.selected_for_conflicts
            END,
            last_seen_at = now(), missing_since = NULL, updated_at = now()
        `;
      }
      await transaction`
        UPDATE rep_calendar_connections connection
        SET calendar_catalog_synced_at = now(), calendar_catalog_error = NULL,
            check_conflicts = EXISTS (
              SELECT 1 FROM rep_calendar_sources source
              WHERE source.rep_id = connection.rep_id
                AND source.provider = connection.provider
                AND source.selected_for_conflicts
            ),
            updated_at = now()
        WHERE connection.rep_id = ${input.repId}
          AND connection.provider = ${input.provider}
      `;
    });
  }

  async recordRepCalendarCatalogError(input: {
    organizationSlug: string;
    repId: string;
    provider: CalendarOAuthProvider;
    message: string;
  }): Promise<void> {
    const message = input.message.trim().slice(0, 500);
    await this.sql`
      UPDATE rep_calendar_connections connection
      SET calendar_catalog_error = ${message || "Calendar refresh failed."},
          updated_at = now()
      FROM reps rep, organizations organization
      WHERE connection.rep_id = rep.id
        AND rep.organization_id = organization.id
        AND organization.slug = ${input.organizationSlug}
        AND connection.rep_id = ${input.repId}
        AND connection.provider = ${input.provider}
    `;
  }

  async updateRepCalendarSettings(input: {
    organizationSlug: string;
    repId: string;
    provider: CalendarOAuthProvider;
    checkConflicts?: boolean;
    selectedCalendarIds?: string[];
    makeActive?: boolean;
  }): Promise<void> {
    if (
      input.checkConflicts !== undefined &&
      input.selectedCalendarIds !== undefined
    ) {
      throw new Error(
        "Use selectedCalendarIds instead of the provider-level conflict setting.",
      );
    }
    const selectedCalendarIds =
      input.selectedCalendarIds?.map(normalizeCalendarId);
    if (
      selectedCalendarIds &&
      (selectedCalendarIds.length > maxSelectedConflictCalendars ||
        new Set(selectedCalendarIds).size !== selectedCalendarIds.length)
    ) {
      throw new Error(
        `Select no more than ${maxSelectedConflictCalendars} unique calendars.`,
      );
    }

    await this.sql.begin(async (transaction) => {
      const [connection] = await transaction`
        SELECT r.id AS rep_id, r.active_calendar_provider, c.check_conflicts
        FROM reps r
        JOIN organizations o ON o.id = r.organization_id
        JOIN rep_calendar_connections c
          ON c.rep_id = r.id AND c.provider = ${input.provider}
        WHERE o.slug = ${input.organizationSlug} AND r.id = ${input.repId}
        FOR UPDATE OF r, c
      `;
      if (!connection) {
        throw new Error(
          `Calendar connection not found for representative: ${input.repId}`,
        );
      }

      const activeProvider = connection.activeCalendarProvider
        ? (String(connection.activeCalendarProvider) as CalendarOAuthProvider)
        : null;
      const sources = await transaction`
        SELECT provider_calendar_id, is_provider_default,
               selected_for_conflicts, missing_since
        FROM rep_calendar_sources
        WHERE rep_id = ${input.repId} AND provider = ${input.provider}
        FOR UPDATE
      `;
      const defaultSource = sources.find((source) => source.isProviderDefault);
      if (!defaultSource) {
        throw new Error("The calendar connection has no default calendar.");
      }
      if (
        input.checkConflicts === false &&
        (input.makeActive || activeProvider === input.provider)
      ) {
        throw new Error("The active calendar must be checked for conflicts.");
      }

      if (selectedCalendarIds) {
        const known = new Map(
          sources.map((source) => [String(source.providerCalendarId), source]),
        );
        for (const calendarId of selectedCalendarIds) {
          const source = known.get(calendarId);
          if (!source) {
            throw new Error(
              "One or more selected calendars are not available.",
            );
          }
          if (source.missingSince && !source.selectedForConflicts) {
            throw new Error("A missing calendar cannot be newly selected.");
          }
        }
        const requiresDefault =
          Boolean(input.makeActive) || activeProvider === input.provider;
        if (
          requiresDefault &&
          !selectedCalendarIds.includes(
            String(defaultSource.providerCalendarId),
          )
        ) {
          throw new Error("The active calendar must be checked for conflicts.");
        }
        await transaction`
          UPDATE rep_calendar_sources
          SET selected_for_conflicts =
                provider_calendar_id = ANY(${selectedCalendarIds}::text[]),
              updated_at = now()
          WHERE rep_id = ${input.repId} AND provider = ${input.provider}
        `;
      } else if (input.checkConflicts === false) {
        await transaction`
          UPDATE rep_calendar_sources
          SET selected_for_conflicts = false, updated_at = now()
          WHERE rep_id = ${input.repId} AND provider = ${input.provider}
        `;
      } else if (input.checkConflicts === true) {
        await transaction`
          UPDATE rep_calendar_sources
          SET selected_for_conflicts = true, updated_at = now()
          WHERE rep_id = ${input.repId} AND provider = ${input.provider}
            AND is_provider_default
        `;
      }

      if (input.makeActive) {
        if (defaultSource.missingSince) {
          throw new Error(
            "Refresh or reconnect this provider before using it for bookings.",
          );
        }
        await transaction`
          UPDATE rep_calendar_sources
          SET selected_for_conflicts = true, updated_at = now()
          WHERE rep_id = ${input.repId} AND provider = ${input.provider}
            AND is_provider_default
        `;
        await transaction`
          UPDATE reps SET active_calendar_provider = ${input.provider}
          WHERE id = ${input.repId}
        `;
      }
      await transaction`
        UPDATE rep_calendar_connections connection
        SET check_conflicts = EXISTS (
              SELECT 1 FROM rep_calendar_sources source
              WHERE source.rep_id = connection.rep_id
                AND source.provider = connection.provider
                AND source.selected_for_conflicts
            ),
            updated_at = now()
        WHERE connection.rep_id = ${input.repId}
          AND connection.provider = ${input.provider}
      `;
    });
  }

  async connectedRepCalendarIds(
    organizationSlug: string,
    provider: CalendarOAuthProvider,
    repIds: string[],
  ): Promise<Set<string>> {
    if (repIds.length === 0) return new Set();
    const rows = await this.sql`
      SELECT c.rep_id
      FROM rep_calendar_connections c
      JOIN reps r ON r.id = c.rep_id
      JOIN organizations o ON o.id = r.organization_id
      WHERE o.slug = ${organizationSlug} AND c.provider = ${provider}
        AND c.rep_id = ANY(${repIds}::uuid[])
    `;
    return new Set(rows.map((row) => String(row.repId)));
  }

  async repCalendarProviders(
    organizationSlug: string,
    repIds: string[],
  ): Promise<Map<string, CalendarOAuthProvider>> {
    if (repIds.length === 0) return new Map();
    const rows = await this.sql`
      SELECT c.rep_id, c.provider
      FROM rep_calendar_connections c
      JOIN reps r ON r.id = c.rep_id
      JOIN organizations o ON o.id = r.organization_id
      WHERE o.slug = ${organizationSlug}
        AND c.rep_id = ANY(${repIds}::uuid[])
        AND c.provider = r.active_calendar_provider
    `;
    return new Map(
      rows.map((row) => [
        String(row.repId),
        row.provider as CalendarOAuthProvider,
      ]),
    );
  }

  async repAvailabilityCalendarProviders(
    organizationSlug: string,
    repIds: string[],
  ): Promise<Map<string, CalendarOAuthProvider[]>> {
    const sources = await this.repAvailabilityCalendarSources(
      organizationSlug,
      repIds,
    );
    return new Map(
      [...sources].map(([repId, calendars]) => [
        repId,
        [...new Set(calendars.map((calendar) => calendar.provider))],
      ]),
    );
  }

  async repAvailabilityCalendarSources(
    organizationSlug: string,
    repIds: string[],
  ): Promise<Map<string, CalendarConflictSource[]>> {
    if (repIds.length === 0) return new Map();
    const rows = await this.sql`
      SELECT source.rep_id, source.provider, source.provider_calendar_id,
             connection.external_account_id,
             source.missing_since IS NULL AS available
      FROM rep_calendar_sources source
      JOIN rep_calendar_connections connection
        ON connection.rep_id = source.rep_id
       AND connection.provider = source.provider
      JOIN reps r ON r.id = source.rep_id
      JOIN organizations o ON o.id = r.organization_id
      WHERE o.slug = ${organizationSlug}
        AND source.rep_id = ANY(${repIds}::uuid[])
        AND source.selected_for_conflicts
      ORDER BY source.rep_id,
               (source.provider = r.active_calendar_provider) DESC,
               source.is_provider_default DESC,
               source.provider, source.provider_calendar_id
    `;
    const calendars = new Map<string, CalendarConflictSource[]>();
    for (const row of rows) {
      const repId = String(row.repId);
      const selected = calendars.get(repId) ?? [];
      const calendarExternalAccountId = verifiedCalendarExternalAccountId(
        row.externalAccountId,
      );
      if (!calendarExternalAccountId) {
        throw new CalendarAccountIdentityError(
          "A selected conflict calendar has no verified account identity.",
        );
      }
      selected.push({
        provider: row.provider as CalendarOAuthProvider,
        calendarExternalAccountId,
        calendarId: String(row.providerCalendarId),
        available: Boolean(row.available),
      });
      calendars.set(repId, selected);
    }
    return calendars;
  }

  async activeBookingIntervals(
    organizationSlug: string,
    repIds: string[],
    startsAt: Date,
    endsAt: Date,
    excludeExternalId?: string,
  ): Promise<Map<string, Array<{ startsAt: Date; endsAt: Date }>>> {
    const intervals = new Map<
      string,
      Array<{ startsAt: Date; endsAt: Date }>
    >();
    if (repIds.length === 0) return intervals;
    if (
      !Number.isFinite(startsAt.getTime()) ||
      !Number.isFinite(endsAt.getTime()) ||
      endsAt <= startsAt
    ) {
      throw new Error("Choose a valid booking range.");
    }

    const rows = await this.sql`
      SELECT reservation.rep_id,
             active_range.starts_at,
             active_range.ends_at
      FROM booking_rep_reservations reservation
      JOIN bookings b ON b.id = reservation.booking_id
      JOIN organizations o ON o.id = b.organization_id
      CROSS JOIN LATERAL (
        VALUES
          (reservation.reserved_starts_at, reservation.reserved_ends_at),
          (
            reservation.previous_reserved_starts_at,
            reservation.previous_reserved_ends_at
          )
      ) AS active_range(starts_at, ends_at)
      WHERE o.slug = ${organizationSlug}
        AND reservation.rep_id = ANY(${[...new Set(repIds)]}::uuid[])
        AND reservation.status IN (
          'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
        )
        AND (${excludeExternalId ?? null}::text IS NULL
          OR b.external_id <> ${excludeExternalId ?? null})
        AND active_range.starts_at IS NOT NULL
        AND active_range.ends_at IS NOT NULL
        AND active_range.starts_at < ${endsAt}
        AND active_range.ends_at > ${startsAt}
      ORDER BY reservation.rep_id, active_range.starts_at, active_range.ends_at
    `;
    for (const row of rows) {
      const repId = String(row.repId);
      const repIntervals = intervals.get(repId) ?? [];
      repIntervals.push({
        startsAt: new Date(String(row.startsAt)),
        endsAt: new Date(String(row.endsAt)),
      });
      intervals.set(repId, repIntervals);
    }
    return intervals;
  }

  async activeBookingCapacityStarts(
    organizationSlug: string,
    repIds: string[],
    startsAt: Date,
    endsAt: Date,
    excludeExternalId?: string,
  ): Promise<Map<string, RepBookingCapacityStart[]>> {
    const startsByRep = new Map<string, RepBookingCapacityStart[]>();
    if (repIds.length === 0) return startsByRep;
    if (
      !Number.isFinite(startsAt.getTime()) ||
      !Number.isFinite(endsAt.getTime()) ||
      endsAt <= startsAt
    ) {
      throw new Error("Choose a valid booking range.");
    }

    const rows = await this.sql`
      SELECT DISTINCT b.id AS booking_id, reservation.rep_id,
             active_start.starts_at
      FROM booking_rep_reservations reservation
      JOIN bookings b ON b.id = reservation.booking_id
      JOIN organizations o ON o.id = b.organization_id
      CROSS JOIN LATERAL (
        SELECT DISTINCT candidate.starts_at
        FROM (
          VALUES
            (reservation.starts_at),
            (
              CASE
                WHEN reservation.status IN (
                  'reschedule_pending', 'cancel_pending'
                ) THEN reservation.previous_starts_at
                ELSE NULL
              END
            )
        ) AS candidate(starts_at)
        WHERE candidate.starts_at IS NOT NULL
      ) active_start
      WHERE o.slug = ${organizationSlug}
        AND reservation.rep_id = ANY(${[...new Set(repIds)]}::uuid[])
        AND reservation.status IN (
          'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
        )
        AND (${excludeExternalId ?? null}::text IS NULL
          OR b.external_id <> ${excludeExternalId ?? null})
        AND active_start.starts_at >= ${startsAt}
        AND active_start.starts_at < ${endsAt}
      ORDER BY reservation.rep_id, active_start.starts_at, b.id
    `;
    for (const row of rows) {
      const repId = String(row.repId);
      const starts = startsByRep.get(repId) ?? [];
      starts.push({
        bookingId: String(row.bookingId),
        startsAt: new Date(String(row.startsAt)),
      });
      startsByRep.set(repId, starts);
    }
    return startsByRep;
  }

  async enqueueCalendarBooking(input: {
    organizationSlug: string;
    externalId: string;
    decisionId: string;
    startsAt: Date;
    endsAt: Date;
    subject: string;
    provider: CalendarOAuthProvider;
    calendarQuote: BookingCandidateQuote;
    attendeeEmail?: string;
    additionalAttendeeEmails?: string[];
  }): Promise<BookingStatus> {
    if (
      !Number.isFinite(input.startsAt.getTime()) ||
      !Number.isFinite(input.endsAt.getTime()) ||
      input.endsAt <= input.startsAt
    ) {
      throw new Error("Choose a valid meeting time.");
    }

    try {
      return await this.sql.begin(async (transaction) => {
        const [organization] =
          await transaction`SELECT id FROM organizations WHERE slug = ${input.organizationSlug}`;
        if (!organization) {
          throw new Error(`Unknown organization: ${input.organizationSlug}`);
        }
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtext(${`legacy-booking:${String(organization.id)}:${input.externalId}`})
          )
        `;

        const existingStatus = async (): Promise<BookingStatus | null> => {
          const [booking] = await transaction`
            SELECT b.id, b.external_id, b.manage_token_hash,
                   b.conference_url
            FROM bookings b
            WHERE b.organization_id = ${organization.id}
              AND (
                b.source_external_id = ${input.externalId}
                OR (
                  b.source_external_id IS NULL
                  AND b.external_id = ${input.externalId}
                )
              )
          `;
          if (!booking) return null;
          const [job] = await transaction`
            SELECT j.id, j.status, j.result, j.last_error,
                   j.payload->>'manageToken' AS manage_token,
                   ${booking.externalId}::text AS external_id,
                   ${booking.manageTokenHash}::text AS manage_token_hash,
                   ${booking.conferenceUrl ?? null}::text AS conference_url
            FROM jobs j
            WHERE j.organization_id = ${organization.id}
              AND j.type = 'calendar.event.create'
              AND (
                j.payload->>'bookingId' = ${String(booking.id)}
                OR j.payload->>'sourceExternalId' = ${input.externalId}
                OR (
                  NOT (j.payload ? 'sourceExternalId')
                  AND j.payload->>'externalId' = ${input.externalId}
                )
              )
            ORDER BY (j.payload->>'bookingId' = ${String(booking.id)}) DESC,
                     j.id
            LIMIT 1
          `;
          if (!job) {
            throw new Error(
              "The booking ledger is missing its calendar creation job.",
            );
          }
          return bookingStatusFromRow(job);
        };

        const existing = await existingStatus();
        if (existing) return existing;

        const [context] = await transaction`
          SELECT rd.lead_email, rd.lead,
                 r.id AS rep_id, r.name AS rep_name, r.email AS rep_email,
                 r.timezone AS rep_timezone,
                 r.active_calendar_provider, c.provider AS calendar_provider,
                 c.external_account_id AS calendar_external_account_id,
                 mt.id AS meeting_type_id, mt.slug AS scheduling_slug,
                 mt.title AS meeting_title, mt.description,
                 mt.duration_minutes, mt.buffer_before_minutes,
                 mt.buffer_after_minutes, mt.conference_provider,
                 mt.zoom_join_url, mt.reminder_minutes,
                 mt.reschedule_cutoff_minutes, mt.cancel_cutoff_minutes
          FROM routing_decisions rd
          JOIN reps r ON r.id = rd.rep_id
          LEFT JOIN rep_calendar_connections c
            ON c.rep_id = r.id AND c.provider = r.active_calendar_provider
          LEFT JOIN meeting_types mt
            ON mt.organization_id = rd.organization_id
           AND mt.rep_id = r.id
           AND mt.slug = r.scheduling_slug
           AND mt.active = true
          WHERE rd.organization_id = ${organization.id}
            AND rd.id = ${input.decisionId}
        `;
        if (!context) throw new Error("Routing decision not found.");
        if (
          !context.calendarProvider ||
          context.activeCalendarProvider !== input.provider ||
          context.calendarProvider !== input.provider
        ) {
          throw new Error(
            "The routed representative's active calendar does not match this booking provider.",
          );
        }
        if (!context.meetingTypeId) {
          throw new Error(
            "The routed representative has no active default meeting type.",
          );
        }

        const leadEmail = String(context.leadEmail ?? "").trim();
        if (!leadEmail) {
          throw new Error("The routing decision has no lead email.");
        }
        if (
          input.attendeeEmail &&
          input.attendeeEmail.trim().toLowerCase() !== leadEmail.toLowerCase()
        ) {
          throw new Error(
            "The attendee email must match the routed lead's email.",
          );
        }
        const lead = context.lead as Record<string, unknown> | null;
        const leadName = typeof lead?.name === "string" ? lead.name.trim() : "";
        if (
          input.endsAt.getTime() - input.startsAt.getTime() !==
          Number(context.durationMinutes) * 60_000
        ) {
          throw new Error(
            "The meeting time must match the routed representative's default meeting duration.",
          );
        }
        if (
          (context.conferenceProvider === "google_meet" &&
            input.provider !== "google") ||
          (context.conferenceProvider === "microsoft_teams" &&
            input.provider !== "microsoft")
        ) {
          throw new Error(
            "The default meeting type is not compatible with the active calendar provider.",
          );
        }
        const protectedRange = protectedBookingRange(
          input.startsAt,
          input.endsAt,
          Number(context.bufferBeforeMinutes),
          Number(context.bufferAfterMinutes),
        );

        const calendarQuote = normalizeBookingCandidateQuote(
          input.calendarQuote,
        );
        if (
          calendarQuote.repId !== String(context.repId) ||
          calendarQuote.calendarProvider !== input.provider
        ) {
          throw new CalendarAccountIdentityError(
            "The routed calendar quote does not match its assigned representative.",
          );
        }
        await lockSchedulingPools(transaction, String(context.meetingTypeId));
        await lockBookingParticipantReps(transaction, [calendarQuote]);
        const cohostResolution = await resolveMeetingTypeCohosts(
          transaction,
          String(context.meetingTypeId),
          String(context.repId),
          calendarQuote,
          input.startsAt,
          protectedRange,
        );
        if (
          !(await bookingParticipantsAreAvailable(
            transaction,
            cohostResolution.quote,
            input.startsAt,
            protectedRange,
          ))
        ) {
          throw new CalendarSlotUnavailableError();
        }
        const calendarExternalAccountId = await lockMatchingAvailabilityQuote(
          transaction,
          calendarQuote,
          { requireActiveProvider: true, includeProviderDefault: false },
        );
        const cohostEmails = cohostResolution.cohostEmails;
        const raced = await existingStatus();
        if (raced) return raced;

        const [decisionBooking] = await transaction`
          SELECT external_id
          FROM bookings
          WHERE routing_decision_id = ${input.decisionId}
          LIMIT 1
        `;
        if (decisionBooking) {
          throw new Error(
            "This routing decision already has a different booking.",
          );
        }

        const [historicalJob] = await transaction`
          SELECT id, status, result, last_error, payload
          FROM jobs
          WHERE organization_id = ${organization.id}
            AND type = 'calendar.event.create'
            AND (
              payload->>'sourceExternalId' = ${input.externalId}
              OR (
                NOT (payload ? 'sourceExternalId')
                AND payload->>'externalId' = ${input.externalId}
              )
            )
          FOR UPDATE
        `;
        const historicalResult = (historicalJob?.result ?? {}) as Record<
          string,
          unknown
        >;
        const historicalPayload = (historicalJob?.payload ?? {}) as Record<
          string,
          unknown
        >;
        const historicalNotificationIntent =
          historicalPayload.attendeeNotificationsEnabled;
        if (
          historicalJob &&
          historicalNotificationIntent !== undefined &&
          typeof historicalNotificationIntent !== "boolean"
        ) {
          throw new Error(
            "The historical booking has invalid attendee notification intent.",
          );
        }
        const historicalAttendeeEmail =
          typeof historicalPayload.attendeeEmail === "string"
            ? historicalPayload.attendeeEmail.trim()
            : "";
        const attendeeNotificationsEnabled = historicalJob
          ? typeof historicalNotificationIntent === "boolean"
            ? historicalNotificationIntent
            : Boolean(historicalAttendeeEmail)
          : Boolean(input.attendeeEmail?.trim());
        const attendeeEmail = historicalAttendeeEmail || leadEmail;
        const historicalAttendeeName =
          typeof historicalPayload.attendeeName === "string"
            ? historicalPayload.attendeeName.trim()
            : "";
        const attendeeName =
          historicalAttendeeName || leadName || attendeeEmail;
        const historicalAdditionalAttendeeValue =
          historicalPayload.additionalAttendeeEmails;
        if (
          historicalAdditionalAttendeeValue !== undefined &&
          (!Array.isArray(historicalAdditionalAttendeeValue) ||
            historicalAdditionalAttendeeValue.some(
              (value) => typeof value !== "string",
            ))
        ) {
          throw new Error(
            "The historical booking has invalid additional attendee data.",
          );
        }
        const historicalAdditionalAttendeeEmails =
          historicalAdditionalAttendeeValue as string[] | undefined;
        const additionalAttendeeEmails = normalizedAdditionalAttendeeEmails(
          historicalJob
            ? (historicalAdditionalAttendeeEmails ??
                input.additionalAttendeeEmails)
            : input.additionalAttendeeEmails,
          attendeeEmail,
        );
        const ledgerStatus =
          historicalJob?.status === "completed"
            ? "confirmed"
            : historicalJob?.status === "failed" ||
                historicalJob?.status === "cancelled"
              ? "failed"
              : "pending";
        const conferenceUrl =
          historicalResult.conferenceUrl ?? context.zoomJoinUrl ?? null;
        const bookingExternalId = historicalJob
          ? input.externalId
          : randomUUID();
        const [booking] = await transaction`
          INSERT INTO bookings (
            organization_id, meeting_type_id, rep_id, external_id,
            source_external_id,
            manage_token_hash, status, attendee_name, attendee_email,
            additional_attendee_emails, attendee_notifications_enabled,
            starts_at, ends_at, buffer_before_minutes, buffer_after_minutes,
            reschedule_cutoff_minutes, cancel_cutoff_minutes,
            calendar_provider,
            calendar_external_account_id, conference_provider,
            conference_url, external_event_id, external_event_web_link,
            last_error, routing_decision_id
          ) VALUES (
            ${organization.id}, ${context.meetingTypeId}, ${context.repId},
            ${bookingExternalId}, ${input.externalId},
            ${historicalJob ? null : tokenHash(bookingExternalId)},
            ${ledgerStatus},
            ${attendeeName}, ${attendeeEmail}, ${additionalAttendeeEmails},
            ${attendeeNotificationsEnabled},
            ${input.startsAt}, ${input.endsAt},
            ${Number(context.bufferBeforeMinutes)},
            ${Number(context.bufferAfterMinutes)},
            ${context.rescheduleCutoffMinutes ?? null},
            ${context.cancelCutoffMinutes ?? null},
            ${input.provider}, ${calendarExternalAccountId},
            ${String(context.conferenceProvider)},
            ${conferenceUrl ? String(conferenceUrl) : null},
            ${historicalResult.externalEventId ? String(historicalResult.externalEventId) : null},
            ${historicalResult.webLink ? String(historicalResult.webLink) : null},
            ${historicalJob?.lastError ? String(historicalJob.lastError) : null},
            ${input.decisionId}
          )
          ON CONFLICT (organization_id, external_id) DO NOTHING
          RETURNING id
        `;
        if (!booking) {
          const raceWinner = await existingStatus();
          if (raceWinner) return raceWinner;
          throw new Error("The booking could not be reconciled after a retry.");
        }

        await persistSelectedCohostGroups(
          transaction,
          String(booking.id),
          cohostResolution.selectedGroups,
        );
        const crmRoleOwners = await cohostRoleOwnersForBooking(transaction, {
          organizationId: String(organization.id),
          selectedGroups: cohostResolution.selectedGroups,
        });

        const payload = {
          bookingId: String(booking.id),
          externalId: bookingExternalId,
          sourceExternalId: input.externalId,
          organizationSlug: input.organizationSlug,
          schedulingSlug: String(context.schedulingSlug),
          publicBooking: true,
          decisionId: input.decisionId,
          repId: String(context.repId),
          repName: String(context.repName),
          repEmail: String(context.repEmail),
          repTimezone: String(context.repTimezone),
          provider: input.provider,
          calendarExternalAccountId,
          startsAt: input.startsAt.toISOString(),
          endsAt: input.endsAt.toISOString(),
          subject: input.subject,
          description: String(context.description),
          attendeeName,
          attendeeEmail: attendeeNotificationsEnabled ? attendeeEmail : null,
          additionalAttendeeEmails: attendeeNotificationsEnabled
            ? additionalAttendeeEmails
            : [],
          cohostEmails,
          attendeeNotificationsEnabled,
          conferenceProvider: String(context.conferenceProvider),
          conferenceUrl: conferenceUrl ? String(conferenceUrl) : null,
          reminderMinutes: Number(context.reminderMinutes),
          ...(crmRoleOwners.length > 0
            ? { crmLeadEmail: attendeeEmail, crmRoleOwners }
            : {}),
        };
        const [job] = historicalJob
          ? await transaction`
              UPDATE jobs
              SET payload = payload || ${transaction.json(payload as JSONValue)}
              WHERE id = ${historicalJob.id}
              RETURNING id, status, result, last_error,
                        ${historicalJob ? null : `/schedule/manage/${bookingExternalId}`}::text AS manage_path,
                        ${conferenceUrl ? String(conferenceUrl) : null}::text AS conference_url
            `
          : await transaction`
              INSERT INTO jobs (organization_id, type, payload)
              VALUES (
                ${organization.id}, 'calendar.event.create',
                ${transaction.json(payload as JSONValue)}
              )
              RETURNING id, status, result, last_error,
                        ${`/schedule/manage/${bookingExternalId}`}::text AS manage_path,
                        ${conferenceUrl ? String(conferenceUrl) : null}::text AS conference_url
            `;
        if (!job) throw new Error("The calendar creation job was not queued.");
        return bookingStatusFromRow(job);
      });
    } catch (error) {
      if (
        isCalendarSlotDatabaseConflict(error) ||
        error instanceof CalendarAccountIdentityError
      ) {
        throw new CalendarSlotUnavailableError();
      }
      throw error;
    }
  }

  async publicSchedule(
    organizationSlug: string,
    schedulingSlug: string,
  ): Promise<PublicSchedule | null> {
    const [meetingType] = await this.sql`
      SELECT mt.id, mt.organization_id, o.name AS organization_name,
             o.slug AS organization_slug,
             mt.slug, mt.title, mt.description, mt.duration_minutes,
             mt.buffer_before_minutes, mt.buffer_after_minutes,
             mt.minimum_notice_minutes, mt.booking_window_days,
             mt.conference_provider, mt.zoom_join_url, mt.reminder_minutes,
             mt.rep_id, mt.pool_id, coalesce(r.name, rp.name) AS host_name
      FROM meeting_types mt
      JOIN organizations o ON o.id = mt.organization_id
      LEFT JOIN reps r ON r.id = mt.rep_id
      LEFT JOIN routing_pools rp ON rp.id = mt.pool_id
      WHERE o.slug = ${organizationSlug} AND mt.slug = ${schedulingSlug}
        AND mt.active = true
    `;
    if (!meetingType) return null;

    const teamMemberRows = await this.sql`
      SELECT cohost.rep_id, rep.name, rep.active,
             cohost.required_for_availability, cohost.position
      FROM meeting_type_cohosts cohost
      JOIN reps rep ON rep.id = cohost.rep_id
      WHERE cohost.meeting_type_id = ${meetingType.id}
      ORDER BY cohost.position
    `;
    const cohostGroupRows = await this.sql`
      SELECT cohost_group.pool_id, pool.name AS pool_name,
             cohost_group.required_for_availability, cohost_group.position
      FROM meeting_type_cohost_groups cohost_group
      JOIN routing_pools pool ON pool.id = cohost_group.pool_id
      WHERE cohost_group.meeting_type_id = ${meetingType.id}
      ORDER BY cohost_group.position
    `;

    const reps = await this.sql`
      SELECT DISTINCT r.id, r.name, r.timezone, r.weight, r.availability,
             r.availability_overrides,
             r.daily_meeting_limit, r.weekly_meeting_limit,
             c.provider, c.external_account_id,
             coalesce((
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'provider', source.provider,
                   'calendarExternalAccountId', source_connection.external_account_id,
                   'calendarId', source.provider_calendar_id,
                   'available', source.missing_since IS NULL
                 )
                 ORDER BY
                   (source.provider = r.active_calendar_provider) DESC,
                   source.is_provider_default DESC,
                   source.provider, source.provider_calendar_id
               )
               FROM rep_calendar_sources source
               JOIN rep_calendar_connections source_connection
                 ON source_connection.rep_id = source.rep_id
                AND source_connection.provider = source.provider
               WHERE source.rep_id = r.id AND source.selected_for_conflicts
             ), '[]'::jsonb) AS conflict_calendars
      FROM reps r
      JOIN rep_calendar_connections c
        ON c.rep_id = r.id AND c.provider = r.active_calendar_provider
      LEFT JOIN routing_pool_members rpm ON rpm.rep_id = r.id
      WHERE r.organization_id = ${meetingType.organizationId}
        AND r.active = true
        AND c.external_account_id IS NOT NULL
        AND length(c.external_account_id) BETWEEN 1 AND 1024
        AND c.external_account_id !~ '[[:cntrl:]]'
        AND NOT EXISTS (
          SELECT 1
          FROM rep_calendar_sources selected_source
          LEFT JOIN rep_calendar_connections selected_connection
            ON selected_connection.rep_id = selected_source.rep_id
           AND selected_connection.provider = selected_source.provider
          WHERE selected_source.rep_id = r.id
            AND selected_source.selected_for_conflicts
            AND (
              selected_connection.external_account_id IS NULL
              OR length(selected_connection.external_account_id) NOT BETWEEN 1 AND 1024
              OR selected_connection.external_account_id ~ '[[:cntrl:]]'
            )
        )
        AND (
          r.id = ${meetingType.repId}
          OR (${meetingType.poolId}::uuid IS NOT NULL AND rpm.pool_id = ${meetingType.poolId})
        )
        AND (
          ${meetingType.conferenceProvider}::text IN ('none', 'zoom')
          OR (${meetingType.conferenceProvider} = 'google_meet' AND c.provider = 'google')
          OR (${meetingType.conferenceProvider} = 'microsoft_teams' AND c.provider = 'microsoft')
        )
      ORDER BY r.name
    `;
    const requiredCohosts = await this.sql`
      SELECT DISTINCT r.id, r.name, r.timezone, r.weight, r.availability,
             r.availability_overrides,
             r.daily_meeting_limit, r.weekly_meeting_limit,
             c.provider, c.external_account_id,
             coalesce((
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'provider', source.provider,
                   'calendarExternalAccountId', source_connection.external_account_id,
                   'calendarId', source.provider_calendar_id,
                   'available', source.missing_since IS NULL
                 )
                 ORDER BY
                   (source.provider = r.active_calendar_provider) DESC,
                   source.is_provider_default DESC,
                   source.provider, source.provider_calendar_id
               )
               FROM rep_calendar_sources source
               JOIN rep_calendar_connections source_connection
                 ON source_connection.rep_id = source.rep_id
                AND source_connection.provider = source.provider
               WHERE source.rep_id = r.id AND source.selected_for_conflicts
             ), '[]'::jsonb) AS conflict_calendars
      FROM meeting_type_cohosts cohost
      JOIN reps r ON r.id = cohost.rep_id
      JOIN rep_calendar_connections c
        ON c.rep_id = r.id AND c.provider = r.active_calendar_provider
      WHERE cohost.meeting_type_id = ${meetingType.id}
        AND cohost.required_for_availability
        AND r.active = true
        AND c.external_account_id IS NOT NULL
        AND length(c.external_account_id) BETWEEN 1 AND 1024
        AND c.external_account_id !~ '[[:cntrl:]]'
        AND EXISTS (
          SELECT 1
          FROM rep_calendar_sources selected_source
          JOIN rep_calendar_connections selected_connection
            ON selected_connection.rep_id = selected_source.rep_id
           AND selected_connection.provider = selected_source.provider
          WHERE selected_source.rep_id = r.id
            AND selected_source.selected_for_conflicts
            AND selected_source.missing_since IS NULL
            AND selected_connection.external_account_id IS NOT NULL
            AND length(selected_connection.external_account_id) BETWEEN 1 AND 1024
            AND selected_connection.external_account_id !~ '[[:cntrl:]]'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM rep_calendar_sources selected_source
          LEFT JOIN rep_calendar_connections selected_connection
            ON selected_connection.rep_id = selected_source.rep_id
           AND selected_connection.provider = selected_source.provider
          WHERE selected_source.rep_id = r.id
            AND selected_source.selected_for_conflicts
            AND (
              selected_source.missing_since IS NOT NULL
              OR selected_connection.external_account_id IS NULL
              OR length(selected_connection.external_account_id) NOT BETWEEN 1 AND 1024
              OR selected_connection.external_account_id ~ '[[:cntrl:]]'
            )
        )
      ORDER BY r.name
    `;
    const requiredGroupCandidates = await this.sql`
      SELECT cohost_group.pool_id,
             r.id, r.name, r.timezone, r.weight, r.availability,
             r.availability_overrides,
             r.daily_meeting_limit, r.weekly_meeting_limit,
             c.provider, c.external_account_id,
             coalesce((
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'provider', source.provider,
                   'calendarExternalAccountId', source_connection.external_account_id,
                   'calendarId', source.provider_calendar_id,
                   'available', source.missing_since IS NULL
                 )
                 ORDER BY
                   (source.provider = r.active_calendar_provider) DESC,
                   source.is_provider_default DESC,
                   source.provider, source.provider_calendar_id
               )
               FROM rep_calendar_sources source
               JOIN rep_calendar_connections source_connection
                 ON source_connection.rep_id = source.rep_id
                AND source_connection.provider = source.provider
               WHERE source.rep_id = r.id AND source.selected_for_conflicts
             ), '[]'::jsonb) AS conflict_calendars
      FROM meeting_type_cohost_groups cohost_group
      JOIN routing_pool_members member
        ON member.pool_id = cohost_group.pool_id
      JOIN reps r ON r.id = member.rep_id
      JOIN rep_calendar_connections c
        ON c.rep_id = r.id AND c.provider = r.active_calendar_provider
      WHERE cohost_group.meeting_type_id = ${meetingType.id}
        AND cohost_group.required_for_availability
        AND r.active = true
        AND c.external_account_id IS NOT NULL
        AND length(c.external_account_id) BETWEEN 1 AND 1024
        AND c.external_account_id !~ '[[:cntrl:]]'
        AND EXISTS (
          SELECT 1
          FROM rep_calendar_sources selected_source
          JOIN rep_calendar_connections selected_connection
            ON selected_connection.rep_id = selected_source.rep_id
           AND selected_connection.provider = selected_source.provider
          WHERE selected_source.rep_id = r.id
            AND selected_source.selected_for_conflicts
            AND selected_source.missing_since IS NULL
            AND selected_connection.external_account_id IS NOT NULL
            AND length(selected_connection.external_account_id) BETWEEN 1 AND 1024
            AND selected_connection.external_account_id !~ '[[:cntrl:]]'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM rep_calendar_sources selected_source
          LEFT JOIN rep_calendar_connections selected_connection
            ON selected_connection.rep_id = selected_source.rep_id
           AND selected_connection.provider = selected_source.provider
          WHERE selected_source.rep_id = r.id
            AND selected_source.selected_for_conflicts
            AND (
              selected_source.missing_since IS NOT NULL
              OR selected_connection.external_account_id IS NULL
              OR length(selected_connection.external_account_id) NOT BETWEEN 1 AND 1024
              OR selected_connection.external_account_id ~ '[[:cntrl:]]'
            )
        )
      ORDER BY cohost_group.position, r.name, r.id
    `;
    const configuredRequiredCount = teamMemberRows.filter(
      (row) => row.requiredForAvailability,
    ).length;
    const requiredCohostsReady =
      configuredRequiredCount === requiredCohosts.length;
    const mapScheduleRep = (
      rep: Record<string, unknown>,
    ): PublicSchedule["reps"][number] => ({
      id: String(rep.id),
      name: String(rep.name),
      timezone: String(rep.timezone),
      weight: Number(rep.weight),
      availability:
        rep.availability as PublicSchedule["reps"][number]["availability"],
      availabilityOverrides: (rep.availabilityOverrides ??
        {}) as PublicSchedule["reps"][number]["availabilityOverrides"],
      dailyMeetingLimit:
        rep.dailyMeetingLimit === null || rep.dailyMeetingLimit === undefined
          ? null
          : Number(rep.dailyMeetingLimit),
      weeklyMeetingLimit:
        rep.weeklyMeetingLimit === null || rep.weeklyMeetingLimit === undefined
          ? null
          : Number(rep.weeklyMeetingLimit),
      calendarProvider: rep.provider as CalendarOAuthProvider,
      calendarExternalAccountId: String(rep.externalAccountId),
      conflictCalendars: calendarConflictSourcesFromValue(
        rep.conflictCalendars,
      ),
    });
    const cohostGroups = cohostGroupRows.map((group) => ({
      poolId: String(group.poolId),
      poolName: String(group.poolName),
      requiredForAvailability: Boolean(group.requiredForAvailability),
      candidates: requiredGroupCandidates
        .filter(
          (candidate) => String(candidate.poolId) === String(group.poolId),
        )
        .map(mapScheduleRep),
    }));
    const requiredCohostGroupsReady = cohostGroups.every(
      (group) => !group.requiredForAvailability || group.candidates.length > 0,
    );
    return {
      meetingTypeId: String(meetingType.id),
      organizationName: String(meetingType.organizationName),
      organizationSlug: String(meetingType.organizationSlug),
      schedulingSlug: String(meetingType.slug),
      meetingTitle: String(meetingType.title),
      meetingDescription: String(meetingType.description),
      durationMinutes: Number(meetingType.durationMinutes),
      bufferBeforeMinutes: Number(meetingType.bufferBeforeMinutes),
      bufferAfterMinutes: Number(meetingType.bufferAfterMinutes),
      minimumNoticeMinutes: Number(meetingType.minimumNoticeMinutes),
      bookingWindowDays: Number(meetingType.bookingWindowDays),
      conferenceProvider: meetingType.conferenceProvider as ConferenceProvider,
      zoomJoinUrl: meetingType.zoomJoinUrl
        ? String(meetingType.zoomJoinUrl)
        : null,
      reminderMinutes: Number(meetingType.reminderMinutes),
      targetType: meetingType.repId ? "rep" : "pool",
      hostName: String(meetingType.hostName),
      reps:
        requiredCohostsReady && requiredCohostGroupsReady
          ? reps.map(mapScheduleRep)
          : [],
      requiredCohosts: requiredCohosts.map(mapScheduleRep),
      cohostGroups,
      teamMembers: teamMemberRows
        .filter((row) => row.active)
        .map((row) => ({
          repId: String(row.repId),
          name: String(row.name),
          requiredForAvailability: Boolean(row.requiredForAvailability),
        })),
    };
  }

  async enqueuePublicBooking(input: {
    organizationSlug: string;
    schedulingSlug: string;
    meetingTypeId: string;
    candidateQuotes: BookingCandidateQuote[];
    externalId: string;
    startsAt: Date;
    endsAt: Date;
    attendeeName: string;
    attendeeEmail: string;
    additionalAttendeeEmails?: string[];
    subject: string;
    conferenceProvider: ConferenceProvider;
    zoomJoinUrl?: string | null;
    reminderMinutes: number;
    description?: string;
  }): Promise<PublicBookingStatus> {
    try {
      const additionalAttendeeEmails = normalizedAdditionalAttendeeEmails(
        input.additionalAttendeeEmails,
        input.attendeeEmail,
      );
      const candidateQuotes = input.candidateQuotes.map(
        normalizeBookingCandidateQuote,
      );
      const candidateRepIds = candidateQuotes.map((quote) => quote.repId);
      if (
        candidateRepIds.length < 1 ||
        candidateRepIds.length > 100 ||
        new Set(candidateRepIds).size !== candidateRepIds.length
      ) {
        throw new CalendarAccountIdentityError(
          "The availability quote does not identify valid candidates.",
        );
      }
      const candidateQuoteByRepId = new Map(
        candidateQuotes.map((quote) => [quote.repId, quote]),
      );
      return await this.sql.begin(async (transaction) => {
        const [meetingTarget] = await transaction`
        SELECT o.id AS organization_id, mt.pool_id, mt.rep_id,
               mt.buffer_before_minutes, mt.buffer_after_minutes,
               mt.invitee_limit_scope, mt.invitee_limit_count,
               mt.reschedule_cutoff_minutes, mt.cancel_cutoff_minutes
        FROM meeting_types mt
        JOIN organizations o ON o.id = mt.organization_id
        WHERE o.slug = ${input.organizationSlug}
          AND mt.id = ${input.meetingTypeId}
          AND mt.slug = ${input.schedulingSlug}
          AND mt.active = true
        FOR SHARE OF mt
      `;
        if (!meetingTarget) throw new Error("Scheduling link not found.");
        const [idempotentBooking] = await transaction`
          SELECT b.status, b.last_error, b.external_id, b.manage_token_hash,
                 b.conference_url, b.starts_at, b.ends_at,
                 r.name AS rep_name
          FROM bookings b
          JOIN reps r ON r.id = b.rep_id
          WHERE b.organization_id = ${meetingTarget.organizationId}
            AND b.external_id = ${input.externalId}
        `;
        if (idempotentBooking) {
          return publicBookingStatusFromRow(idempotentBooking);
        }
        await enforceInviteeBookingLimit(transaction, {
          organizationId: String(meetingTarget.organizationId),
          meetingTypeId: input.meetingTypeId,
          attendeeEmail: input.attendeeEmail,
          scope: meetingTarget.inviteeLimitScope as InviteeLimitScope,
          count:
            meetingTarget.inviteeLimitCount === null
              ? null
              : Number(meetingTarget.inviteeLimitCount),
          excludeExternalId: input.externalId,
        });
        const protectedRange = protectedBookingRange(
          input.startsAt,
          input.endsAt,
          Number(meetingTarget.bufferBeforeMinutes),
          Number(meetingTarget.bufferAfterMinutes),
        );
        await lockSchedulingPools(
          transaction,
          input.meetingTypeId,
          meetingTarget.poolId ? String(meetingTarget.poolId) : null,
        );
        await lockBookingParticipantReps(transaction, candidateQuotes);
        const [existing] = await transaction`
        SELECT b.status, b.last_error, b.external_id, b.manage_token_hash,
               b.conference_url,
               b.starts_at, b.ends_at, r.name AS rep_name
        FROM bookings b
        JOIN reps r ON r.id = b.rep_id
        WHERE b.organization_id = ${meetingTarget.organizationId}
          AND b.external_id = ${input.externalId}
      `;
        if (existing) return publicBookingStatusFromRow(existing);

        const candidates = await transaction`
        SELECT o.id AS organization_id, mt.pool_id, r.id AS rep_id,
               r.name AS rep_name, r.email AS rep_email, r.timezone AS rep_timezone,
               r.weight, c.provider, c.external_account_id,
               coalesce(ast.assignments, 0)::int AS assignments,
               ast.last_assigned_at
        FROM meeting_types mt
        JOIN organizations o ON o.id = mt.organization_id
        JOIN reps r ON r.organization_id = o.id
        JOIN rep_calendar_connections c
          ON c.rep_id = r.id AND c.provider = r.active_calendar_provider
        LEFT JOIN routing_pool_members rpm
          ON rpm.rep_id = r.id AND rpm.pool_id = mt.pool_id
        LEFT JOIN assignment_state ast
          ON ast.pool_id = mt.pool_id AND ast.rep_id = r.id
        WHERE o.slug = ${input.organizationSlug}
          AND mt.id = ${input.meetingTypeId}
          AND mt.slug = ${input.schedulingSlug}
          AND mt.active = true
          AND r.active = true
          AND r.id = ANY(${candidateRepIds}::uuid[])
          AND c.external_account_id IS NOT NULL
          AND length(c.external_account_id) BETWEEN 1 AND 1024
          AND c.external_account_id !~ '[[:cntrl:]]'
          AND (r.id = mt.rep_id OR rpm.rep_id IS NOT NULL)
          AND (
            mt.conference_provider IN ('none', 'zoom')
            OR (mt.conference_provider = 'google_meet' AND c.provider = 'google')
            OR (mt.conference_provider = 'microsoft_teams' AND c.provider = 'microsoft')
          )
          AND NOT EXISTS (
            SELECT 1 FROM booking_rep_reservations reservation
            WHERE reservation.rep_id = r.id
              AND reservation.status IN (
                'pending', 'confirmed', 'reschedule_pending', 'cancel_pending', 'failed'
              )
              AND (
                (
                  reservation.reserved_starts_at < ${protectedRange.endsAt}
                  AND reservation.reserved_ends_at > ${protectedRange.startsAt}
                ) OR (
                  reservation.previous_reserved_starts_at IS NOT NULL
                  AND reservation.previous_reserved_starts_at < ${protectedRange.endsAt}
                  AND reservation.previous_reserved_ends_at > ${protectedRange.startsAt}
                )
              )
          )
        ORDER BY
          (coalesce(ast.assignments, 0)::numeric / greatest(r.weight, 1)) ASC,
          ast.last_assigned_at ASC NULLS FIRST,
          r.id
        `;
        let context: Record<string, unknown> | undefined;
        let cohostResolution: MeetingTypeCohostResolution | undefined;
        for (const candidate of candidates) {
          const quote = candidateQuoteByRepId.get(String(candidate.repId));
          if (!quote) continue;
          try {
            const candidateCohosts = await resolveMeetingTypeCohosts(
              transaction,
              input.meetingTypeId,
              String(candidate.repId),
              quote,
              input.startsAt,
              protectedRange,
            );
            if (
              !(await bookingParticipantsAreAvailable(
                transaction,
                candidateCohosts.quote,
                input.startsAt,
                protectedRange,
              ))
            ) {
              continue;
            }
            context = candidate;
            cohostResolution = candidateCohosts;
            break;
          } catch (error) {
            if (error instanceof CalendarSlotUnavailableError) continue;
            throw error;
          }
        }
        if (!context || !cohostResolution) {
          throw new CalendarSlotUnavailableError();
        }
        const selectedQuote = candidateQuoteByRepId.get(String(context.repId));
        if (!selectedQuote) throw new CalendarSlotUnavailableError();
        const calendarExternalAccountId = await lockMatchingAvailabilityQuote(
          transaction,
          selectedQuote,
          { requireActiveProvider: true, includeProviderDefault: false },
        );
        const cohostEmails = cohostResolution.cohostEmails;

        const [booking] = await transaction`
        INSERT INTO bookings (
          organization_id, meeting_type_id, rep_id, external_id,
          manage_token_hash, attendee_name, attendee_email,
          additional_attendee_emails, starts_at, ends_at,
          buffer_before_minutes, buffer_after_minutes,
          reschedule_cutoff_minutes, cancel_cutoff_minutes,
          calendar_provider, calendar_external_account_id,
          conference_provider, conference_url
        ) VALUES (
          ${String(context.organizationId)}, ${input.meetingTypeId}, ${String(context.repId)},
          ${input.externalId}, ${tokenHash(input.externalId)},
          ${input.attendeeName}, ${input.attendeeEmail},
          ${additionalAttendeeEmails}, ${input.startsAt}, ${input.endsAt},
          ${Number(meetingTarget.bufferBeforeMinutes)},
          ${Number(meetingTarget.bufferAfterMinutes)},
          ${meetingTarget.rescheduleCutoffMinutes ?? null},
          ${meetingTarget.cancelCutoffMinutes ?? null},
          ${String(context.provider)}, ${calendarExternalAccountId},
          ${input.conferenceProvider},
          ${input.zoomJoinUrl ?? null}
        )
        ON CONFLICT (organization_id, external_id) DO NOTHING
        RETURNING id, status, conference_url
      `;
        if (!booking) {
          const [raceWinner] = await transaction`
          SELECT status, conference_url, starts_at, ends_at
          FROM bookings
          WHERE organization_id = ${String(context.organizationId)}
            AND external_id = ${input.externalId}
        `;
          if (raceWinner) {
            return {
              status: raceWinner.status as PublicBookingStatus["status"],
              error: null,
              managePath: `/schedule/manage/${input.externalId}`,
              conferenceUrl: raceWinner.conferenceUrl
                ? String(raceWinner.conferenceUrl)
                : null,
              repName: String(context.repName),
              startsAt: new Date(String(raceWinner.startsAt)).toISOString(),
              endsAt: new Date(String(raceWinner.endsAt)).toISOString(),
            };
          }
          throw new CalendarSlotUnavailableError();
        }

        await persistSelectedCohostGroups(
          transaction,
          String(booking.id),
          cohostResolution.selectedGroups,
        );
        const crmRoleOwners = await cohostRoleOwnersForBooking(transaction, {
          organizationId: String(context.organizationId),
          selectedGroups: cohostResolution.selectedGroups,
        });

        await transaction`
        INSERT INTO jobs (organization_id, type, payload)
        VALUES (
          ${String(context.organizationId)},
          'calendar.event.create',
          ${transaction.json({
            bookingId: String(booking.id),
            externalId: input.externalId,
            organizationSlug: input.organizationSlug,
            schedulingSlug: input.schedulingSlug,
            publicBooking: true,
            repId: String(context.repId),
            repName: String(context.repName),
            repEmail: String(context.repEmail),
            repTimezone: String(context.repTimezone),
            provider: String(context.provider),
            calendarExternalAccountId,
            startsAt: input.startsAt.toISOString(),
            endsAt: input.endsAt.toISOString(),
            subject: input.subject,
            description: input.description,
            attendeeName: input.attendeeName,
            attendeeEmail: input.attendeeEmail,
            additionalAttendeeEmails,
            cohostEmails,
            attendeeNotificationsEnabled: true,
            conferenceProvider: input.conferenceProvider,
            conferenceUrl: input.zoomJoinUrl ?? null,
            reminderMinutes: input.reminderMinutes,
            ...(crmRoleOwners.length > 0
              ? { crmLeadEmail: input.attendeeEmail, crmRoleOwners }
              : {}),
          } as JSONValue)}
        )
      `;

        if (context.poolId) {
          await transaction`
          INSERT INTO assignment_state (pool_id, rep_id, assignments, last_assigned_at)
          VALUES (${String(context.poolId)}, ${String(context.repId)}, 1, now())
          ON CONFLICT (pool_id, rep_id) DO UPDATE SET
            assignments = assignment_state.assignments + 1,
            last_assigned_at = EXCLUDED.last_assigned_at
        `;
        }

        return {
          status: "pending",
          error: null,
          managePath: `/schedule/manage/${input.externalId}`,
          conferenceUrl: input.zoomJoinUrl ?? null,
          repName: String(context.repName),
          startsAt: input.startsAt.toISOString(),
          endsAt: input.endsAt.toISOString(),
        };
      });
    } catch (error) {
      if (
        isCalendarSlotDatabaseConflict(error) ||
        error instanceof CalendarAccountIdentityError
      ) {
        throw new CalendarSlotUnavailableError();
      }
      throw error;
    }
  }

  async publicBookingStatus(
    organizationSlug: string,
    schedulingSlug: string,
    externalId: string,
  ): Promise<PublicBookingStatus | null> {
    const [row] = await this.sql`
      SELECT b.status, b.last_error, b.external_id, b.manage_token_hash,
             b.conference_url, b.starts_at, b.ends_at, r.name AS rep_name,
             create_job.payload->>'manageToken' AS manage_token
      FROM bookings b
      JOIN organizations o ON o.id = b.organization_id
      JOIN meeting_types mt ON mt.id = b.meeting_type_id
      JOIN reps r ON r.id = b.rep_id
      LEFT JOIN LATERAL (
        SELECT job.payload
        FROM jobs job
        WHERE job.organization_id = b.organization_id
          AND job.type = 'calendar.event.create'
          AND job.payload->>'bookingId' = b.id::text
        ORDER BY job.id
        LIMIT 1
      ) create_job ON true
      WHERE o.slug = ${organizationSlug}
        AND mt.slug = ${schedulingSlug}
        AND b.external_id = ${externalId}
    `;
    return row
      ? {
          status: row.status as PublicBookingStatus["status"],
          error: row.lastError ? String(row.lastError) : null,
          managePath: safeManagePathFromRow(row),
          conferenceUrl: row.conferenceUrl ? String(row.conferenceUrl) : null,
          repName: String(row.repName),
          startsAt: new Date(String(row.startsAt)).toISOString(),
          endsAt: new Date(String(row.endsAt)).toISOString(),
        }
      : null;
  }

  async managedBooking(manageToken: string): Promise<ManagedBooking | null> {
    const [row] = await this.sql`
      SELECT b.id, b.external_id, b.status, o.name AS organization_name,
             o.slug AS organization_slug, mt.id AS meeting_type_id,
             mt.slug AS meeting_type_slug, mt.title AS meeting_title,
             mt.description AS meeting_description, mt.duration_minutes,
             b.buffer_before_minutes, b.buffer_after_minutes,
             mt.minimum_notice_minutes, mt.booking_window_days,
             mt.zoom_join_url, mt.reminder_minutes,
             r.id AS rep_id, r.name AS rep_name, r.timezone AS rep_timezone,
             r.weight AS rep_weight, r.availability AS rep_availability,
             r.availability_overrides AS rep_availability_overrides,
             r.daily_meeting_limit AS rep_daily_meeting_limit,
             r.weekly_meeting_limit AS rep_weekly_meeting_limit,
             b.attendee_name, b.attendee_email,
             b.additional_attendee_emails, b.starts_at, b.ends_at,
             b.reschedule_cutoff_minutes, b.cancel_cutoff_minutes,
             b.previous_starts_at, b.previous_ends_at, b.external_event_id,
             b.calendar_provider, b.calendar_external_account_id,
             b.conference_provider, b.conference_url, b.last_error,
             (
               b.status = 'failed'
               AND b.router_session_id IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM jobs create_job
                 WHERE create_job.organization_id = b.organization_id
                   AND create_job.type = 'calendar.event.create'
                   AND create_job.payload->>'bookingId' = b.id::text
                   AND create_job.status IN ('failed', 'cancelled')
               )
             ) AS failed_router_create
      FROM bookings b
      JOIN organizations o ON o.id = b.organization_id
      JOIN meeting_types mt ON mt.id = b.meeting_type_id
      JOIN reps r ON r.id = b.rep_id
      WHERE b.manage_token_hash = ${tokenHash(manageToken)}
    `;
    if (!row) return null;
    const cohostRows = await this.sql`
      SELECT cohost.rep_id, cohost.name, cohost.email,
             cohost.required_for_availability, cohost.position,
             cohost.source_pool_id, cohost.source_pool_name,
             rep.active, rep.timezone, rep.weight, rep.availability,
             rep.availability_overrides,
             rep.daily_meeting_limit, rep.weekly_meeting_limit,
             connection.provider, connection.external_account_id,
             coalesce((
               SELECT jsonb_agg(
                 jsonb_build_object(
                   'provider', source.provider,
                   'calendarExternalAccountId', source_connection.external_account_id,
                   'calendarId', source.provider_calendar_id,
                   'available', source.missing_since IS NULL
                 )
                 ORDER BY source.provider, source.provider_calendar_id
               )
               FROM rep_calendar_sources source
               JOIN rep_calendar_connections source_connection
                 ON source_connection.rep_id = source.rep_id
                AND source_connection.provider = source.provider
               WHERE source.rep_id = rep.id
                 AND source.selected_for_conflicts
             ), '[]'::jsonb) AS conflict_calendars
      FROM booking_cohosts cohost
      JOIN reps rep ON rep.id = cohost.rep_id
      LEFT JOIN rep_calendar_connections connection
        ON connection.rep_id = rep.id
       AND connection.provider = rep.active_calendar_provider
      WHERE cohost.booking_id = ${row.id}
      ORDER BY cohost.position
    `;
    const requiredCohostRows = cohostRows.filter(
      (cohost) => cohost.requiredForAvailability,
    );
    const readyRequiredCohosts = requiredCohostRows.flatMap((cohost) => {
      const externalAccountId = verifiedCalendarExternalAccountId(
        cohost.externalAccountId,
      );
      const calendars = calendarConflictSourcesFromValue(
        cohost.conflictCalendars,
      );
      if (
        !cohost.active ||
        !externalAccountId ||
        (cohost.provider !== "google" && cohost.provider !== "microsoft") ||
        calendars.length === 0 ||
        calendars.some((calendar) => !calendar.available)
      ) {
        return [];
      }
      return [
        {
          id: String(cohost.repId),
          name: String(cohost.name),
          timezone: String(cohost.timezone),
          weight: Number(cohost.weight),
          availability:
            cohost.availability as PublicSchedule["reps"][number]["availability"],
          availabilityOverrides: (cohost.availabilityOverrides ??
            {}) as PublicSchedule["reps"][number]["availabilityOverrides"],
          dailyMeetingLimit:
            cohost.dailyMeetingLimit === null ||
            cohost.dailyMeetingLimit === undefined
              ? null
              : Number(cohost.dailyMeetingLimit),
          weeklyMeetingLimit:
            cohost.weeklyMeetingLimit === null ||
            cohost.weeklyMeetingLimit === undefined
              ? null
              : Number(cohost.weeklyMeetingLimit),
          calendarProvider: cohost.provider as CalendarOAuthProvider,
          calendarExternalAccountId: externalAccountId,
          conflictCalendars: calendars,
        },
      ];
    });
    const teamMembers = cohostRows.map((cohost) => ({
      repId: String(cohost.repId),
      name: String(cohost.name),
      requiredForAvailability: Boolean(cohost.requiredForAvailability),
      poolId: cohost.sourcePoolId ? String(cohost.sourcePoolId) : null,
      poolName: cohost.sourcePoolName ? String(cohost.sourcePoolName) : null,
    }));
    const calendarExternalAccountId = verifiedCalendarExternalAccountId(
      row.calendarExternalAccountId,
    );
    let rescheduleSchedule: PublicSchedule | null = null;
    if (calendarExternalAccountId) {
      const sourceRows = await this.sql`
        SELECT source.provider, source.provider_calendar_id,
               source.is_provider_default,
               source.missing_since IS NULL AS available,
               connection.external_account_id
        FROM rep_calendar_sources source
        JOIN rep_calendar_connections connection
          ON connection.rep_id = source.rep_id
         AND connection.provider = source.provider
        WHERE source.rep_id = ${row.repId}
          AND (
            source.selected_for_conflicts
            OR (
              source.provider = ${row.calendarProvider}
              AND source.is_provider_default
            )
          )
        ORDER BY source.provider, source.provider_calendar_id
      `;
      const conflictCalendars: CalendarConflictSource[] = [];
      let originalProviderDefaultIsBound = false;
      for (const source of sourceRows) {
        const sourceAccountId = verifiedCalendarExternalAccountId(
          source.externalAccountId,
        );
        if (!sourceAccountId) {
          conflictCalendars.length = 0;
          break;
        }
        if (
          source.provider === row.calendarProvider &&
          Boolean(source.isProviderDefault) &&
          sourceAccountId === calendarExternalAccountId
        ) {
          originalProviderDefaultIsBound = true;
        }
        conflictCalendars.push({
          provider: source.provider as CalendarOAuthProvider,
          calendarExternalAccountId: sourceAccountId,
          calendarId: String(source.providerCalendarId),
          available: Boolean(source.available),
        });
      }
      if (
        originalProviderDefaultIsBound &&
        conflictCalendars.length > 0 &&
        readyRequiredCohosts.length === requiredCohostRows.length
      ) {
        rescheduleSchedule = {
          meetingTypeId: String(row.meetingTypeId),
          organizationName: String(row.organizationName),
          organizationSlug: String(row.organizationSlug),
          schedulingSlug: String(row.meetingTypeSlug),
          meetingTitle: String(row.meetingTitle),
          meetingDescription: String(row.meetingDescription),
          durationMinutes: Number(row.durationMinutes),
          bufferBeforeMinutes: Number(row.bufferBeforeMinutes),
          bufferAfterMinutes: Number(row.bufferAfterMinutes),
          minimumNoticeMinutes: Number(row.minimumNoticeMinutes),
          bookingWindowDays: Number(row.bookingWindowDays),
          conferenceProvider: row.conferenceProvider as ConferenceProvider,
          zoomJoinUrl: row.zoomJoinUrl ? String(row.zoomJoinUrl) : null,
          reminderMinutes: Number(row.reminderMinutes),
          targetType: "rep",
          hostName: String(row.repName),
          reps: [
            {
              id: String(row.repId),
              name: String(row.repName),
              timezone: String(row.repTimezone),
              weight: Number(row.repWeight),
              availability:
                row.repAvailability as PublicSchedule["reps"][number]["availability"],
              availabilityOverrides: (row.repAvailabilityOverrides ??
                {}) as PublicSchedule["reps"][number]["availabilityOverrides"],
              dailyMeetingLimit:
                row.repDailyMeetingLimit === null ||
                row.repDailyMeetingLimit === undefined
                  ? null
                  : Number(row.repDailyMeetingLimit),
              weeklyMeetingLimit:
                row.repWeeklyMeetingLimit === null ||
                row.repWeeklyMeetingLimit === undefined
                  ? null
                  : Number(row.repWeeklyMeetingLimit),
              calendarProvider: row.calendarProvider as CalendarOAuthProvider,
              calendarExternalAccountId,
              conflictCalendars,
            },
          ],
          requiredCohosts: readyRequiredCohosts,
          cohostGroups: [],
          teamMembers,
        };
      }
    }
    return {
      id: String(row.id),
      transactionId: String(row.externalId),
      status: row.status as ManagedBooking["status"],
      organizationName: String(row.organizationName),
      organizationSlug: String(row.organizationSlug),
      meetingTypeId: String(row.meetingTypeId),
      meetingTypeSlug: String(row.meetingTypeSlug),
      meetingTitle: String(row.meetingTitle),
      repId: String(row.repId),
      repName: String(row.repName),
      repTimezone: String(row.repTimezone),
      attendeeName: String(row.attendeeName),
      attendeeEmail: String(row.attendeeEmail),
      additionalAttendeeEmails: row.additionalAttendeeEmails as string[],
      teamMembers,
      startsAt: new Date(String(row.startsAt)).toISOString(),
      endsAt: new Date(String(row.endsAt)).toISOString(),
      durationMinutes: Number(row.durationMinutes),
      calendarProvider: row.calendarProvider as CalendarOAuthProvider,
      calendarExternalAccountId,
      externalEventId: row.externalEventId ? String(row.externalEventId) : null,
      conferenceProvider: row.conferenceProvider as ConferenceProvider,
      conferenceUrl: row.conferenceUrl ? String(row.conferenceUrl) : null,
      previousStartsAt: row.previousStartsAt
        ? new Date(String(row.previousStartsAt)).toISOString()
        : null,
      previousEndsAt: row.previousEndsAt
        ? new Date(String(row.previousEndsAt)).toISOString()
        : null,
      failedRouterCreate: Boolean(row.failedRouterCreate),
      rescheduleAllowedUntil:
        row.rescheduleCutoffMinutes === null ||
        row.rescheduleCutoffMinutes === undefined
          ? null
          : new Date(
              new Date(String(row.startsAt)).getTime() -
                Number(row.rescheduleCutoffMinutes) * 60_000,
            ).toISOString(),
      cancelAllowedUntil:
        row.cancelCutoffMinutes === null ||
        row.cancelCutoffMinutes === undefined
          ? null
          : new Date(
              new Date(String(row.startsAt)).getTime() -
                Number(row.cancelCutoffMinutes) * 60_000,
            ).toISOString(),
      rescheduleSchedule,
      error: row.lastError
        ? row.status === "reschedule_pending"
          ? "The calendar provider could not confirm the requested change. Both the original and requested times remain reserved."
          : row.status === "failed" && !calendarExternalAccountId
            ? "The calendar provider did not return a complete result. Verify the original calendar account before changing this booking."
            : "The requested calendar change could not be completed. The existing provider event remains active."
        : null,
    };
  }

  async legacyBookingCalendarAccountRepairContext(
    manageToken: string,
  ): Promise<LegacyBookingCalendarAccountRepairContext | null> {
    const [booking] = await this.sql`
      SELECT b.status, b.external_id, b.external_event_id, b.starts_at, b.ends_at,
             b.calendar_provider, c.external_account_id,
             o.slug AS organization_slug, r.id AS rep_id
      FROM bookings b
      JOIN organizations o ON o.id = b.organization_id
      JOIN reps r ON r.id = b.rep_id
      LEFT JOIN rep_calendar_connections c
        ON c.rep_id = b.rep_id AND c.provider = b.calendar_provider
      WHERE b.manage_token_hash = ${tokenHash(manageToken)}
        AND b.calendar_external_account_id IS NULL
        AND (
          (b.status = 'confirmed' AND b.external_event_id IS NOT NULL)
          OR (
            b.status = 'failed'
            AND (
              EXISTS (
                SELECT 1 FROM jobs reconciliation
                WHERE reconciliation.organization_id = b.organization_id
                  AND reconciliation.type = ${createReconciliationJobType}
                  AND reconciliation.payload->>'bookingId' = b.id::text
                  AND reconciliation.payload->>'reconciliationIntent' = 'resolve'
                  AND reconciliation.status = 'failed'
              )
              OR (
                b.router_session_id IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM jobs create_job
                  WHERE create_job.organization_id = b.organization_id
                    AND create_job.type = 'calendar.event.create'
                    AND create_job.payload->>'bookingId' = b.id::text
                    AND create_job.status IN ('failed', 'cancelled')
                )
              )
            )
          )
        )
    `;
    if (!booking) return null;
    return {
      status:
        booking.status as LegacyBookingCalendarAccountRepairContext["status"],
      organizationSlug: String(booking.organizationSlug),
      repId: String(booking.repId),
      calendarProvider:
        booking.calendarProvider as LegacyBookingCalendarAccountRepairContext["calendarProvider"],
      currentCalendarExternalAccountId: verifiedCalendarExternalAccountId(
        booking.externalAccountId,
      ),
      transactionId: String(booking.externalId),
      externalEventId: booking.externalEventId
        ? String(booking.externalEventId)
        : null,
      startsAt: new Date(String(booking.startsAt)).toISOString(),
      endsAt: new Date(String(booking.endsAt)).toISOString(),
    };
  }

  async bindLegacyBookingCalendarAccount(
    manageToken: string,
    proof: LegacyBookingCalendarAccountProof,
  ): Promise<boolean> {
    const calendarExternalAccountId = verifiedCalendarExternalAccountId(
      proof.calendarExternalAccountId,
    );
    if (!calendarExternalAccountId) {
      throw new CalendarAccountIdentityError(
        "The provider proof has no verified calendar-account identity.",
      );
    }
    if (
      !Number.isFinite(proof.startsAt.getTime()) ||
      !Number.isFinite(proof.endsAt.getTime()) ||
      proof.endsAt <= proof.startsAt ||
      proof.externalEventId.length < 1 ||
      proof.externalEventId.length > 2_048 ||
      proof.externalEventId !== proof.externalEventId.trim() ||
      nonPrintablePattern.test(proof.externalEventId)
    ) {
      throw new CalendarAccountIdentityError(
        "The provider proof does not identify a valid calendar event.",
      );
    }

    return this.sql.begin(async (transaction) => {
      const [booking] = await transaction`
        SELECT b.id, b.organization_id, b.status, b.external_id,
               b.external_event_id,
               b.starts_at, b.ends_at, b.rep_id, b.calendar_provider,
               b.calendar_external_account_id, b.router_session_id
        FROM bookings b
        WHERE b.manage_token_hash = ${tokenHash(manageToken)}
        FOR UPDATE
      `;
      if (!booking) return false;
      if (
        !["confirmed", "failed"].includes(String(booking.status)) ||
        (booking.status === "confirmed" &&
          (!booking.externalEventId ||
            String(booking.externalEventId) !== proof.externalEventId)) ||
        (booking.status === "failed" &&
          booking.externalEventId &&
          String(booking.externalEventId) !== proof.externalEventId) ||
        new Date(String(booking.startsAt)).getTime() !==
          proof.startsAt.getTime() ||
        new Date(String(booking.endsAt)).getTime() !== proof.endsAt.getTime()
      ) {
        throw new CalendarAccountIdentityError(
          "The provider proof does not exactly match this booking.",
        );
      }

      const currentExternalAccountId =
        await lockVerifiedCalendarExternalAccountId(
          transaction,
          String(booking.repId),
          booking.calendarProvider as CalendarOAuthProvider,
          false,
        );
      if (currentExternalAccountId !== calendarExternalAccountId) {
        throw new CalendarAccountIdentityError(
          "The provider proof does not match the currently connected calendar account.",
        );
      }
      if (
        booking.calendarExternalAccountId &&
        String(booking.calendarExternalAccountId) !== calendarExternalAccountId
      ) {
        throw new CalendarAccountIdentityError(
          "This booking is already bound to a different calendar account.",
        );
      }

      let failedReconciliationId: number | null = null;
      if (booking.status === "failed") {
        const originalCreates = await transaction`
          SELECT id, status
          FROM jobs
          WHERE organization_id = ${booking.organizationId}
            AND type = 'calendar.event.create'
            AND payload->>'bookingId' = ${String(booking.id)}
          ORDER BY id
          FOR UPDATE
        `;
        if (
          originalCreates.length !== 1 ||
          !["failed", "cancelled"].includes(String(originalCreates[0]!.status))
        ) {
          throw new CalendarAccountIdentityError(
            "The failed booking has no single terminal calendar create to repair.",
          );
        }
        if (!booking.routerSessionId) {
          const reconciliations = await transaction`
            SELECT id, status, payload
            FROM jobs
            WHERE organization_id = ${booking.organizationId}
              AND type = ${createReconciliationJobType}
              AND payload->>'bookingId' = ${String(booking.id)}
              AND payload->>'reconciliationIntent' = 'resolve'
            ORDER BY id
            FOR UPDATE
          `;
          if (
            reconciliations.length !== 1 ||
            reconciliations[0]!.status !== "failed" ||
            Number(
              (reconciliations[0]!.payload as Record<string, unknown>)
                .reconciliationForJobId,
            ) !== Number(originalCreates[0]!.id)
          ) {
            throw new CalendarAccountIdentityError(
              "The failed booking has no single stopped provider reconciliation to resume.",
            );
          }
          failedReconciliationId = Number(reconciliations[0]!.id);
        }
      }

      const resumesProviderReconciliation = failedReconciliationId !== null;

      const [bound] = await transaction`
        UPDATE bookings
        SET calendar_external_account_id = ${calendarExternalAccountId},
            external_event_id = CASE
              WHEN status = 'failed' THEN ${proof.externalEventId}
              ELSE external_event_id
            END,
            status = CASE
              WHEN status = 'failed' AND ${resumesProviderReconciliation}
                THEN 'pending'
              ELSE status
            END,
            last_error = CASE
              WHEN status = 'failed' AND ${resumesProviderReconciliation}
                THEN NULL
              ELSE last_error
            END,
            updated_at = now()
        WHERE id = ${booking.id}
          AND status = ${booking.status}
          AND (
            calendar_external_account_id IS NULL
            OR calendar_external_account_id = ${calendarExternalAccountId}
          )
        RETURNING id
      `;
      if (!bound) {
        throw new CalendarAccountIdentityError(
          "The booking changed before its calendar account could be bound.",
        );
      }
      await transaction`
        UPDATE jobs
        SET payload = jsonb_set(
          payload,
          '{calendarExternalAccountId}',
          to_jsonb(${calendarExternalAccountId}::text),
          true
        )
        WHERE organization_id = ${booking.organizationId}
          AND type IN (
            'calendar.event.create', 'calendar.event.create.reconcile',
            'calendar.event.update', 'calendar.event.cancel'
          )
          AND payload->>'bookingId' = ${String(booking.id)}
      `;
      if (failedReconciliationId !== null) {
        const [resumed] = await transaction`
          UPDATE jobs
          SET status = 'pending', attempts = 0, run_at = now(),
              completed_at = NULL, locked_at = NULL, claim_token = NULL,
              result = NULL, last_error = NULL
          WHERE id = ${failedReconciliationId}
            AND status = 'failed'
          RETURNING id
        `;
        if (!resumed) {
          throw new CalendarAccountIdentityError(
            "The provider reconciliation changed before it could be resumed.",
          );
        }
      }
      return true;
    });
  }

  async requestBookingReschedule(input: {
    manageToken: string;
    startsAt: Date;
    endsAt: Date;
    reminderMinutes: number;
    calendarQuote?: BookingCandidateQuote;
    providerEventAtRequested?: boolean;
  }): Promise<"reschedule_pending" | "confirmed"> {
    if (
      !Number.isFinite(input.startsAt.getTime()) ||
      !Number.isFinite(input.endsAt.getTime()) ||
      input.endsAt <= input.startsAt
    ) {
      throw new Error("Choose a valid meeting time.");
    }
    try {
      return await this.sql.begin(async (transaction) => {
        const [bookingIdentity] = await transaction`
          SELECT id, rep_id
          FROM bookings
          WHERE manage_token_hash = ${tokenHash(input.manageToken)}
        `;
        if (!bookingIdentity) throw new Error("Booking not found.");
        const [booking] = await transaction`
          SELECT b.id, b.status, b.starts_at, b.ends_at, b.external_id,
                 b.external_event_id, b.calendar_provider, b.conference_provider,
                 b.calendar_external_account_id,
                 b.buffer_before_minutes, b.buffer_after_minutes,
                 CASE
                   WHEN b.reschedule_cutoff_minutes IS NULL THEN true
                   ELSE now() < b.starts_at
                     - b.reschedule_cutoff_minutes * interval '1 minute'
                 END AS reschedule_allowed,
                 b.conference_url, b.attendee_name, b.attendee_email,
                 b.additional_attendee_emails,
                 b.attendee_notifications_enabled,
                 o.slug AS organization_slug, mt.slug AS scheduling_slug,
                 mt.title AS meeting_title, mt.description,
                 r.id AS rep_id, r.name AS rep_name, r.email AS rep_email,
                 r.timezone AS rep_timezone
          FROM bookings b
          JOIN organizations o ON o.id = b.organization_id
          JOIN meeting_types mt ON mt.id = b.meeting_type_id
          JOIN reps r ON r.id = b.rep_id
          WHERE b.id = ${bookingIdentity.id}
          FOR UPDATE OF b
        `;
        if (!booking) throw new Error("Booking not found.");
        let verifiedAccountId: string | undefined;
        const matchingCalendarAccount = async () =>
          (verifiedAccountId ??= await requireMatchingBookingCalendarAccount(
            transaction,
            booking,
          ));
        const lockCalendarQuote = async (): Promise<{
          calendarQuote: BookingCandidateQuote;
          cohostEmails: string[];
        }> => {
          if (!input.calendarQuote) {
            throw new CalendarSlotUnavailableError();
          }
          const calendarExternalAccountId = await matchingCalendarAccount();
          try {
            const calendarQuote = normalizeBookingCandidateQuote(
              input.calendarQuote,
            );
            if (
              calendarQuote.repId !== String(booking.repId) ||
              calendarQuote.calendarProvider !== booking.calendarProvider ||
              calendarQuote.calendarExternalAccountId !==
                calendarExternalAccountId
            ) {
              throw new CalendarSlotUnavailableError();
            }
            await lockBookingParticipantReps(transaction, [calendarQuote]);
            await lockMatchingAvailabilityQuote(transaction, calendarQuote, {
              requireActiveProvider: false,
              includeProviderDefault: true,
            });
            const cohostEmails = await lockBookingCohosts(
              transaction,
              String(booking.id),
              String(booking.repId),
              calendarQuote,
            );
            return { calendarQuote, cohostEmails };
          } catch (error) {
            if (error instanceof CalendarAccountIdentityError) {
              throw new CalendarSlotUnavailableError();
            }
            throw error;
          }
        };
        const exactRepeat =
          new Date(String(booking.startsAt)).getTime() ===
            input.startsAt.getTime() &&
          new Date(String(booking.endsAt)).getTime() === input.endsAt.getTime();
        if (booking.status === "reschedule_pending") {
          if (exactRepeat) {
            // Worker completion locks the job before the booking. This booking
            // lock already serializes retries; do not take the opposite lock
            // order just to acknowledge a pending/processing update.
            const [updateJob] = await transaction`
              SELECT id, status FROM jobs
              WHERE type = 'calendar.event.update'
                AND payload->>'bookingId' = ${String(booking.id)}
              ORDER BY id DESC
              LIMIT 1
            `;
            if (!updateJob) {
              throw new Error(
                "The pending reschedule is missing its calendar update job.",
              );
            }
            if (updateJob.status === "failed") {
              await matchingCalendarAccount();
              if (typeof input.providerEventAtRequested !== "boolean") {
                throw new Error(
                  "Provider event location proof is required to retry this uncertain reschedule.",
                );
              }
              if (!input.providerEventAtRequested) {
                await lockCalendarQuote();
              }
              await transaction`
                UPDATE jobs
                SET status = 'pending', attempts = 0, run_at = now(),
                    locked_at = null, claim_token = null,
                    completed_at = null, result = null, last_error = null
                WHERE id = ${updateJob.id} AND status = 'failed'
              `;
              await transaction`
                UPDATE bookings SET last_error = null, updated_at = now()
                WHERE id = ${booking.id}
              `;
            }
            return "reschedule_pending" as const;
          }
          throw new Error("A different reschedule is already pending.");
        }
        if (booking.status !== "confirmed") {
          throw new Error("Only confirmed meetings can be rescheduled.");
        }
        if (!booking.externalEventId) {
          throw new Error("The calendar event is not ready to reschedule.");
        }
        if (exactRepeat) return "confirmed" as const;
        if (!booking.rescheduleAllowed) {
          throw new BookingChangeCutoffError("reschedule");
        }
        const calendarExternalAccountId = await matchingCalendarAccount();
        const lockedQuote = await lockCalendarQuote();
        const protectedRange = protectedBookingRange(
          input.startsAt,
          input.endsAt,
          Number(booking.bufferBeforeMinutes),
          Number(booking.bufferAfterMinutes),
        );

        if (
          !(await bookingParticipantsAreAvailable(
            transaction,
            lockedQuote.calendarQuote,
            input.startsAt,
            protectedRange,
            String(booking.id),
          ))
        ) {
          throw new CalendarSlotUnavailableError();
        }

        await transaction`
          UPDATE bookings SET status = 'reschedule_pending',
            previous_starts_at = starts_at, previous_ends_at = ends_at,
            starts_at = ${input.startsAt}, ends_at = ${input.endsAt},
            last_error = null, updated_at = now()
          WHERE id = ${booking.id}
        `;

        await transaction`
          UPDATE jobs SET status = 'cancelled', completed_at = now()
          WHERE type = 'email.booking.reminder'
            AND payload->>'bookingId' = ${String(booking.id)}
            AND status = 'pending'
        `;
        await transaction`
          INSERT INTO jobs (organization_id, type, payload)
          SELECT b.organization_id, 'calendar.event.update',
                 ${transaction.json({
                   bookingId: String(booking.id),
                   externalId: String(booking.externalId),
                   externalEventId: String(booking.externalEventId),
                   organizationSlug: String(booking.organizationSlug),
                   schedulingSlug: String(booking.schedulingSlug),
                   repId: String(booking.repId),
                   repName: String(booking.repName),
                   repEmail: String(booking.repEmail),
                   repTimezone: String(booking.repTimezone),
                   provider: String(booking.calendarProvider),
                   calendarExternalAccountId,
                   startsAt: input.startsAt.toISOString(),
                   endsAt: input.endsAt.toISOString(),
                   previousStartsAt: new Date(
                     String(booking.startsAt),
                   ).toISOString(),
                   previousEndsAt: new Date(
                     String(booking.endsAt),
                   ).toISOString(),
                   subject: `${String(booking.meetingTitle)} · ${String(booking.attendeeName)}`,
                   description: String(booking.description),
                   attendeeName: String(booking.attendeeName),
                   attendeeEmail: booking.attendeeNotificationsEnabled
                     ? String(booking.attendeeEmail)
                     : null,
                   additionalAttendeeEmails:
                     booking.attendeeNotificationsEnabled
                       ? (booking.additionalAttendeeEmails as string[])
                       : [],
                   cohostEmails: lockedQuote.cohostEmails,
                   attendeeNotificationsEnabled: Boolean(
                     booking.attendeeNotificationsEnabled,
                   ),
                   conferenceProvider: String(booking.conferenceProvider),
                   conferenceUrl: booking.conferenceUrl
                     ? String(booking.conferenceUrl)
                     : null,
                   reminderMinutes: input.reminderMinutes,
                 } as JSONValue)}
          FROM bookings b WHERE b.id = ${booking.id}
        `;
        return "reschedule_pending" as const;
      });
    } catch (error) {
      if (isCalendarSlotDatabaseConflict(error)) {
        throw new CalendarSlotUnavailableError();
      }
      throw error;
    }
  }

  async requestBookingCancellation(
    manageToken: string,
  ): Promise<"cancel_pending" | "cancelled"> {
    return this.sql.begin(async (transaction) => {
      const [booking] = await transaction`
        SELECT b.id, b.status, b.last_error, b.external_event_id, b.calendar_provider,
               b.calendar_external_account_id,
               CASE
                 WHEN b.cancel_cutoff_minutes IS NULL THEN true
                 ELSE now() < b.starts_at
                   - b.cancel_cutoff_minutes * interval '1 minute'
               END AS cancel_allowed,
               b.external_id, o.slug AS organization_slug, r.id AS rep_id
        FROM bookings b
        JOIN organizations o ON o.id = b.organization_id
        JOIN reps r ON r.id = b.rep_id
        WHERE b.manage_token_hash = ${tokenHash(manageToken)}
        FOR UPDATE OF b
      `;
      if (!booking) throw new Error("Booking not found.");
      // A lost response or repeated submit must report the already committed
      // operation. Read its status under the same lock used to enqueue it.
      if (booking.status === "cancelled") return "cancelled" as const;
      if (booking.status === "cancel_pending") return "cancel_pending" as const;
      const cancelsUncertainReschedule =
        booking.status === "reschedule_pending" && Boolean(booking.lastError);
      if (booking.status !== "confirmed" && !cancelsUncertainReschedule) {
        throw new Error("Only confirmed meetings can be cancelled.");
      }
      if (booking.status === "confirmed" && !booking.cancelAllowed) {
        throw new BookingChangeCutoffError("cancel");
      }
      if (!booking.externalEventId) {
        throw new Error("The calendar event is not ready to cancel.");
      }
      const calendarExternalAccountId =
        await requireMatchingBookingCalendarAccount(transaction, booking);
      let uncertainRescheduleJobId: number | null = null;
      if (cancelsUncertainReschedule) {
        const [failedUpdateJob] = await transaction`
          SELECT id, status
          FROM jobs
          WHERE type = 'calendar.event.update'
            AND payload->>'bookingId' = ${String(booking.id)}
          ORDER BY id DESC
          LIMIT 1
          FOR UPDATE
        `;
        if (!failedUpdateJob || failedUpdateJob.status !== "failed") {
          throw new Error(
            "The uncertain reschedule does not have a terminal update job to close.",
          );
        }
        uncertainRescheduleJobId = Number(failedUpdateJob.id);
        await transaction`
          UPDATE jobs
          SET status = 'cancelled', completed_at = coalesce(completed_at, now()),
              locked_at = null, claim_token = null
          WHERE id = ${failedUpdateJob.id} AND status = 'failed'
        `;
      }

      await transaction`
        UPDATE bookings SET status = 'cancel_pending', last_error = null,
          updated_at = now() WHERE id = ${booking.id}
      `;
      await transaction`
        UPDATE jobs SET status = 'cancelled', completed_at = now()
        WHERE type = 'email.booking.reminder'
          AND payload->>'bookingId' = ${String(booking.id)}
          AND status = 'pending'
      `;
      await transaction`
        INSERT INTO jobs (organization_id, type, payload)
        SELECT b.organization_id, 'calendar.event.cancel',
               ${transaction.json({
                 bookingId: String(booking.id),
                 externalId: String(booking.externalId),
                 externalEventId: String(booking.externalEventId),
                 organizationSlug: String(booking.organizationSlug),
                 repId: String(booking.repId),
                 provider: String(booking.calendarProvider),
                 calendarExternalAccountId,
                 cancelsUncertainReschedule,
                 uncertainRescheduleJobId,
               } as JSONValue)}
        FROM bookings b WHERE b.id = ${booking.id}
      `;
      return "cancel_pending" as const;
    });
  }

  async bookingByExternalId(
    organizationSlug: string,
    externalId: string,
  ): Promise<BookingStatus | null> {
    const [row] = await this.sql`
      SELECT j.id, j.status, j.result, j.last_error,
             j.payload->>'manageToken' AS manage_token,
             b.external_id, b.manage_token_hash,
             b.conference_url
      FROM jobs j
      JOIN organizations o ON o.id = j.organization_id
      LEFT JOIN bookings b
        ON b.organization_id = j.organization_id
       AND (
         b.id::text = j.payload->>'bookingId'
         OR b.source_external_id = ${externalId}
         OR (
           b.source_external_id IS NULL
           AND b.external_id = ${externalId}
         )
       )
      WHERE o.slug = ${organizationSlug}
        AND j.type = 'calendar.event.create'
        AND (
          j.payload->>'sourceExternalId' = ${externalId}
          OR (
            NOT (j.payload ? 'sourceExternalId')
            AND j.payload->>'externalId' = ${externalId}
          )
        )
    `;
    return row ? bookingStatusFromRow(row) : null;
  }

  async bookingContext(
    organizationSlug: string,
    decisionId: string,
  ): Promise<
    | (RouteCandidate & {
        provider: CalendarOAuthProvider;
        calendarQuote: BookingCandidateQuote;
        bufferBeforeMinutes: number;
        bufferAfterMinutes: number;
      })
    | null
  > {
    const [row] = await this.sql`
      SELECT r.id, r.email, c.provider, c.external_account_id,
             mt.slug AS scheduling_slug
      FROM routing_decisions rd
      JOIN organizations o ON o.id = rd.organization_id
      JOIN reps r ON r.id = rd.rep_id
      JOIN rep_calendar_connections c
        ON c.rep_id = r.id AND c.provider = r.active_calendar_provider
      JOIN meeting_types mt
        ON mt.organization_id = rd.organization_id
       AND mt.rep_id = r.id
       AND mt.slug = r.scheduling_slug
       AND mt.active = true
      WHERE o.slug = ${organizationSlug} AND rd.id = ${decisionId}
    `;
    if (!row) return null;
    const schedule = await this.publicSchedule(
      organizationSlug,
      String(row.schedulingSlug),
    );
    const organizer = schedule?.reps.find(
      (candidate) => candidate.id === String(row.id),
    );
    if (!organizer || !schedule) return null;
    return {
      id: String(row.id),
      email: String(row.email),
      provider: row.provider as CalendarOAuthProvider,
      bufferBeforeMinutes: schedule.bufferBeforeMinutes,
      bufferAfterMinutes: schedule.bufferAfterMinutes,
      calendarQuote: {
        repId: organizer.id,
        calendarProvider: organizer.calendarProvider,
        calendarExternalAccountId: organizer.calendarExternalAccountId,
        conflictCalendars: organizer.conflictCalendars.map(
          ({ available: _available, ...calendar }) => calendar,
        ),
        requiredCohosts: schedule.requiredCohosts
          .filter((cohost) => cohost.id !== organizer.id)
          .map((cohost) => ({
            repId: cohost.id,
            calendarProvider: cohost.calendarProvider,
            calendarExternalAccountId: cohost.calendarExternalAccountId,
            conflictCalendars: cohost.conflictCalendars.map(
              ({ available: _available, ...calendar }) => calendar,
            ),
          })),
        cohostGroups: schedule.cohostGroups.map((group) => ({
          poolId: group.poolId,
          requiredForAvailability: group.requiredForAvailability,
          candidateQuotes: group.requiredForAvailability
            ? group.candidates
                .filter((candidate) => candidate.id !== organizer.id)
                .map((candidate) => ({
                  repId: candidate.id,
                  calendarProvider: candidate.calendarProvider,
                  calendarExternalAccountId:
                    candidate.calendarExternalAccountId,
                  conflictCalendars: candidate.conflictCalendars.map(
                    ({ available: _available, ...calendar }) => calendar,
                  ),
                }))
            : [],
        })),
      },
    };
  }

  async bookingStatus(
    organizationSlug: string,
    jobId: number,
  ): Promise<BookingStatus | null> {
    const [row] = await this.sql`
      SELECT j.id, j.status, j.result, j.last_error,
             j.payload->>'manageToken' AS manage_token,
             b.external_id, b.manage_token_hash,
             b.conference_url
      FROM jobs j
      JOIN organizations o ON o.id = j.organization_id
      LEFT JOIN bookings b
        ON b.organization_id = j.organization_id
       AND (
         b.id::text = j.payload->>'bookingId'
         OR b.external_id = j.payload->>'externalId'
       )
      WHERE o.slug = ${organizationSlug} AND j.id = ${jobId}
        AND j.type = 'calendar.event.create'
    `;
    return row ? bookingStatusFromRow(row) : null;
  }

  async connectionStatuses(
    organizationSlug: string,
  ): Promise<ConnectionStatus[]> {
    const rows = await this.sql`
      SELECT providers.provider, c.external_account_id, c.external_account_name,
             c.scopes, c.expires_at,
             CASE
               WHEN c.provider IN ('google', 'microsoft')
                 AND c.provider = (
                   SELECT c2.provider
                   FROM oauth_connections c2
                   WHERE c2.organization_id = o.id
                     AND c2.provider IN ('google', 'microsoft')
                     AND (
                       c2.provider = 'google'
                       OR c2.metadata->>'availabilityMode' = 'getSchedule'
                     )
                   ORDER BY c2.updated_at DESC, c2.provider DESC
                   LIMIT 1
                 )
               THEN true
               ELSE false
             END AS active
      FROM (
        VALUES ('hubspot'::text, 1), ('google'::text, 2), ('microsoft'::text, 3)
      ) AS providers(provider, position)
      CROSS JOIN organizations o
      LEFT JOIN oauth_connections c
        ON c.organization_id = o.id AND c.provider = providers.provider
      WHERE o.slug = ${organizationSlug}
      ORDER BY providers.position
    `;
    return rows.map((row) => ({
      provider: row.provider as OAuthProvider,
      connected: Boolean(row.expiresAt),
      active: Boolean(row.active),
      accountId: row.externalAccountId ? String(row.externalAccountId) : null,
      accountName: row.externalAccountName
        ? String(row.externalAccountName)
        : null,
      scopes: (row.scopes as string[] | null) ?? [],
      expiresAt: row.expiresAt
        ? new Date(String(row.expiresAt)).toISOString()
        : null,
    }));
  }
}
