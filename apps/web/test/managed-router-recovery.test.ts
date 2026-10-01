import type {
  ManagedBooking,
  RouterLinkBookingRetryContext,
} from "@hot-potato/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  managedBooking: vi.fn(),
  retryContext: vi.fn(),
  retry: vi.fn(),
  abandon: vi.fn(),
  bind: vi.fn(),
  availableSlots: vi.fn(),
  managedSlots: vi.fn(),
  findEvent: vi.fn(),
}));

vi.mock("../app/managed-booking", () => ({
  managedBookingWithVerifiedCalendar: mocks.managedBooking,
  managedBookingView: (booking: unknown) => booking,
  unverifiedManagedBookingError: () => null,
}));

vi.mock("../app/repository", () => ({
  repository: {
    managedRouterLinkBookingRetryContext: mocks.retryContext,
    retryManagedRouterLinkBooking: mocks.retry,
    abandonManagedRouterLinkBooking: mocks.abandon,
    bindLegacyBookingCalendarAccount: mocks.bind,
  },
}));

vi.mock("../app/public-scheduling", () => ({
  availableManagedSlotOptions: mocks.availableSlots,
  availableManagedSlots: mocks.managedSlots,
}));

vi.mock("../app/rep-calendar-availability", () => ({
  findOwnedRepCalendarEvent: mocks.findEvent,
}));

import { GET, POST } from "../app/api/scheduling/manage/route";

const manageToken = "11111111-1111-4111-8111-111111111111";
const startsAt = "2031-01-01T15:00:00.000Z";
const endsAt = "2031-01-01T15:30:00.000Z";
const calendarQuote = {
  repId: "rep-1",
  calendarProvider: "google" as const,
  calendarExternalAccountId: "google-account-1",
  conflictCalendars: [
    {
      provider: "google" as const,
      calendarExternalAccountId: "google-account-1",
      calendarId: "primary",
    },
  ],
};
const booking: ManagedBooking = {
  id: "booking-1",
  status: "failed",
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
  startsAt,
  endsAt,
  durationMinutes: 30,
  calendarProvider: "google",
  calendarExternalAccountId: "google-account-1",
  transactionId: "provider-transaction-not-manage-token",
  externalEventId: null,
  conferenceProvider: "google_meet",
  conferenceUrl: null,
  previousStartsAt: null,
  previousEndsAt: null,
  failedRouterCreate: true,
  rescheduleAllowedUntil: null,
  cancelAllowedUntil: null,
  rescheduleSchedule: null,
  error: "Provider result uncertain.",
};
const retryContext: RouterLinkBookingRetryContext = {
  status: "failed",
  organizationSlug: "acme",
  schedule: null,
  repId: booking.repId,
  startsAt,
  endsAt,
  transactionId: booking.transactionId,
  externalEventId: null,
  calendarProvider: "google",
  calendarExternalAccountId: "google-account-1",
  currentCalendarExternalAccountId: "google-account-1",
};

function request(action: "retry_failed_router" | "close_failed_router") {
  return new Request("https://schedule.example/api/scheduling/manage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, token: manageToken }),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.managedBooking.mockResolvedValue(booking);
  mocks.retryContext.mockResolvedValue(retryContext);
  mocks.bind.mockResolvedValue(true);
  mocks.findEvent.mockResolvedValue(null);
  mocks.availableSlots.mockResolvedValue([
    { startsAt, endsAt, candidateQuotes: [calendarQuote] },
  ]);
  mocks.managedSlots.mockResolvedValue([]);
  mocks.retry.mockResolvedValue({ status: "pending" });
  mocks.abandon.mockResolvedValue({ status: "cancel_pending" });
});

describe("manage-token Smart Router recovery", () => {
  it("does not load reschedule slots after the saved buyer deadline", async () => {
    mocks.managedBooking.mockResolvedValue({
      ...booking,
      status: "confirmed",
      failedRouterCreate: false,
      externalEventId: "google-event-1",
      rescheduleAllowedUntil: "2000-01-01T00:00:00.000Z",
      error: null,
    });

    const response = await GET(
      new Request(
        `https://schedule.example/api/scheduling/manage?token=${manageToken}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ slots: [] });
    expect(mocks.managedSlots).not.toHaveBeenCalled();
  });

  it("rechecks and transactionally carries the exact quote into retry", async () => {
    const response = await POST(request("retry_failed_router"));

    expect(response.status).toBe(202);
    expect(mocks.findEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionId: "provider-transaction-not-manage-token",
        calendarExternalAccountId: "google-account-1",
      }),
    );
    expect(mocks.availableSlots).toHaveBeenCalledWith(
      booking,
      booking.transactionId,
    );
    expect(mocks.retry).toHaveBeenCalledWith(manageToken, calendarQuote);
  });

  it("uses positive provider evidence before closing from the durable link", async () => {
    const providerEvent = {
      externalEventId: "google-event-1",
      webLink: null,
      conferenceUrl: null,
    };
    mocks.findEvent.mockResolvedValue(providerEvent);

    const response = await POST(request("close_failed_router"));

    expect(response.status).toBe(202);
    expect(mocks.abandon).toHaveBeenCalledWith(manageToken, providerEvent);
    expect(mocks.availableSlots).not.toHaveBeenCalled();
  });
});
