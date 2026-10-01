import type { ManagedBooking } from "@hot-potato/db";
import { describe, expect, it, vi } from "vitest";
import { managedRescheduleSelection } from "../app/api/scheduling/manage/managed-reschedule";

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
  repTimezone: "America/New_York",
  attendeeName: "Taylor Buyer",
  attendeeEmail: "taylor@example.com",
  additionalAttendeeEmails: [],
  teamMembers: [],
  startsAt: "2031-01-01T15:00:00.000Z",
  endsAt: "2031-01-01T15:30:00.000Z",
  durationMinutes: 30,
  calendarProvider: "google",
  calendarExternalAccountId: "google-account-1",
  transactionId: "booking-provider-transaction-1",
  externalEventId: "google-event-1",
  conferenceProvider: "google_meet",
  conferenceUrl: null,
  previousStartsAt: null,
  previousEndsAt: null,
  failedRouterCreate: false,
  rescheduleAllowedUntil: null,
  cancelAllowedUntil: null,
  rescheduleSchedule: null,
  error: null,
};

describe("managed scheduling route", () => {
  it("retries an exact failed reschedule after proving the provider already moved it", async () => {
    const loadSlots = vi.fn().mockResolvedValue([]);
    const failedReschedule: ManagedBooking = {
      ...booking,
      status: "reschedule_pending",
      error:
        "The calendar provider could not confirm the requested change. Both times remain reserved.",
      previousStartsAt: "2031-01-01T14:00:00.000Z",
      previousEndsAt: "2031-01-01T14:30:00.000Z",
    };
    const findOwnedEventAtRange = vi.fn().mockResolvedValue({
      externalEventId: "google-event-1",
      webLink: null,
      conferenceUrl: null,
    });

    await expect(
      managedRescheduleSelection(
        failedReschedule,
        "2031-01-01T10:00:00-05:00",
        loadSlots,
        findOwnedEventAtRange,
      ),
    ).resolves.toEqual({
      slot: {
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
        candidateQuotes: [],
      },
      exactFailedRetry: true,
      providerEventAtRequested: true,
    });
    expect(loadSlots).not.toHaveBeenCalled();
    expect(findOwnedEventAtRange).toHaveBeenCalledWith({
      startsAt: new Date(booking.startsAt),
      endsAt: new Date(booking.endsAt),
    });
  });

  it("rechecks live availability after proving a failed reschedule stayed at its original time", async () => {
    const liveSlot = {
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      candidateQuotes: [
        {
          repId: booking.repId,
          calendarProvider: "google" as const,
          calendarExternalAccountId: "google-account-1",
          conflictCalendars: [
            {
              provider: "google" as const,
              calendarExternalAccountId: "google-account-1",
              calendarId: "primary",
            },
          ],
        },
      ],
    };
    const failedReschedule: ManagedBooking = {
      ...booking,
      status: "reschedule_pending",
      error: "Provider result uncertain.",
      previousStartsAt: "2031-01-01T14:00:00.000Z",
      previousEndsAt: "2031-01-01T14:30:00.000Z",
    };
    const findOwnedEventAtRange = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        externalEventId: "google-event-1",
        webLink: null,
        conferenceUrl: null,
      });
    const loadSlots = vi.fn().mockResolvedValue([liveSlot]);

    await expect(
      managedRescheduleSelection(
        failedReschedule,
        booking.startsAt,
        loadSlots,
        findOwnedEventAtRange,
      ),
    ).resolves.toEqual({
      slot: liveSlot,
      exactFailedRetry: true,
      providerEventAtRequested: false,
    });
    expect(findOwnedEventAtRange).toHaveBeenNthCalledWith(2, {
      startsAt: new Date(failedReschedule.previousStartsAt!),
      endsAt: new Date(failedReschedule.previousEndsAt!),
    });
    expect(loadSlots).toHaveBeenCalledWith(failedReschedule);
  });

  it("fails closed when neither requested nor original provider range is proven", async () => {
    const failedReschedule: ManagedBooking = {
      ...booking,
      status: "reschedule_pending",
      error: "Provider result uncertain.",
      previousStartsAt: "2031-01-01T14:00:00.000Z",
      previousEndsAt: "2031-01-01T14:30:00.000Z",
    };
    const loadSlots = vi.fn();
    const findOwnedEventAtRange = vi
      .fn()
      .mockRejectedValueOnce(new Error("event outside requested range"))
      .mockResolvedValueOnce(null);

    await expect(
      managedRescheduleSelection(
        failedReschedule,
        booking.startsAt,
        loadSlots,
        findOwnedEventAtRange,
      ),
    ).resolves.toBeNull();
    expect(loadSlots).not.toHaveBeenCalled();
  });

  it("still requires live availability for a new reschedule", async () => {
    const liveSlot = {
      startsAt: "2031-01-02T15:00:00.000Z",
      endsAt: "2031-01-02T15:30:00.000Z",
      candidateQuotes: [
        {
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
        },
      ],
    };
    const loadSlots = vi.fn().mockResolvedValue([liveSlot]);

    await expect(
      managedRescheduleSelection(booking, liveSlot.startsAt, loadSlots),
    ).resolves.toEqual({
      slot: liveSlot,
      exactFailedRetry: false,
      providerEventAtRequested: undefined,
    });
    expect(loadSlots).toHaveBeenCalledWith(booking);
  });
});
