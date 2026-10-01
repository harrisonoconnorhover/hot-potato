import type { RouterLinkMeetingType } from "@hot-potato/db";

export type SmartRouterRecoverySlot = {
  startsAt: string;
  endsAt: string;
};

export type SmartRouterLinkIdentity = {
  organizationSlug: string;
  routerLinkId: string | null;
  routerSlug: string;
};

export type SmartRouterRecoveryState = {
  version: 1;
  organizationSlug: string;
  routerLinkId: string | null;
  routerSlug: string;
  sessionToken: string;
  selectedSlot: SmartRouterRecoverySlot | null;
  meetingType: RouterLinkMeetingType;
  bookingStarted: boolean;
};

const routerSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const stableIdPattern = /^[A-Za-z0-9_-]+$/;
const sessionTokenPattern = /^[A-Za-z0-9_-]+$/;
const conferenceProviders = new Set([
  "none",
  "google_meet",
  "microsoft_teams",
  "zoom",
]);

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(value: Record<string, unknown>, expected: string[]) {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function finiteNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function parseMeetingType(value: unknown): RouterLinkMeetingType | null {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      "slug",
      "title",
      "description",
      "durationMinutes",
      "minimumNoticeMinutes",
      "bookingWindowDays",
      "conferenceProvider",
      "reminderMinutes",
    ]) ||
    !boundedString(value.slug, 80) ||
    !routerSlugPattern.test(value.slug) ||
    !boundedString(value.title, 200) ||
    !boundedString(value.description, 1_000) ||
    !finiteNumber(value.durationMinutes, 5, 480) ||
    !finiteNumber(value.minimumNoticeMinutes, 0, 525_600) ||
    !finiteNumber(value.bookingWindowDays, 1, 730) ||
    typeof value.conferenceProvider !== "string" ||
    !conferenceProviders.has(value.conferenceProvider) ||
    !finiteNumber(value.reminderMinutes, 0, 525_600)
  ) {
    return null;
  }
  return {
    slug: value.slug,
    title: value.title,
    description: value.description,
    durationMinutes: value.durationMinutes,
    minimumNoticeMinutes: value.minimumNoticeMinutes,
    bookingWindowDays: value.bookingWindowDays,
    conferenceProvider:
      value.conferenceProvider as RouterLinkMeetingType["conferenceProvider"],
    reminderMinutes: value.reminderMinutes,
  };
}

function parseSlot(value: unknown): SmartRouterRecoverySlot | null {
  if (
    !plainRecord(value) ||
    !exactKeys(value, ["startsAt", "endsAt"]) ||
    typeof value.startsAt !== "string" ||
    typeof value.endsAt !== "string"
  ) {
    return null;
  }
  const startsAt = Date.parse(value.startsAt);
  const endsAt = Date.parse(value.endsAt);
  return Number.isFinite(startsAt) &&
    Number.isFinite(endsAt) &&
    endsAt > startsAt
    ? { startsAt: value.startsAt, endsAt: value.endsAt }
    : null;
}

export function smartRouterRecoveryStorageKey(
  identity: SmartRouterLinkIdentity,
) {
  const linkScope = identity.routerLinkId ?? `slug-${identity.routerSlug}`;
  return `hot-potato:smart-router:${encodeURIComponent(identity.organizationSlug)}:${encodeURIComponent(linkScope)}`;
}

export function serializeSmartRouterRecovery(value: SmartRouterRecoveryState) {
  const meetingType = value.meetingType;
  return JSON.stringify({
    version: 1,
    organizationSlug: value.organizationSlug,
    routerLinkId: value.routerLinkId,
    routerSlug: value.routerSlug,
    sessionToken: value.sessionToken,
    selectedSlot: value.selectedSlot
      ? {
          startsAt: value.selectedSlot.startsAt,
          endsAt: value.selectedSlot.endsAt,
        }
      : null,
    meetingType: {
      slug: meetingType.slug,
      title: meetingType.title,
      description: meetingType.description,
      durationMinutes: meetingType.durationMinutes,
      minimumNoticeMinutes: meetingType.minimumNoticeMinutes,
      bookingWindowDays: meetingType.bookingWindowDays,
      conferenceProvider: meetingType.conferenceProvider,
      reminderMinutes: meetingType.reminderMinutes,
    },
    bookingStarted: value.bookingStarted,
  } satisfies SmartRouterRecoveryState);
}

export function parseSmartRouterRecovery(
  raw: string | null,
  identity: SmartRouterLinkIdentity,
): SmartRouterRecoveryState | null {
  if (!raw || raw.length > 8_000) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !plainRecord(value) ||
      !exactKeys(value, [
        "version",
        "organizationSlug",
        "routerLinkId",
        "routerSlug",
        "sessionToken",
        "selectedSlot",
        "meetingType",
        "bookingStarted",
      ]) ||
      value.version !== 1 ||
      value.organizationSlug !== identity.organizationSlug ||
      typeof value.routerSlug !== "string" ||
      value.routerSlug.length > 80 ||
      !routerSlugPattern.test(value.routerSlug) ||
      typeof value.sessionToken !== "string" ||
      value.sessionToken.length < 32 ||
      value.sessionToken.length > 128 ||
      !sessionTokenPattern.test(value.sessionToken) ||
      typeof value.bookingStarted !== "boolean"
    ) {
      return null;
    }
    if (identity.routerLinkId) {
      if (
        value.routerLinkId !== identity.routerLinkId ||
        identity.routerLinkId.length > 128 ||
        !stableIdPattern.test(identity.routerLinkId)
      ) {
        return null;
      }
    } else if (
      value.routerLinkId !== null ||
      value.routerSlug !== identity.routerSlug
    ) {
      return null;
    }
    const meetingType = parseMeetingType(value.meetingType);
    if (!meetingType) return null;
    const selectedSlot =
      value.selectedSlot === null ? null : parseSlot(value.selectedSlot);
    if (value.selectedSlot !== null && !selectedSlot) return null;
    return {
      version: 1,
      organizationSlug: identity.organizationSlug,
      routerLinkId: identity.routerLinkId,
      routerSlug: identity.routerSlug,
      sessionToken: value.sessionToken,
      selectedSlot,
      meetingType,
      bookingStarted: value.bookingStarted,
    };
  } catch {
    return null;
  }
}

export function createSmartRouterRecovery(
  identity: SmartRouterLinkIdentity,
  sessionToken: string,
  meetingType: RouterLinkMeetingType,
): SmartRouterRecoveryState {
  return {
    version: 1,
    ...identity,
    sessionToken,
    selectedSlot: null,
    meetingType,
    bookingStarted: false,
  };
}

export function smartRouterAssignmentLocked(
  recovery: SmartRouterRecoveryState | null,
) {
  return Boolean(recovery?.bookingStarted);
}

export function reopenSmartRouterAvailability(
  recovery: SmartRouterRecoveryState,
): SmartRouterRecoveryState {
  return {
    ...recovery,
    selectedSlot: null,
    bookingStarted: false,
  };
}
