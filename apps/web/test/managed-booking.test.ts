import type { ManagedBooking } from "@hot-potato/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  managedBooking: vi.fn(),
  repairContext: vi.fn(),
  bind: vi.fn(),
  findEvent: vi.fn(),
}));

vi.mock("../app/repository", () => ({
  repository: {
    managedBooking: mocks.managedBooking,
    legacyBookingCalendarAccountRepairContext: mocks.repairContext,
    bindLegacyBookingCalendarAccount: mocks.bind,
  },
}));

vi.mock("../app/rep-calendar-availability", () => ({
  findOwnedRepCalendarEvent: mocks.findEvent,
}));

import {
  managedBookingView,
  managedBookingWithVerifiedCalendar,
} from "../app/managed-booking";

const legacyBooking: ManagedBooking = {
  id: "booking-1",
  status: "confirmed",
  organizationName: "Acme",
  organizationSlug: "acme",
  meetingTypeId: "meeting-type-1",
  meetingTypeSlug: "discovery",
  meetingTitle: "Discovery call",
  repId: "rep-1",
  repName: "Alex Rep",
  repTimezone: "America/New_York",
  attendeeName: "Taylor Buyer",
  attendeeEmail: "taylor@example.com",
  additionalAttendeeEmails: [],
  teamMembers: [],
  startsAt: "2031-01-01T15:00:00.000Z",
  endsAt: "2031-01-01T15:30:00.000Z",
  durationMinutes: 30,
  calendarProvider: "google",
  calendarExternalAccountId: null,
  transactionId: "private-provider-transaction-id",
  externalEventId: "private-google-event-id",
  conferenceProvider: "google_meet",
  conferenceUrl: null,
  previousStartsAt: "2031-01-01T14:00:00.000Z",
  previousEndsAt: "2031-01-01T14:30:00.000Z",
  failedRouterCreate: false,
  rescheduleAllowedUntil: null,
  cancelAllowedUntil: null,
  rescheduleSchedule: null,
  error: null,
};

const repairContext = {
  status: "confirmed" as const,
  organizationSlug: "acme",
  repId: "rep-1",
  calendarProvider: "google" as const,
  currentCalendarExternalAccountId: "google-account-a",
  transactionId: "booking-external-id",
  externalEventId: "google-event-a",
  startsAt: legacyBooking.startsAt,
  endsAt: legacyBooking.endsAt,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.managedBooking.mockResolvedValue(legacyBooking);
  mocks.repairContext.mockResolvedValue(repairContext);
  mocks.bind.mockResolvedValue(true);
  mocks.findEvent.mockResolvedValue({
    externalEventId: "google-event-a",
    webLink: null,
    conferenceUrl: null,
  });
});

describe("legacy managed booking calendar repair", () => {
  it("never exposes provider account or conflict-calendar identities to attendees", () => {
    const view = managedBookingView({
      ...legacyBooking,
      calendarExternalAccountId: "private-google-account-id",
      rescheduleSchedule: {
        meetingTypeId: "meeting-type-1",
        organizationName: "Acme",
        organizationSlug: "acme",
        schedulingSlug: "discovery",
        meetingTitle: "Discovery call",
        meetingDescription: "A focused conversation.",
        durationMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        minimumNoticeMinutes: 60,
        bookingWindowDays: 14,
        conferenceProvider: "google_meet",
        zoomJoinUrl: null,
        reminderMinutes: 15,
        targetType: "rep",
        hostName: "Alex Rep",
        requiredCohosts: [],
        cohostGroups: [],
        teamMembers: [],
        reps: [
          {
            id: "rep-1",
            name: "Alex Rep",
            timezone: "America/New_York",
            weight: 1,
            availability: {},
            availabilityOverrides: {},
            dailyMeetingLimit: null,
            weeklyMeetingLimit: null,
            calendarProvider: "google",
            calendarExternalAccountId: "private-google-account-id",
            conflictCalendars: [
              {
                provider: "google",
                calendarExternalAccountId: "private-google-account-id",
                calendarId: "private-calendar-id",
                available: true,
              },
            ],
          },
        ],
      },
    });

    expect(view).not.toHaveProperty("calendarExternalAccountId");
    expect(view).not.toHaveProperty("transactionId");
    expect(view).not.toHaveProperty("externalEventId");
    expect(view).not.toHaveProperty("previousStartsAt");
    expect(view).not.toHaveProperty("previousEndsAt");
    expect(view).not.toHaveProperty("rescheduleSchedule");
    expect(JSON.stringify(view)).not.toContain("private-google-account-id");
    expect(JSON.stringify(view)).not.toContain("private-calendar-id");
    expect(JSON.stringify(view)).not.toContain("private-google-event-id");
    expect(JSON.stringify(view)).not.toContain(
      "private-provider-transaction-id",
    );
  });

  it("binds only after exact positive provider evidence and reloads the booking", async () => {
    const repaired = {
      ...legacyBooking,
      calendarExternalAccountId: "google-account-a",
    };
    mocks.managedBooking
      .mockResolvedValueOnce(legacyBooking)
      .mockResolvedValueOnce(repaired);

    await expect(
      managedBookingWithVerifiedCalendar("manage-token"),
    ).resolves.toEqual(repaired);
    expect(mocks.findEvent).toHaveBeenCalledWith({
      organizationSlug: "acme",
      repId: "rep-1",
      provider: "google",
      calendarExternalAccountId: "google-account-a",
      transactionId: "booking-external-id",
      externalEventId: "google-event-a",
      startsAt: new Date(legacyBooking.startsAt),
      endsAt: new Date(legacyBooking.endsAt),
    });
    expect(mocks.bind).toHaveBeenCalledWith("manage-token", {
      calendarExternalAccountId: "google-account-a",
      externalEventId: "google-event-a",
      startsAt: new Date(legacyBooking.startsAt),
      endsAt: new Date(legacyBooking.endsAt),
    });
  });

  it("keeps an unproven booking unbound when the current account has no event", async () => {
    mocks.findEvent.mockResolvedValue(null);

    const result = await managedBookingWithVerifiedCalendar("manage-token");

    expect(result?.calendarExternalAccountId).toBeNull();
    expect(result?.error).toContain("Reconnect the original Google or Outlook");
    expect(mocks.bind).not.toHaveBeenCalled();
  });

  it("resumes a stopped failed-create reconciliation only after positive evidence", async () => {
    const failed = {
      ...legacyBooking,
      status: "failed" as const,
      error: "The provider result is uncertain.",
    };
    const resumed = {
      ...failed,
      status: "pending" as const,
      calendarExternalAccountId: "google-account-a",
      error: null,
    };
    mocks.managedBooking
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(resumed);
    mocks.repairContext.mockResolvedValue({
      ...repairContext,
      status: "failed",
      externalEventId: null,
    });

    await expect(
      managedBookingWithVerifiedCalendar("manage-token"),
    ).resolves.toEqual(resumed);
    expect(mocks.bind).toHaveBeenCalledWith("manage-token", {
      calendarExternalAccountId: "google-account-a",
      externalEventId: "google-event-a",
      startsAt: new Date(legacyBooking.startsAt),
      endsAt: new Date(legacyBooking.endsAt),
    });
  });
});
