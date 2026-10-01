import type { RouterLinkBookingRetryContext } from "@hot-potato/db";
import { describe, expect, it, vi } from "vitest";
import { verifiedFailedRouterProviderEvent } from "../app/router-booking-recovery";

const context: RouterLinkBookingRetryContext = {
  status: "failed",
  organizationSlug: "acme",
  schedule: null,
  repId: "rep-1",
  startsAt: "2031-01-01T15:00:00.000Z",
  endsAt: "2031-01-01T15:30:00.000Z",
  transactionId: "booking-manage-token",
  externalEventId: null,
  calendarProvider: "google",
  calendarExternalAccountId: null,
  currentCalendarExternalAccountId: "google-account-a",
};

describe("legacy Smart Router booking account recovery", () => {
  it("binds an unbound failure only after exact positive provider evidence", async () => {
    const event = {
      externalEventId: "google-event-a",
      webLink: null,
      conferenceUrl: null,
    };
    const findOwnedCalendarEvent = vi.fn().mockResolvedValue(event);
    const bindLegacyBookingCalendarAccount = vi.fn().mockResolvedValue(true);

    await expect(
      verifiedFailedRouterProviderEvent(context, {
        findOwnedCalendarEvent,
        bindLegacyBookingCalendarAccount,
      }),
    ).resolves.toEqual(event);
    expect(findOwnedCalendarEvent).toHaveBeenCalledWith({
      ...context,
      calendarExternalAccountId: "google-account-a",
    });
    expect(bindLegacyBookingCalendarAccount).toHaveBeenCalledWith(
      "booking-manage-token",
      {
        calendarExternalAccountId: "google-account-a",
        externalEventId: "google-event-a",
        startsAt: new Date(context.startsAt),
        endsAt: new Date(context.endsAt),
      },
    );
  });

  it("never treats absence in an unproven current account as safe", async () => {
    const bindLegacyBookingCalendarAccount = vi.fn();
    await expect(
      verifiedFailedRouterProviderEvent(context, {
        findOwnedCalendarEvent: vi.fn().mockResolvedValue(null),
        bindLegacyBookingCalendarAccount,
      }),
    ).rejects.toThrow("does not positively prove ownership");
    expect(bindLegacyBookingCalendarAccount).not.toHaveBeenCalled();
  });

  it("persists a newly recovered event ID for an already bound failure", async () => {
    const event = {
      externalEventId: "google-event-a",
      webLink: null,
      conferenceUrl: null,
    };
    const bindLegacyBookingCalendarAccount = vi.fn().mockResolvedValue(true);
    await expect(
      verifiedFailedRouterProviderEvent(
        { ...context, calendarExternalAccountId: "google-account-a" },
        {
          findOwnedCalendarEvent: vi.fn().mockResolvedValue(event),
          bindLegacyBookingCalendarAccount,
        },
      ),
    ).resolves.toEqual(event);
    expect(bindLegacyBookingCalendarAccount).toHaveBeenCalledWith(
      context.transactionId,
      {
        calendarExternalAccountId: "google-account-a",
        externalEventId: event.externalEventId,
        startsAt: new Date(context.startsAt),
        endsAt: new Date(context.endsAt),
      },
    );
  });
});
