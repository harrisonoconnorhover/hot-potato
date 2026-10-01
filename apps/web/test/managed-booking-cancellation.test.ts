import type { ManagedBooking } from "@hot-potato/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  managedBooking: vi.fn(),
  cancel: vi.fn(),
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
  repository: { requestBookingCancellation: mocks.cancel },
}));

vi.mock("../app/public-scheduling", () => ({
  availableManagedSlotOptions: mocks.availableSlots,
  availableManagedSlots: mocks.managedSlots,
}));

vi.mock("../app/rep-calendar-availability", () => ({
  findOwnedRepCalendarEvent: mocks.findEvent,
}));

import { POST } from "../app/api/scheduling/manage/route";

const manageToken = "11111111-1111-4111-8111-111111111111";
const booking: ManagedBooking = {
  id: "booking-1",
  status: "confirmed",
  organizationName: "Acme",
  organizationSlug: "acme",
  meetingTypeId: "meeting-type-1",
  meetingTypeSlug: "discovery",
  meetingTitle: "Discovery call",
  repId: "rep-1",
  repName: "Alex Rep",
  repTimezone: "UTC",
  attendeeName: "Taylor Buyer",
  attendeeEmail: "taylor@example.com",
  additionalAttendeeEmails: [],
  teamMembers: [],
  startsAt: "2031-01-01T15:00:00.000Z",
  endsAt: "2031-01-01T15:30:00.000Z",
  durationMinutes: 30,
  calendarProvider: "google",
  calendarExternalAccountId: "google-account-1",
  transactionId: "provider-transaction-1",
  externalEventId: "google-event-1",
  conferenceProvider: "none",
  conferenceUrl: null,
  previousStartsAt: null,
  previousEndsAt: null,
  failedRouterCreate: false,
  rescheduleAllowedUntil: null,
  cancelAllowedUntil: null,
  rescheduleSchedule: null,
  error: null,
};

function request(body: unknown = { action: "cancel", token: manageToken }) {
  return new Request("https://schedule.example/api/scheduling/manage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network access is forbidden in this local rehearsal.");
    }),
  );
  mocks.managedBooking.mockResolvedValue(booking);
  mocks.cancel.mockResolvedValue("cancel_pending");
});

afterEach(() => {
  expect(mocks.findEvent).not.toHaveBeenCalled();
  expect(mocks.availableSlots).not.toHaveBeenCalled();
  expect(mocks.managedSlots).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("managed booking cancellation responses", () => {
  it("acknowledges an accepted cancellation and a retry after a lost response", async () => {
    mocks.managedBooking
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce({ ...booking, status: "cancel_pending" });

    const first = await POST(request());
    const repeated = await POST(request());

    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: "cancel_pending" });
    expect(repeated.status).toBe(202);
    expect(await repeated.json()).toEqual({ status: "cancel_pending" });
    expect(mocks.cancel).toHaveBeenCalledTimes(2);
    expect(mocks.cancel).toHaveBeenNthCalledWith(1, manageToken);
    expect(mocks.cancel).toHaveBeenNthCalledWith(2, manageToken);
  });

  it("reports a completed cancellation on later retries", async () => {
    mocks.managedBooking.mockResolvedValue({ ...booking, status: "cancelled" });
    mocks.cancel.mockResolvedValue("cancelled");

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "cancelled" });
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(manageToken);
  });

  it.each(["confirmed", "cancel_pending"] as const)(
    "uses the atomic cancellation result when the initial %s view becomes stale",
    async (status) => {
      mocks.managedBooking.mockResolvedValue({ ...booking, status });
      mocks.cancel.mockResolvedValue("cancelled");

      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "cancelled" });
      expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(manageToken);
    },
  );

  it.each([
    { action: "cancel", token: "invalid" },
    { action: "unknown", token: manageToken },
    null,
  ])("rejects invalid actions without mutation: %j", async (body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(mocks.managedBooking).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });

  it("does not mutate an unknown booking", async () => {
    mocks.managedBooking.mockResolvedValue(null);

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Booking not found." });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});
