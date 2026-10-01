import type { PublicSchedule } from "@hot-potato/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  publicRouterLink: vi.fn(),
  routerLinkBookingStatus: vi.fn(),
  routerLinkBookingRetryContext: vi.fn(),
  retryRouterLinkBooking: vi.fn(),
  abandonRouterLinkBooking: vi.fn(),
  bindLegacyBookingCalendarAccount: vi.fn(),
  consumePublicRateLimit: vi.fn(),
  availablePublicSlotOptions: vi.fn(),
  findOwnedRepCalendarEvent: vi.fn(),
}));

vi.mock("../app/repository", () => ({
  repository: {
    publicRouterLink: mocks.publicRouterLink,
    routerLinkBookingStatus: mocks.routerLinkBookingStatus,
    routerLinkBookingRetryContext: mocks.routerLinkBookingRetryContext,
    retryRouterLinkBooking: mocks.retryRouterLinkBooking,
    abandonRouterLinkBooking: mocks.abandonRouterLinkBooking,
    bindLegacyBookingCalendarAccount: mocks.bindLegacyBookingCalendarAccount,
    consumePublicRateLimit: mocks.consumePublicRateLimit,
  },
}));

vi.mock("../app/public-scheduling", () => ({
  availablePublicSlotOptions: mocks.availablePublicSlotOptions,
}));

vi.mock("../app/rep-calendar-availability", () => ({
  findOwnedRepCalendarEvent: mocks.findOwnedRepCalendarEvent,
}));

import { POST as abandonBooking } from "../app/api/router-links/[organizationSlug]/[routerSlug]/bookings/abandon/route";
import { POST as retryBooking } from "../app/api/router-links/[organizationSlug]/[routerSlug]/bookings/retry/route";
import { POST as bookingStatus } from "../app/api/router-links/[organizationSlug]/[routerSlug]/bookings/status/route";

const sessionToken = "public-recovery-token-abcdefghijklmnopqrstuvwxyz";
const startsAt = "2026-09-03T15:00:00.000Z";
const endsAt = "2026-09-03T15:30:00.000Z";
const repOneQuote = {
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
const schedule = {
  meetingTypeId: "3dc7de9f-10bb-476d-84dc-7607abbe8ef3",
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
  targetType: "pool",
  hostName: "Sales",
  reps: [],
  requiredCohosts: [],
  cohostGroups: [],
  teamMembers: [],
} satisfies PublicSchedule;

function request(path: string) {
  return new Request(`https://schedule.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionToken }),
  });
}

function context(routerSlug = "old-router-slug") {
  return {
    params: Promise.resolve({
      organizationSlug: "acme",
      routerSlug,
    }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.consumePublicRateLimit.mockResolvedValue({
    allowed: true,
    remaining: 10,
    resetAt: new Date(Date.now() + 60_000).toISOString(),
  });
  mocks.findOwnedRepCalendarEvent.mockResolvedValue(null);
  mocks.bindLegacyBookingCalendarAccount.mockResolvedValue(true);
});

describe("public Smart Router booking recovery", () => {
  it("loads booked status by token even when the old public slug no longer resolves", async () => {
    mocks.routerLinkBookingStatus.mockResolvedValue({
      status: "confirmed",
      error: null,
      managePath: "/schedule/manage/public-token",
      conferenceUrl: "https://meet.example/join",
      repName: "Morgan Rep",
    });

    const response = await bookingStatus(
      request("/api/router-links/acme/old-router-slug/bookings/status"),
      context(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "confirmed" });
    expect(mocks.publicRouterLink).not.toHaveBeenCalled();
    expect(mocks.routerLinkBookingStatus).toHaveBeenCalledWith(
      "acme",
      "old-router-slug",
      sessionToken,
    );
  });

  it("rechecks the exact assigned rep slot before requeueing the same booking", async () => {
    mocks.routerLinkBookingRetryContext.mockResolvedValue({
      status: "failed",
      organizationSlug: "acme",
      schedule,
      repId: "rep-1",
      startsAt,
      endsAt,
      transactionId: "public-token",
      externalEventId: null,
      calendarProvider: "google",
      calendarExternalAccountId: "google-account-1",
      currentCalendarExternalAccountId: "google-account-1",
    });
    mocks.availablePublicSlotOptions.mockResolvedValue([
      { startsAt, endsAt, candidateQuotes: [repOneQuote] },
    ]);
    mocks.retryRouterLinkBooking.mockResolvedValue({
      status: "pending",
      error: null,
      managePath: "/schedule/manage/public-token",
      conferenceUrl: null,
      repName: "Morgan Rep",
    });

    const response = await retryBooking(
      request("/api/router-links/acme/old-router-slug/bookings/retry"),
      context(),
    );

    expect(response.status).toBe(202);
    expect(mocks.availablePublicSlotOptions).toHaveBeenCalledWith(
      schedule,
      expect.any(Date),
      "rep-1",
      "public-token",
    );
    expect(mocks.retryRouterLinkBooking).toHaveBeenCalledWith(
      "acme",
      "old-router-slug",
      sessionToken,
      repOneQuote,
    );
  });

  it("fails closed when the original assigned slot is no longer available", async () => {
    mocks.routerLinkBookingRetryContext.mockResolvedValue({
      status: "failed",
      organizationSlug: "acme",
      schedule,
      repId: "rep-1",
      startsAt,
      endsAt,
      transactionId: "public-token",
      externalEventId: null,
      calendarProvider: "google",
      calendarExternalAccountId: "google-account-1",
      currentCalendarExternalAccountId: "google-account-1",
    });
    mocks.availablePublicSlotOptions.mockResolvedValue([]);

    const response = await retryBooking(
      request("/api/router-links/acme/old-router-slug/bookings/retry"),
      context(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "slot_unavailable" });
    expect(mocks.retryRouterLinkBooking).not.toHaveBeenCalled();
  });

  it("positively binds and retries a migrated owned provider event", async () => {
    mocks.routerLinkBookingRetryContext.mockResolvedValue({
      status: "failed",
      organizationSlug: "acme",
      schedule,
      repId: "rep-1",
      startsAt,
      endsAt,
      transactionId: "public-token",
      externalEventId: null,
      calendarProvider: "google",
      calendarExternalAccountId: null,
      currentCalendarExternalAccountId: "google-account-1",
    });
    mocks.findOwnedRepCalendarEvent.mockResolvedValue({
      externalEventId: "owned-google-event",
      webLink: null,
      conferenceUrl: null,
    });
    mocks.retryRouterLinkBooking.mockResolvedValue({
      status: "pending",
      error: null,
      managePath: "/schedule/manage/public-token",
      conferenceUrl: null,
      repName: "Morgan Rep",
    });

    const response = await retryBooking(
      request("/api/router-links/acme/old-router-slug/bookings/retry"),
      context(),
    );
    expect(response.status).toBe(202);
    expect(mocks.bindLegacyBookingCalendarAccount).toHaveBeenCalledWith(
      "public-token",
      {
        calendarExternalAccountId: "google-account-1",
        externalEventId: "owned-google-event",
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
      },
    );
    expect(mocks.availablePublicSlotOptions).not.toHaveBeenCalled();
    expect(mocks.retryRouterLinkBooking).toHaveBeenCalledWith(
      "acme",
      "old-router-slug",
      sessionToken,
      undefined,
    );
  });

  it("fails closed without mutation when provider reconciliation is uncertain", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.routerLinkBookingRetryContext.mockResolvedValue({
      status: "failed",
      organizationSlug: "acme",
      schedule,
      repId: "rep-1",
      startsAt,
      endsAt,
      transactionId: "public-token",
      externalEventId: null,
      calendarProvider: "microsoft",
      calendarExternalAccountId: "microsoft-account-1",
      currentCalendarExternalAccountId: "microsoft-account-1",
    });
    mocks.findOwnedRepCalendarEvent.mockRejectedValue(
      new Error("provider timeout"),
    );
    const response = await retryBooking(
      request("/api/router-links/acme/old-router-slug/bookings/retry"),
      context(),
    );
    expect(response.status).toBe(503);
    expect(mocks.retryRouterLinkBooking).not.toHaveBeenCalled();
  });

  it("keeps a terminal failed booking reserved while durable close attestation begins", async () => {
    mocks.routerLinkBookingRetryContext.mockResolvedValue({
      status: "failed",
      organizationSlug: "acme",
      schedule,
      repId: "rep-1",
      startsAt,
      endsAt,
      transactionId: "public-token",
      externalEventId: null,
      calendarProvider: "google",
      calendarExternalAccountId: "google-account-1",
      currentCalendarExternalAccountId: "google-account-1",
    });
    mocks.abandonRouterLinkBooking.mockResolvedValue({
      status: "cancel_pending",
      error: "private provider error",
      managePath: "/schedule/manage/public-token",
      conferenceUrl: null,
      repName: "Morgan Rep",
    });

    const response = await abandonBooking(
      request("/api/router-links/acme/old-router-slug/bookings/abandon"),
      context(),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "cancel_pending",
      error: null,
      managePath: "/schedule/manage/public-token",
      conferenceUrl: null,
      repName: "Morgan Rep",
    });
    expect(mocks.publicRouterLink).not.toHaveBeenCalled();
    expect(mocks.abandonRouterLinkBooking).toHaveBeenCalledWith(
      "acme",
      "old-router-slug",
      sessionToken,
      null,
    );
  });

  it("returns 202 and preserves the provider event for cancellation", async () => {
    mocks.routerLinkBookingRetryContext.mockResolvedValue({
      status: "failed",
      organizationSlug: "acme",
      schedule,
      repId: "rep-1",
      startsAt,
      endsAt,
      transactionId: "public-token",
      externalEventId: null,
      calendarProvider: "google",
      calendarExternalAccountId: "google-account-1",
      currentCalendarExternalAccountId: "google-account-1",
    });
    const providerEvent = {
      externalEventId: "owned-google-event",
      webLink: "https://calendar.google.com/owned",
      conferenceUrl: null,
    };
    mocks.findOwnedRepCalendarEvent.mockResolvedValue(providerEvent);
    mocks.abandonRouterLinkBooking.mockResolvedValue({
      status: "cancel_pending",
      error: "private provider error",
      managePath: "/schedule/manage/public-token",
      conferenceUrl: null,
      repName: "Morgan Rep",
    });

    const response = await abandonBooking(
      request("/api/router-links/acme/old-router-slug/bookings/abandon"),
      context(),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "cancel_pending" });
    expect(mocks.abandonRouterLinkBooking).toHaveBeenCalledWith(
      "acme",
      "old-router-slug",
      sessionToken,
      providerEvent,
    );
  });
});
