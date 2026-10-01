import type { ManagedBooking } from "@hot-potato/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  managedBooking: vi.fn(),
  reschedule: vi.fn(),
  availableSlots: vi.fn(),
  findEvent: vi.fn(),
}));

vi.mock("../app/managed-booking", () => ({
  managedBookingWithVerifiedCalendar: mocks.managedBooking,
  managedBookingView: (booking: unknown) => booking,
  unverifiedManagedBookingError: () => null,
}));
vi.mock("../app/repository", () => ({
  repository: { requestBookingReschedule: mocks.reschedule },
}));
vi.mock("../app/public-scheduling", () => ({
  availableManagedSlotOptions: mocks.availableSlots,
  availableManagedSlots: vi.fn(),
}));
vi.mock("../app/rep-calendar-availability", () => ({
  findOwnedRepCalendarEvent: mocks.findEvent,
}));

import { POST } from "../app/api/scheduling/manage/route";

const token = "11111111-1111-4111-8111-111111111111";
const booking: ManagedBooking = {
  id: "fictional-booking",
  status: "reschedule_pending",
  organizationName: "Fictional team",
  organizationSlug: "fictional-team",
  meetingTypeId: "fictional-meeting-type",
  meetingTypeSlug: "discovery",
  meetingTitle: "Discovery call",
  repId: "fictional-rep",
  repName: "Alex Rep",
  repTimezone: "UTC",
  attendeeName: "Taylor Buyer",
  attendeeEmail: "buyer@example.test",
  additionalAttendeeEmails: [],
  teamMembers: [],
  startsAt: "2031-01-01T15:00:00.000Z",
  endsAt: "2031-01-01T15:30:00.000Z",
  durationMinutes: 30,
  calendarProvider: "google",
  calendarExternalAccountId: "fictional-account",
  transactionId: "fictional-transaction",
  externalEventId: "fictional-event",
  conferenceProvider: "none",
  conferenceUrl: null,
  previousStartsAt: "2031-01-01T14:00:00.000Z",
  previousEndsAt: "2031-01-01T14:30:00.000Z",
  failedRouterCreate: false,
  rescheduleAllowedUntil: "2000-01-01T00:00:00.000Z",
  cancelAllowedUntil: null,
  rescheduleSchedule: null,
  error: null,
};

function request(startsAt = booking.startsAt) {
  return new Request("https://schedule.example.test/api/scheduling/manage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "reschedule", token, startsAt }),
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
  mocks.reschedule.mockResolvedValue("reschedule_pending");
  mocks.availableSlots.mockResolvedValue([]);
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("managed reschedule repeated submits", () => {
  it("acknowledges a pending reschedule after a lost response without fresh availability", async () => {
    const first = await POST(request());
    const repeated = await POST(request("2031-01-01T15:00:00Z"));
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ status: "reschedule_pending" });
    expect(repeated.status).toBe(202);
    expect(await repeated.json()).toEqual({ status: "reschedule_pending" });
    expect(mocks.reschedule).toHaveBeenCalledTimes(2);
    expect(mocks.reschedule).toHaveBeenLastCalledWith({
      manageToken: token,
      startsAt: new Date(booking.startsAt),
      endsAt: new Date(booking.endsAt),
      reminderMinutes: 0,
    });
    expect(mocks.availableSlots).not.toHaveBeenCalled();
    expect(mocks.findEvent).not.toHaveBeenCalled();
  });

  it.each(["confirmed", "reschedule_pending"] as const)(
    "returns the atomic completed result if the initial %s view is stale",
    async (status) => {
      mocks.managedBooking.mockResolvedValue({ ...booking, status });
      mocks.reschedule.mockResolvedValue("confirmed");
      const response = await POST(request());
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "confirmed" });
      expect(mocks.availableSlots).not.toHaveBeenCalled();
      expect(mocks.findEvent).not.toHaveBeenCalled();
    },
  );

  it("rejects a retry if the accepted update failed after the initial view", async () => {
    mocks.reschedule.mockRejectedValue(
      new Error(
        "Provider event location proof is required to retry this uncertain reschedule.",
      ),
    );
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("Provider event location proof"),
    });
    expect(mocks.reschedule.mock.calls[0]?.[0]).not.toHaveProperty(
      "providerEventAtRequested",
    );
    expect(mocks.findEvent).not.toHaveBeenCalled();
  });

  it("requires live availability for a different target", async () => {
    mocks.managedBooking.mockResolvedValue({ ...booking, status: "confirmed" });
    const response = await POST(request("2031-01-02T15:00:00.000Z"));
    expect(response.status).toBe(409);
    expect(mocks.availableSlots).toHaveBeenCalledOnce();
    expect(mocks.reschedule).not.toHaveBeenCalled();
  });

  it("preserves provider proof for an exact failed reschedule retry", async () => {
    mocks.managedBooking.mockResolvedValue({
      ...booking,
      error: "Provider result uncertain.",
    });
    mocks.findEvent.mockResolvedValue({
      externalEventId: booking.externalEventId,
      webLink: null,
      conferenceUrl: null,
    });
    const response = await POST(request());
    expect(response.status).toBe(202);
    expect(mocks.findEvent).toHaveBeenCalledOnce();
    expect(mocks.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({
        providerEventAtRequested: true,
      }),
    );
  });

  it("fails closed when an uncertain provider event cannot be located", async () => {
    mocks.managedBooking.mockResolvedValue({
      ...booking,
      error: "Provider result uncertain.",
    });
    mocks.findEvent.mockResolvedValue(null);
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(mocks.findEvent).toHaveBeenCalledTimes(2);
    expect(mocks.reschedule).not.toHaveBeenCalled();
  });
});
