import type {
  DateAvailabilityOverrides,
  Lead,
  Predicate,
  RoutingPreview,
  WeeklyAvailability,
} from "@hot-potato/router";

export type { RoutingPreview } from "@hot-potato/router";

export type RouteRequest = {
  organizationSlug: string;
  externalId?: string;
  lead: Lead;
  now?: Date;
  unavailableRepEmails?: string[];
  availabilitySource?:
    | "weekly_schedule"
    | "google_calendar"
    | "microsoft_calendar"
    | "connected_calendars";
  availabilitySourceByRepEmail?: Record<
    string,
    "google_calendar" | "microsoft_calendar" | "connected_calendars"
  >;
};

export type RouteDecision = {
  id: string;
  leadEmail: string;
  repName: string;
  repEmail: string;
  ruleName: string;
  poolName: string;
  reason: "rule_match" | "owner_preserved";
  createdAt: string;
  writebackStatus: string;
  availabilitySource:
    | "weekly_schedule"
    | "google_calendar"
    | "microsoft_calendar"
    | "connected_calendars";
};

export type OAuthProvider = "hubspot" | "google" | "microsoft";
export type CalendarOAuthProvider = Exclude<OAuthProvider, "hubspot">;
export type ConferenceProvider =
  | "none"
  | "google_meet"
  | "microsoft_teams"
  | "zoom";

export type EmailToolClientType = "gmail" | "outlook";

export type OperatorRole = "owner" | "admin" | "operator";

export type OperatorCredential = {
  operatorId: string;
  organizationId: string;
  organizationSlug: string;
  login: string;
  displayName: string;
  passwordHash: string;
  role: OperatorRole;
};

export type OperatorSessionIdentity = Omit<
  OperatorCredential,
  "passwordHash"
> & {
  sessionId: string;
  expiresAt: Date;
};

export type OperatorMember = {
  operatorId: string;
  login: string;
  displayName: string;
  role: OperatorRole;
  active: boolean;
  joinedAt: Date;
  lastSeenAt: Date | null;
  activeSessionCount: number;
  repId: string | null;
  repName: string | null;
  googleConnected: boolean;
  microsoftConnected: boolean;
};

export type OperatorInvitation = {
  id: string;
  login: string;
  displayName: string;
  role: OperatorRole;
  createdAt: Date;
  expiresAt: Date;
};

export type OperatorAccessOverview = {
  members: OperatorMember[];
  invitations: OperatorInvitation[];
};

export type OperatorAccessPurpose = "invite" | "password_reset";

export type OperatorAccessLink = {
  id: string;
  purpose: OperatorAccessPurpose;
  organizationId: string;
  organizationSlug: string;
  organizationName: string;
  operatorId: string | null;
  login: string;
  displayName: string;
  role: OperatorRole;
  expiresAt: Date;
};

export type OperatorSessionRecord = {
  sessionId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  userAgent: string | null;
};

export type OperatorRepCalendarProfile = {
  organization: { id: string; name: string; slug: string };
  rep: DashboardRep;
  availabilitySchedules: AvailabilitySchedule[];
};

export type RepCalendarOAuthReturnTo = "calendar-readiness" | "my-calendar";

export type RepCalendarOAuthAttempt = {
  repId: string;
  provider: CalendarOAuthProvider;
  returnTo: RepCalendarOAuthReturnTo;
};

export type EmailToolAccessKeyRecord = {
  id: string;
  organizationSlug: string;
  repId: string;
  clientType: EmailToolClientType;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  outlookIdentityLinked: boolean;
};

export type CreateEmailToolAccessKey = {
  organizationSlug: string;
  repId: string;
  clientType: EmailToolClientType;
  label: string;
  tokenHash: string;
};

export type ResolvedEmailToolAccess = {
  keyId: string;
  clientType: EmailToolClientType;
  label: string;
  createdAt: Date;
  lastUsedAt: Date;
  organization: {
    id: string;
    slug: string;
    name: string;
  };
  rep: {
    id: string;
    name: string;
    email: string;
  };
};

export type OutlookEmailIdentity = {
  tenantId: string;
  subject: string;
  assertedEmail: string | null;
};

export type BindOutlookEmailIdentity = OutlookEmailIdentity & {
  bootstrapTokenHash: string;
};

export type VerifiedRepIdentity = {
  organization: {
    id: string;
    slug: string;
    name: string;
  };
  rep: {
    id: string;
    name: string;
    email: string;
  };
};

export type EmailToolMeetingType = {
  id: string;
  slug: string;
  title: string;
  description: string;
  durationMinutes: number;
  conferenceProvider: ConferenceProvider;
  targetType: MeetingTypeTarget;
  targetName: string;
};

export type EmailToolSmartRouterLink = {
  id: string;
  slug: string;
  title: string;
  description: string;
  buttonLabel: string;
  accentColor: string;
};

export type EmailToolSchedulingCatalog = {
  organizationName: string;
  organizationSlug: string;
  repId: string;
  repName: string;
  recentLinkAssetId: string | null;
  recentMeetingTypeId: string | null;
  recentPurpose: "link" | "times" | null;
  meetingTypes: EmailToolMeetingType[];
  smartRouterLinks: EmailToolSmartRouterLink[];
};

export type OAuthConnection = {
  organizationSlug: string;
  provider: OAuthProvider;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  expiresAt: Date;
  scopes: string[];
  externalAccountId: string | null;
  externalAccountName: string | null;
  metadata: Record<string, unknown>;
  updatedAt: Date;
};

export type SaveOAuthConnection = Omit<OAuthConnection, "updatedAt">;

export type RepCalendarConnection = {
  organizationSlug: string;
  repId: string;
  provider: CalendarOAuthProvider;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  expiresAt: Date;
  scopes: string[];
  externalAccountId: string | null;
  externalAccountName: string | null;
  metadata: Record<string, unknown>;
  checkConflicts: boolean;
  calendarCatalogSyncedAt: Date | null;
  calendarCatalogError: string | null;
  updatedAt: Date;
};

export type SaveRepCalendarConnection = Omit<
  RepCalendarConnection,
  | "checkConflicts"
  | "calendarCatalogSyncedAt"
  | "calendarCatalogError"
  | "updatedAt"
>;

export type RepCalendarSource = {
  calendarId: string;
  name: string;
  isDefault: boolean;
  selected: boolean;
  available: boolean;
  lastSeenAt: string | null;
  missingSince: string | null;
};

export type CalendarConflictSource = {
  provider: CalendarOAuthProvider;
  calendarExternalAccountId: string;
  calendarId: string;
  available: boolean;
};

export type BookingConflictCalendarQuote = Omit<
  CalendarConflictSource,
  "available"
>;

export type BookingCalendarQuote = {
  repId: string;
  calendarProvider: CalendarOAuthProvider;
  calendarExternalAccountId: string;
  conflictCalendars: BookingConflictCalendarQuote[];
};

export type BookingCandidateQuote = BookingCalendarQuote & {
  requiredCohosts?: BookingCalendarQuote[];
  cohostGroups?: Array<{
    poolId: string;
    requiredForAvailability: boolean;
    candidateQuotes: BookingCalendarQuote[];
  }>;
};

export type RepBookingCapacityStart = {
  bookingId: string;
  startsAt: Date;
};

export type DashboardCalendarConnection = {
  connected: boolean;
  accountName: string | null;
  checkConflicts: boolean;
  canSyncCalendars: boolean;
  calendarCatalogSyncedAt: string | null;
  calendarCatalogError: string | null;
  calendars: RepCalendarSource[];
};

export type RouteCandidate = {
  id: string;
  email: string;
};

export type BookingStatus = {
  id: number;
  status: "pending" | "processing" | "completed" | "failed";
  externalEventId: string | null;
  webLink: string | null;
  error: string | null;
  managePath?: string | null;
  conferenceUrl?: string | null;
};

export type MeetingTypeTarget = "rep" | "pool";
export type InviteeLimitScope = "none" | "email" | "domain";

export type PublicScheduleRep = {
  id: string;
  name: string;
  timezone: string;
  weight: number;
  availability: WeeklyAvailability;
  availabilityOverrides: DateAvailabilityOverrides;
  dailyMeetingLimit: number | null;
  weeklyMeetingLimit: number | null;
  calendarProvider: CalendarOAuthProvider;
  calendarExternalAccountId: string;
  conflictCalendars: CalendarConflictSource[];
};

export type MeetingTeamMember = {
  repId: string;
  name: string;
  requiredForAvailability: boolean;
  poolId?: string | null;
  poolName?: string | null;
};

export type MeetingCohostGroup = {
  poolId: string;
  poolName: string;
  requiredForAvailability: boolean;
  candidates: PublicScheduleRep[];
};

export type MeetingTypeCohostGroup = Omit<MeetingCohostGroup, "candidates"> & {
  crmOwnerProperty: string | null;
};

export type PublicSchedule = {
  meetingTypeId: string;
  organizationName: string;
  organizationSlug: string;
  schedulingSlug: string;
  meetingTitle: string;
  meetingDescription: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumNoticeMinutes: number;
  bookingWindowDays: number;
  conferenceProvider: ConferenceProvider;
  zoomJoinUrl: string | null;
  reminderMinutes: number;
  targetType: MeetingTypeTarget;
  hostName: string;
  reps: PublicScheduleRep[];
  requiredCohosts: PublicScheduleRep[];
  cohostGroups: MeetingCohostGroup[];
  teamMembers: MeetingTeamMember[];
};

export type PublicBookingStatus = {
  status: BookingLifecycleStatus;
  error: string | null;
  managePath: string | null;
  conferenceUrl: string | null;
  repName: string | null;
  startsAt: string;
  endsAt: string;
};

export type BookingLifecycleStatus =
  | "attempting"
  | "pending"
  | "confirmed"
  | "reschedule_pending"
  | "cancel_pending"
  | "cancelled"
  | "failed";

export type ManagedBooking = {
  id: string;
  transactionId: string;
  status: BookingLifecycleStatus;
  organizationName: string;
  organizationSlug: string;
  meetingTypeId: string;
  meetingTypeSlug: string;
  meetingTitle: string;
  repId: string;
  repName: string;
  repTimezone: string;
  attendeeName: string;
  attendeeEmail: string;
  additionalAttendeeEmails: string[];
  teamMembers: MeetingTeamMember[];
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  calendarProvider: CalendarOAuthProvider;
  calendarExternalAccountId: string | null;
  externalEventId: string | null;
  conferenceProvider: ConferenceProvider;
  conferenceUrl: string | null;
  previousStartsAt: string | null;
  previousEndsAt: string | null;
  failedRouterCreate: boolean;
  rescheduleAllowedUntil: string | null;
  cancelAllowedUntil: string | null;
  rescheduleSchedule: PublicSchedule | null;
  error: string | null;
};

export type MeetingType = {
  id: string;
  slug: string;
  title: string;
  description: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minimumNoticeMinutes: number;
  bookingWindowDays: number;
  inviteeLimitScope: InviteeLimitScope;
  inviteeLimitCount: number | null;
  rescheduleCutoffMinutes: number | null;
  cancelCutoffMinutes: number | null;
  conferenceProvider: ConferenceProvider;
  zoomJoinUrl: string | null;
  reminderMinutes: number;
  active: boolean;
  targetType: MeetingTypeTarget;
  targetId: string;
  targetName: string;
  cohosts: MeetingTeamMember[];
  cohostGroups: MeetingTypeCohostGroup[];
};

export type RouterLinkQuestion = {
  field: string;
  label: string;
  type: "text" | "number" | "select";
  required: boolean;
  placeholder: string;
  helpText: string;
  options: string[];
};

export type RouterLinkDestination = {
  poolId: string;
  poolName: string;
  meetingTypeId: string;
  meetingTypeTitle: string;
  meetingTypeSlug: string;
};

export type RouterLink = {
  id: string;
  name: string;
  slug: string;
  title: string;
  description: string;
  buttonLabel: string;
  noMatchMessage: string;
  successRedirectUrl: string | null;
  successRedirectDelaySeconds: number;
  accentColor: string;
  active: boolean;
  questions: RouterLinkQuestion[];
  destinations: RouterLinkDestination[];
};

export type RouterLinkOutcome = "matched" | "no_match";

export type PublicRouterLink = Pick<
  RouterLink,
  | "id"
  | "slug"
  | "title"
  | "description"
  | "buttonLabel"
  | "noMatchMessage"
  | "successRedirectUrl"
  | "successRedirectDelaySeconds"
  | "accentColor"
  | "questions"
> & {
  organizationName: string;
  organizationSlug: string;
};

export type SaveRouterLink = Omit<
  RouterLink,
  "id" | "destinations" | "successRedirectUrl" | "successRedirectDelaySeconds"
> & {
  organizationSlug: string;
  id?: string;
  successRedirectUrl?: string | null;
  successRedirectDelaySeconds?: number;
  destinations: Array<{ poolId: string; meetingTypeId: string }>;
};

export type RouterFormBridgeProvider = "hubspot" | "manual";

export type RouterFormBridgeMapping = {
  attendeeNameFields: string[];
  attendeeEmailField: string;
  answerMappings: Record<string, string>;
};

export type RouterFormBridge = RouterFormBridgeMapping & {
  id: string;
  organizationSlug: string;
  routerLinkId: string;
  routerLinkName: string;
  routerLinkSlug: string;
  name: string;
  provider: RouterFormBridgeProvider;
  formId: string | null;
  allowedOrigins: string[];
  active: boolean;
  linkConfigVersion: number;
  currentLinkConfigVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type SaveRouterFormBridge = RouterFormBridgeMapping & {
  organizationSlug: string;
  id?: string;
  routerLinkId: string;
  name: string;
  provider: RouterFormBridgeProvider;
  formId?: string | null;
  allowedOrigins: string[];
  active: boolean;
};

export type PublicRouterFormBridgeConfig = {
  routerPath: string;
  provider: RouterFormBridgeProvider;
  formId: string | null;
  allowedOrigins: string[];
  mapping: RouterFormBridgeMapping;
};

export type RouterLinkMeetingType = {
  slug: string;
  title: string;
  description: string;
  durationMinutes: number;
  minimumNoticeMinutes: number;
  bookingWindowDays: number;
  conferenceProvider: ConferenceProvider;
  reminderMinutes: number;
};

export type QualifyRouterLinkRequest = {
  organizationSlug: string;
  routerSlug: string;
  sessionToken: string;
  attendeeName: string;
  attendeeEmail: string;
  answers: Record<string, unknown>;
  currentOwnerEmail?: string;
  now?: Date;
  expiresInMinutes?: number;
};

export type RouterLinkQualification = {
  outcome: RouterLinkOutcome;
  sessionToken: string;
  expiresAt: string;
  noMatchMessage: string;
  matchedRuleName: string | null;
  poolName: string | null;
  meetingType: RouterLinkMeetingType | null;
};

export type RouterLinkSession = {
  organizationSlug: string;
  routerSlug: string;
  sessionToken: string;
  attendeeName: string;
  attendeeEmail: string;
  lead: Lead;
  expiresAt: string;
  matchedRuleName: string;
  poolName: string;
  schedule: PublicSchedule;
};

export type RouterLinkBookingRetryContext = {
  status: BookingLifecycleStatus;
  organizationSlug: string;
  schedule: PublicSchedule | null;
  repId: string;
  startsAt: string;
  endsAt: string;
  transactionId: string;
  externalEventId: string | null;
  calendarProvider: CalendarOAuthProvider;
  calendarExternalAccountId: string | null;
  currentCalendarExternalAccountId: string | null;
};

export type LegacyBookingCalendarAccountRepairContext = {
  status: BookingLifecycleStatus;
  organizationSlug: string;
  repId: string;
  calendarProvider: CalendarOAuthProvider;
  currentCalendarExternalAccountId: string | null;
  transactionId: string;
  externalEventId: string | null;
  startsAt: string;
  endsAt: string;
};

export type LegacyBookingCalendarAccountProof = {
  calendarExternalAccountId: string;
  externalEventId: string;
  startsAt: Date;
  endsAt: Date;
};

export type ReconciledCalendarEvent = {
  externalEventId: string;
  webLink: string | null;
  conferenceUrl: string | null;
};

export type BookRouterLinkSessionRequest = {
  organizationSlug: string;
  routerSlug: string;
  sessionToken: string;
  attemptToken: string;
  candidateQuotes: BookingCandidateQuote[];
  startsAt: Date;
  endsAt: Date;
  additionalAttendeeEmails?: string[];
  now?: Date;
};

export type BeginRouterLinkBookingAttemptRequest = {
  organizationSlug: string;
  routerSlug: string;
  sessionToken: string;
  attemptToken: string;
  startsAt: Date;
  endsAt: Date;
  now?: Date;
};

export type BeginRouterLinkBookingAttemptResult =
  | { acquired: true }
  | { acquired: false; booking: PublicBookingStatus };

export type PublicRateLimitRequest = {
  organizationSlug: string;
  scope: string;
  identifier: string;
  limit: number;
  windowSeconds: number;
  now?: Date;
};

export type PublicRateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: string;
};

export type DashboardRep = {
  id: string;
  name: string;
  email: string;
  weight: number;
  active: boolean;
  timezone: string;
  availability: WeeklyAvailability;
  availabilityOverrides: DateAvailabilityOverrides;
  availabilityScheduleId: string | null;
  availabilityScheduleName: string | null;
  dailyMeetingLimit: number | null;
  weeklyMeetingLimit: number | null;
  assignments: number;
  schedulingSlug: string;
  meetingDurationMinutes: number;
  activeCalendarProvider: CalendarOAuthProvider | null;
  googleCalendar: DashboardCalendarConnection;
  microsoftCalendar: DashboardCalendarConnection;
};

export type AvailabilitySchedule = {
  id: string;
  name: string;
  availability: WeeklyAvailability;
  assignedRepCount: number;
};

export type DashboardPool = {
  id: string;
  name: string;
  slug: string;
  strategy: string;
  members: DashboardRep[];
};

export type DashboardRule = {
  id: string;
  name: string;
  priority: number;
  conditions: Record<string, Predicate>;
  poolId: string;
  poolName: string;
  active: boolean;
};

export type ConnectionStatus = {
  provider: OAuthProvider;
  connected: boolean;
  active: boolean;
  accountId: string | null;
  accountName: string | null;
  scopes: string[];
  expiresAt: string | null;
};

export type Dashboard = {
  organization: { name: string; slug: string };
  stats: {
    routesToday: number;
    activeReps: number;
    activeRules: number;
    pendingJobs: number;
  };
  reps: DashboardRep[];
  availabilitySchedules: AvailabilitySchedule[];
  pools: DashboardPool[];
  rules: DashboardRule[];
  meetingTypes: MeetingType[];
  routerLinks: RouterLink[];
  routerFormBridges: RouterFormBridge[];
  decisions: RouteDecision[];
};

export type BookingAttendanceOutcome = "unknown" | "attended" | "no_show";

export type ReportingRangeDays = 1 | 7 | 30 | 90;

export type ReportingSnapshot = {
  rangeDays: ReportingRangeDays;
  startsAt: string;
  generatedAt: string;
  funnel: {
    submissions: number;
    qualified: number;
    noMatch: number;
    bookings: number;
    conversionRate: number;
  };
  bookingHealth: {
    total: number;
    confirmed: number;
    inProgress: number;
    cancelled: number;
    failed: number;
    noShows: number;
  };
  routerLinks: Array<{
    id: string;
    name: string;
    active: boolean;
    submissions: number;
    qualified: number;
    bookings: number;
    conversionRate: number;
    lastActivityAt: string | null;
  }>;
  reps: Array<{
    id: string;
    name: string;
    active: boolean;
    routes: number;
    routeShare: number;
    meetings: number;
    confirmed: number;
    cancelled: number;
    noShows: number;
  }>;
  calendarDelivery: Array<{
    provider: CalendarOAuthProvider;
    total: number;
    confirmed: number;
    inProgress: number;
    failed: number;
    cancelled: number;
  }>;
  recentMeetings: Array<{
    id: string;
    attendeeName: string;
    attendeeEmail: string;
    meetingTitle: string;
    repName: string;
    calendarProvider: CalendarOAuthProvider;
    status: BookingLifecycleStatus;
    attendanceOutcome: BookingAttendanceOutcome;
    startsAt: string;
    endsAt: string;
    source: "smart_router" | "routing_api" | "scheduling_link";
  }>;
};

export type SaveRoutingRep = {
  organizationSlug: string;
  id?: string;
  name: string;
  email: string;
  timezone: string;
  weight: number;
  active: boolean;
  schedulingSlug: string;
};

export type SaveRoutingPool = {
  organizationSlug: string;
  id?: string;
  name: string;
  slug: string;
  memberIds: string[];
};

export type SaveRoutingRule = {
  organizationSlug: string;
  id?: string;
  name: string;
  priority: number;
  conditions: Record<string, Predicate>;
  poolId: string;
  active: boolean;
};

export type RoutingPreviewRequest = {
  organizationSlug: string;
  lead: Lead;
  evaluatedAt?: Date;
  unavailableRepEmails?: string[];
};

// Keep the imported type referenced here so declaration emit retains the
// public re-export used by the web workspace.
export type DashboardRoutingPreview = RoutingPreview;

export type Job = {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  claimToken: string;
};

export type OwnerWritebackResult =
  | { status: "completed"; externalReference: string }
  | { status: "superseded" };
