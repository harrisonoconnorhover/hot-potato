import type {
  BookingCandidateQuote,
  PublicBookingStatus,
  PublicSchedule,
  RouterLinkQualification,
  RouterLinkSession,
} from "@hot-potato/db";
import { CalendarSlotUnavailableError } from "@hot-potato/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abandonBookingHandoffRequest,
  availabilityHandoffRequest,
  bookingHandoffRequest,
  bookingStatusHandoffRequest,
  qualifyHandoffRequest,
  retryBookingHandoffRequest,
  type HandoffDependencies,
  type HandoffRepository,
} from "../app/handoff-api";

type OperatorQualification = RouterLinkQualification & {
  matchedRuleName: string | null;
  poolName: string | null;
};

const sessionToken = "operator-session-token-abcdefghijklmnopqrstuvwxyz";
const startsAt = "2026-09-02T15:00:00.000Z";
const endsAt = "2026-09-02T15:30:00.000Z";

function candidateQuote(repId = "rep-1"): BookingCandidateQuote {
  const accountId =
    repId === "rep-1" ? "google-account-1" : `${repId}-google-account`;
  return {
    repId,
    calendarProvider: "google",
    calendarExternalAccountId: accountId,
    conflictCalendars: [
      {
        provider: "google",
        calendarExternalAccountId: accountId,
        calendarId: "primary",
      },
    ],
  };
}

const schedule: PublicSchedule = {
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
};

const session: RouterLinkSession = {
  organizationSlug: "acme",
  routerSlug: "demo-request",
  sessionToken,
  attendeeName: "Private Visitor",
  attendeeEmail: "private.visitor@example.com",
  lead: {
    email: "private.visitor@example.com",
    internalQualification: "must-not-leak",
  },
  expiresAt: "2026-09-02T16:00:00.000Z",
  matchedRuleName: "Enterprise inbound",
  poolName: "Account executives",
  schedule,
};

function jsonRequest(path: string, body: unknown, headers?: HeadersInit) {
  return new Request(`https://schedule.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function repositoryMocks() {
  const beginRouterLinkBookingAttempt =
    vi.fn<HandoffRepository["beginRouterLinkBookingAttempt"]>();
  beginRouterLinkBookingAttempt.mockResolvedValue({ acquired: true });
  const releaseRouterLinkBookingAttempt =
    vi.fn<HandoffRepository["releaseRouterLinkBookingAttempt"]>();
  releaseRouterLinkBookingAttempt.mockResolvedValue();
  return {
    qualifyRouterLink: vi.fn<HandoffRepository["qualifyRouterLink"]>(),
    routerLinkSession: vi.fn<HandoffRepository["routerLinkSession"]>(),
    routerLinkBookingStatus:
      vi.fn<HandoffRepository["routerLinkBookingStatus"]>(),
    routerLinkBookingRetryContext:
      vi.fn<HandoffRepository["routerLinkBookingRetryContext"]>(),
    abandonRouterLinkBooking:
      vi.fn<HandoffRepository["abandonRouterLinkBooking"]>(),
    retryRouterLinkBooking:
      vi.fn<HandoffRepository["retryRouterLinkBooking"]>(),
    bindLegacyBookingCalendarAccount: vi
      .fn<HandoffRepository["bindLegacyBookingCalendarAccount"]>()
      .mockResolvedValue(true),
    bookRouterLinkSession: vi.fn<HandoffRepository["bookRouterLinkSession"]>(),
    beginRouterLinkBookingAttempt,
    releaseRouterLinkBookingAttempt,
  } satisfies HandoffRepository;
}

function dependencies(
  repository: HandoffRepository,
  overrides: Partial<HandoffDependencies> = {},
): HandoffDependencies {
  return {
    organizationSlug: "acme",
    repository,
    resolveCurrentOwnerEmail: vi.fn().mockResolvedValue(null),
    cachedAvailableSlots: vi.fn().mockResolvedValue([{ startsAt, endsAt }]),
    freshAvailableSlotOptions: vi
      .fn()
      .mockResolvedValue([
        { startsAt, endsAt, candidateQuotes: [candidateQuote()] },
      ]),
    findOwnedCalendarEvent: vi.fn().mockResolvedValue(null),
    createSessionToken: () => sessionToken,
    createBookingAttemptToken: () =>
      "booking-attempt-token-abcdefghijklmnopqrstuvwxyz",
    ...overrides,
  };
}

function matchedQualification(
  overrides: Partial<OperatorQualification> = {},
): OperatorQualification {
  return {
    outcome: "matched",
    sessionToken,
    expiresAt: "2026-09-02T16:00:00.000Z",
    noMatchMessage: "No route matched.",
    matchedRuleName: "Enterprise inbound",
    poolName: "Account executives",
    meetingType: {
      slug: "discovery",
      title: "Discovery call",
      description: "A focused conversation.",
      durationMinutes: 30,
      minimumNoticeMinutes: 60,
      bookingWindowDays: 14,
      conferenceProvider: "google_meet",
      reminderMinutes: 15,
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("operator handoff API", () => {
  it("qualifies through the existing router engine and returns internal route names without echoing lead data", async () => {
    const repository = repositoryMocks();
    repository.qualifyRouterLink.mockResolvedValue(matchedQualification());

    const response = await qualifyHandoffRequest(
      jsonRequest("/api/handoff/qualify", {
        routerSlug: "demo-request",
        attendeeName: "  Taylor Buyer  ",
        attendeeEmail: "TAYLOR@EXAMPLE.COM",
        answers: { company_size: 250 },
      }),
      dependencies(repository),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(repository.qualifyRouterLink).toHaveBeenCalledWith({
      organizationSlug: "acme",
      routerSlug: "demo-request",
      sessionToken,
      attendeeName: "Taylor Buyer",
      attendeeEmail: "taylor@example.com",
      answers: { company_size: 250 },
    });
    expect(body).toMatchObject({
      outcome: "matched",
      sessionToken,
      expiresAt: "2026-09-02T16:00:00.000Z",
      matchedRuleName: "Enterprise inbound",
      poolName: "Account executives",
      noMatchMessage: null,
    });
    expect(body).not.toHaveProperty("attendeeName");
    expect(body).not.toHaveProperty("attendeeEmail");
    expect(body).not.toHaveProperty("answers");
  });

  it("injects only server-resolved HubSpot ownership before qualification", async () => {
    const repository = repositoryMocks();
    repository.qualifyRouterLink.mockResolvedValue(matchedQualification());
    const resolveCurrentOwnerEmail = vi
      .fn<HandoffDependencies["resolveCurrentOwnerEmail"]>()
      .mockResolvedValue("owner@acme.example");

    const response = await qualifyHandoffRequest(
      jsonRequest("/api/handoff/qualify", {
        routerSlug: "demo-request",
        attendeeName: "Taylor Buyer",
        attendeeEmail: "TAYLOR@EXAMPLE.COM",
        answers: { company_size: 250 },
      }),
      dependencies(repository, { resolveCurrentOwnerEmail }),
    );

    expect(response.status).toBe(200);
    expect(resolveCurrentOwnerEmail).toHaveBeenCalledWith(
      "acme",
      "taylor@example.com",
    );
    expect(repository.qualifyRouterLink).toHaveBeenCalledWith(
      expect.objectContaining({
        attendeeEmail: "taylor@example.com",
        currentOwnerEmail: "owner@acme.example",
      }),
    );
  });

  it("fails closed before qualification when connected ownership cannot be verified", async () => {
    const repository = repositoryMocks();
    const resolveCurrentOwnerEmail = vi
      .fn<HandoffDependencies["resolveCurrentOwnerEmail"]>()
      .mockRejectedValue(new Error("access_token=must-not-leak"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const response = await qualifyHandoffRequest(
      jsonRequest("/api/handoff/qualify", {
        routerSlug: "demo-request",
        attendeeName: "Taylor Buyer",
        attendeeEmail: "taylor@example.com",
        answers: {},
      }),
      dependencies(repository, { resolveCurrentOwnerEmail }),
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toMatchObject({ code: "router_unavailable" });
    expect(body).not.toContain("access_token");
    expect(repository.qualifyRouterLink).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "Operator handoff qualify failed:",
      "Error",
    );
  });

  it("returns a usable no-match decision and fails closed when matched metadata is missing", async () => {
    const repository = repositoryMocks();
    repository.qualifyRouterLink
      .mockResolvedValueOnce(
        matchedQualification({
          outcome: "no_match",
          meetingType: null,
          matchedRuleName: null,
          poolName: null,
        }),
      )
      .mockResolvedValueOnce(matchedQualification({ matchedRuleName: null }));
    const requestBody = {
      routerSlug: "demo-request",
      attendeeName: "Taylor Buyer",
      attendeeEmail: "taylor@example.com",
      answers: {},
    };

    const noMatch = await qualifyHandoffRequest(
      jsonRequest("/api/handoff/qualify", requestBody),
      dependencies(repository),
    );
    const noMatchBody = await noMatch.json();
    expect(noMatch.status).toBe(200);
    expect(noMatchBody).toMatchObject({
      outcome: "no_match",
      sessionToken,
      meetingType: null,
      matchedRuleName: null,
      poolName: null,
      noMatchMessage: "No route matched.",
    });

    const incomplete = await qualifyHandoffRequest(
      jsonRequest("/api/handoff/qualify", requestBody),
      dependencies(repository),
    );
    expect(incomplete.status).toBe(503);
    expect(await incomplete.json()).toMatchObject({
      code: "routing_metadata_unavailable",
    });
  });

  it("strictly validates and caps qualification bodies before routing", async () => {
    const repository = repositoryMocks();
    const resolveCurrentOwnerEmail = vi
      .fn<HandoffDependencies["resolveCurrentOwnerEmail"]>()
      .mockResolvedValue(null);
    const unexpectedField = await qualifyHandoffRequest(
      jsonRequest("/api/handoff/qualify", {
        routerSlug: "demo-request",
        attendeeName: "Taylor Buyer",
        attendeeEmail: "taylor@example.com",
        answers: {},
        organizationSlug: "another-tenant",
      }),
      dependencies(repository, { resolveCurrentOwnerEmail }),
    );
    expect(unexpectedField.status).toBe(422);
    expect(repository.qualifyRouterLink).not.toHaveBeenCalled();

    const maliciousOwner = await qualifyHandoffRequest(
      jsonRequest("/api/handoff/qualify", {
        routerSlug: "demo-request",
        attendeeName: "Taylor Buyer",
        attendeeEmail: "taylor@example.com",
        answers: { current_owner_email: "attacker@example.com" },
      }),
      dependencies(repository, { resolveCurrentOwnerEmail }),
    );
    expect(maliciousOwner.status).toBe(422);
    expect(resolveCurrentOwnerEmail).not.toHaveBeenCalled();
    expect(repository.qualifyRouterLink).not.toHaveBeenCalled();

    const oversized = await qualifyHandoffRequest(
      jsonRequest(
        "/api/handoff/qualify",
        {
          routerSlug: "demo-request",
          attendeeName: "Taylor Buyer",
          attendeeEmail: "taylor@example.com",
          answers: {},
        },
        { "content-length": String(16 * 1024 + 1) },
      ),
      dependencies(repository, { resolveCurrentOwnerEmail }),
    );
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({
      code: "payload_too_large",
    });
    expect(oversized.headers.get("cache-control")).toContain("no-store");
  });

  it("returns only shared cached slots and sanitizes calendar provider failures", async () => {
    const repository = repositoryMocks();
    repository.routerLinkSession.mockResolvedValue(session);
    const cachedAvailableSlots = vi
      .fn<HandoffDependencies["cachedAvailableSlots"]>()
      .mockResolvedValue([{ startsAt, endsAt }]);

    const response = await availabilityHandoffRequest(
      jsonRequest("/api/handoff/availability", {
        routerSlug: "demo-request",
        sessionToken,
      }),
      dependencies(repository, { cachedAvailableSlots }),
    );
    const responseText = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(responseText)).toEqual({
      slots: [{ startsAt, endsAt }],
      meetingType: {
        slug: "discovery",
        title: "Discovery call",
        description: "A focused conversation.",
        durationMinutes: 30,
        minimumNoticeMinutes: 60,
        bookingWindowDays: 14,
        conferenceProvider: "google_meet",
        reminderMinutes: 15,
      },
      matchedRuleName: "Enterprise inbound",
      poolName: "Account executives",
    });
    expect(cachedAvailableSlots).toHaveBeenCalledWith(schedule);
    expect(responseText).not.toContain("private.visitor@example.com");
    expect(responseText).not.toContain("must-not-leak");

    const providerError = new Error(
      "access_token=secret and rep@example.com failed",
    );
    cachedAvailableSlots.mockRejectedValue(providerError);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const unavailable = await availabilityHandoffRequest(
      jsonRequest("/api/handoff/availability", {
        routerSlug: "demo-request",
        sessionToken,
      }),
      dependencies(repository, { cachedAvailableSlots }),
    );
    const unavailableText = await unavailable.text();
    expect(unavailable.status).toBe(503);
    expect(JSON.parse(unavailableText)).toMatchObject({
      code: "calendar_unavailable",
    });
    expect(unavailableText).not.toContain("access_token");
    expect(unavailableText).not.toContain("rep@example.com");
    expect(consoleError).toHaveBeenCalledWith(
      "Operator handoff availability failed:",
      "Error",
    );
  });

  it("rechecks fresh offered slots, books only internal candidates, and returns a safe status", async () => {
    const repository = repositoryMocks();
    repository.routerLinkBookingStatus.mockResolvedValue(null);
    repository.routerLinkSession.mockResolvedValue(session);
    const bookingWithPrivateField = {
      status: "confirmed",
      error: null,
      managePath: "/schedule/manage/public-token",
      conferenceUrl: "https://meet.example/join",
      repName: "Morgan Rep",
      startsAt,
      endsAt,
      repEmail: "morgan.rep@example.com",
    } as PublicBookingStatus & { repEmail: string };
    repository.bookRouterLinkSession.mockResolvedValue(bookingWithPrivateField);
    const freshAvailableSlotOptions = vi
      .fn<HandoffDependencies["freshAvailableSlotOptions"]>()
      .mockResolvedValue([
        {
          startsAt,
          endsAt,
          candidateQuotes: [
            candidateQuote("8a90b1e8-f323-4f24-a19c-41b4a7766545"),
          ],
        },
      ]);

    const response = await bookingHandoffRequest(
      jsonRequest("/api/handoff/bookings", {
        routerSlug: "demo-request",
        sessionToken,
        startsAt,
        additionalAttendeeEmails: ["Guest@Example.com", "guest@example.com"],
      }),
      dependencies(repository, { freshAvailableSlotOptions }),
    );
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(freshAvailableSlotOptions).toHaveBeenCalledWith(schedule);
    expect(repository.beginRouterLinkBookingAttempt).toHaveBeenCalledWith({
      organizationSlug: "acme",
      routerSlug: "demo-request",
      sessionToken,
      attemptToken: "booking-attempt-token-abcdefghijklmnopqrstuvwxyz",
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
    });
    expect(repository.bookRouterLinkSession).toHaveBeenCalledWith({
      organizationSlug: "acme",
      routerSlug: "demo-request",
      sessionToken,
      attemptToken: "booking-attempt-token-abcdefghijklmnopqrstuvwxyz",
      candidateQuotes: [candidateQuote("8a90b1e8-f323-4f24-a19c-41b4a7766545")],
      startsAt: new Date(startsAt),
      endsAt: new Date(endsAt),
      additionalAttendeeEmails: ["guest@example.com"],
    });
    expect(JSON.parse(responseText)).toEqual({
      status: "confirmed",
      error: null,
      managePath: "/schedule/manage/public-token",
      conferenceUrl: "https://meet.example/join",
      repName: "Morgan Rep",
      startsAt,
      endsAt,
    });
    expect(responseText).not.toContain("morgan.rep@example.com");
  });

  it("rejects a stale offered slot before creating a booking", async () => {
    const repository = repositoryMocks();
    repository.routerLinkBookingStatus.mockResolvedValue(null);
    repository.routerLinkSession.mockResolvedValue(session);

    const response = await bookingHandoffRequest(
      jsonRequest("/api/handoff/bookings", {
        routerSlug: "demo-request",
        sessionToken,
        startsAt,
      }),
      dependencies(repository, {
        freshAvailableSlotOptions: vi.fn().mockResolvedValue([]),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "slot_unavailable" });
    expect(repository.bookRouterLinkSession).not.toHaveBeenCalled();
    expect(repository.releaseRouterLinkBookingAttempt).toHaveBeenCalledWith(
      "acme",
      "demo-request",
      sessionToken,
      "booking-attempt-token-abcdefghijklmnopqrstuvwxyz",
    );
  });

  it("returns a concurrent attempt's authoritative range without another calendar check", async () => {
    const repository = repositoryMocks();
    repository.routerLinkBookingStatus.mockResolvedValue(null);
    repository.routerLinkSession.mockResolvedValue(session);
    repository.beginRouterLinkBookingAttempt.mockResolvedValue({
      acquired: false,
      booking: {
        status: "attempting",
        error: null,
        managePath: null,
        conferenceUrl: null,
        repName: null,
        startsAt,
        endsAt,
      },
    });
    const freshAvailableSlotOptions = vi.fn();

    const response = await bookingHandoffRequest(
      jsonRequest("/api/handoff/bookings", {
        routerSlug: "demo-request",
        sessionToken,
        startsAt: "2026-09-02T18:00:00.000Z",
      }),
      dependencies(repository, { freshAvailableSlotOptions }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: "attempting",
      startsAt,
      endsAt,
    });
    expect(freshAvailableSlotOptions).not.toHaveBeenCalled();
    expect(repository.bookRouterLinkSession).not.toHaveBeenCalled();
  });

  it("returns idempotent booking status with pending semantics", async () => {
    const repository = repositoryMocks();
    repository.routerLinkBookingStatus.mockResolvedValue({
      status: "pending",
      error: null,
      managePath: null,
      conferenceUrl: null,
      repName: "Morgan Rep",
      startsAt,
      endsAt,
    });

    const response = await bookingStatusHandoffRequest(
      jsonRequest("/api/handoff/bookings/status", {
        routerSlug: "demo-request",
        sessionToken,
      }),
      dependencies(repository),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "pending",
      error: null,
      managePath: null,
      conferenceUrl: null,
      repName: "Morgan Rep",
      startsAt,
      endsAt,
    });
  });

  it("does not expose provider failures through booking status", async () => {
    const repository = repositoryMocks();
    repository.routerLinkBookingStatus.mockResolvedValue({
      status: "failed",
      error: "Graph token for private.rep@example.com was rejected",
      managePath: null,
      conferenceUrl: null,
      repName: "Morgan Rep",
      startsAt,
      endsAt,
    });

    const response = await bookingStatusHandoffRequest(
      jsonRequest("/api/handoff/bookings/status", {
        routerSlug: "demo-request",
        sessionToken,
      }),
      dependencies(repository),
    );
    const responseText = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(responseText)).toMatchObject({
      status: "failed",
      error:
        "The calendar provider did not return a complete result. Retry or close this same booking safely.",
    });
    expect(responseText).not.toContain("Graph token");
    expect(responseText).not.toContain("private.rep@example.com");
  });

  it("retries the same booking idempotently and reports an occupied original time", async () => {
    const repository = repositoryMocks();
    repository.routerLinkBookingRetryContext.mockResolvedValue({
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
    repository.retryRouterLinkBooking.mockResolvedValue({
      status: "pending",
      error: null,
      managePath: "/schedule/manage/public-token",
      conferenceUrl: null,
      repName: "Morgan Rep",
      startsAt,
      endsAt,
    });
    const requestBody = { routerSlug: "demo-request", sessionToken };

    const first = await retryBookingHandoffRequest(
      jsonRequest("/api/handoff/bookings/retry", requestBody),
      dependencies(repository),
    );
    const second = await retryBookingHandoffRequest(
      jsonRequest("/api/handoff/bookings/retry", requestBody),
      dependencies(repository),
    );

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(await first.json()).toEqual({
      status: "pending",
      error: null,
      managePath: "/schedule/manage/public-token",
      conferenceUrl: null,
      repName: "Morgan Rep",
      startsAt,
      endsAt,
    });
    expect(repository.retryRouterLinkBooking).toHaveBeenNthCalledWith(
      1,
      "acme",
      "demo-request",
      sessionToken,
      candidateQuote(),
    );

    repository.retryRouterLinkBooking.mockClear();
    const unavailableRetrySlotOptions = vi.fn().mockResolvedValue([]);
    const calendarOccupied = await retryBookingHandoffRequest(
      jsonRequest("/api/handoff/bookings/retry", requestBody),
      dependencies(repository, {
        freshAvailableSlotOptions: unavailableRetrySlotOptions,
      }),
    );
    expect(calendarOccupied.status).toBe(409);
    expect(await calendarOccupied.json()).toMatchObject({
      code: "slot_unavailable",
    });
    expect(unavailableRetrySlotOptions).toHaveBeenCalledWith(
      schedule,
      "rep-1",
      "public-token",
    );
    expect(repository.retryRouterLinkBooking).not.toHaveBeenCalled();

    repository.retryRouterLinkBooking.mockRejectedValue(
      new CalendarSlotUnavailableError(),
    );
    const occupied = await retryBookingHandoffRequest(
      jsonRequest("/api/handoff/bookings/retry", requestBody),
      dependencies(repository),
    );
    expect(occupied.status).toBe(409);
    expect(await occupied.json()).toMatchObject({ code: "slot_unavailable" });

    vi.spyOn(console, "error").mockImplementation(() => {});
    repository.retryRouterLinkBooking.mockRejectedValue(
      new Error("private provider token was rejected"),
    );
    const unavailable = await retryBookingHandoffRequest(
      jsonRequest("/api/handoff/bookings/retry", requestBody),
      dependencies(repository),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error:
        "The same booking could not be requeued. Its original representative assignment is unchanged; try again.",
      code: "retry_unavailable",
    });
  });

  it("returns an already requeued booking without another provider check", async () => {
    const repository = repositoryMocks();
    repository.routerLinkBookingRetryContext.mockResolvedValue({
      status: "pending",
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
    repository.retryRouterLinkBooking.mockResolvedValue({
      status: "pending",
      error: null,
      managePath: "/schedule/manage/public-token",
      conferenceUrl: null,
      repName: "Morgan Rep",
      startsAt,
      endsAt,
    });
    const freshAvailableSlotOptions = vi
      .fn<HandoffDependencies["freshAvailableSlotOptions"]>()
      .mockRejectedValue(new Error("provider should not be called"));

    const response = await retryBookingHandoffRequest(
      jsonRequest("/api/handoff/bookings/retry", {
        routerSlug: "demo-request",
        sessionToken,
      }),
      dependencies(repository, { freshAvailableSlotOptions }),
    );

    expect(response.status).toBe(202);
    expect(freshAvailableSlotOptions).not.toHaveBeenCalled();
    expect(repository.retryRouterLinkBooking).toHaveBeenCalledWith(
      "acme",
      "demo-request",
      sessionToken,
      undefined,
    );
  });

  it("binds and retries a migrated owned provider event without rejecting its own busy slot", async () => {
    const repository = repositoryMocks();
    const context = {
      status: "failed" as const,
      organizationSlug: "acme",
      schedule,
      repId: "rep-1",
      startsAt,
      endsAt,
      transactionId: "public-token",
      externalEventId: null,
      calendarProvider: "google" as const,
      calendarExternalAccountId: null,
      currentCalendarExternalAccountId: "google-account-1",
    };
    repository.routerLinkBookingRetryContext.mockResolvedValue(context);
    repository.retryRouterLinkBooking.mockResolvedValue({
      status: "pending",
      error: null,
      managePath: "/schedule/manage/public-token",
      conferenceUrl: null,
      repName: "Morgan Rep",
      startsAt,
      endsAt,
    });
    const findOwnedCalendarEvent = vi.fn().mockResolvedValue({
      externalEventId: "owned-google-event",
      webLink: null,
      conferenceUrl: null,
    });
    const freshAvailableSlotOptions = vi
      .fn<HandoffDependencies["freshAvailableSlotOptions"]>()
      .mockResolvedValue([]);

    const response = await retryBookingHandoffRequest(
      jsonRequest("/api/handoff/bookings/retry", {
        routerSlug: "demo-request",
        sessionToken,
      }),
      dependencies(repository, {
        findOwnedCalendarEvent,
        freshAvailableSlotOptions,
      }),
    );

    expect(response.status).toBe(202);
    expect(findOwnedCalendarEvent).toHaveBeenCalledWith({
      ...context,
      calendarExternalAccountId: "google-account-1",
    });
    expect(repository.bindLegacyBookingCalendarAccount).toHaveBeenCalledWith(
      "public-token",
      {
        calendarExternalAccountId: "google-account-1",
        externalEventId: "owned-google-event",
        startsAt: new Date(startsAt),
        endsAt: new Date(endsAt),
      },
    );
    expect(freshAvailableSlotOptions).not.toHaveBeenCalled();
    expect(repository.retryRouterLinkBooking).toHaveBeenCalledWith(
      "acme",
      "demo-request",
      sessionToken,
      undefined,
    );
  });

  it("fails retry closed when provider ownership cannot be determined", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const repository = repositoryMocks();
    repository.routerLinkBookingRetryContext.mockResolvedValue({
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
    const response = await retryBookingHandoffRequest(
      jsonRequest("/api/handoff/bookings/retry", {
        routerSlug: "demo-request",
        sessionToken,
      }),
      dependencies(repository, {
        findOwnedCalendarEvent: vi
          .fn()
          .mockRejectedValue(new Error("provider timeout")),
      }),
    );
    expect(response.status).toBe(503);
    expect(repository.retryRouterLinkBooking).not.toHaveBeenCalled();
  });

  it("keeps only the same failed booking reserved while durable close attestation begins", async () => {
    const repository = repositoryMocks();
    repository.routerLinkBookingRetryContext.mockResolvedValue({
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
    repository.abandonRouterLinkBooking.mockResolvedValue({
      status: "cancel_pending",
      error: "provider evidence remains private",
      managePath: "/schedule/manage/public-token",
      conferenceUrl: null,
      repName: "Morgan Rep",
      startsAt,
      endsAt,
    });

    const response = await abandonBookingHandoffRequest(
      jsonRequest("/api/handoff/bookings/abandon", {
        routerSlug: "demo-request",
        sessionToken,
      }),
      dependencies(repository),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "cancel_pending",
      error: null,
      managePath: "/schedule/manage/public-token",
      conferenceUrl: null,
      repName: "Morgan Rep",
      startsAt,
      endsAt,
    });
    expect(repository.abandonRouterLinkBooking).toHaveBeenCalledWith(
      "acme",
      "demo-request",
      sessionToken,
      null,
    );
  });

  it("queues provider cancellation and returns 202 when abandon finds an owned event", async () => {
    const repository = repositoryMocks();
    repository.routerLinkBookingRetryContext.mockResolvedValue({
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
    repository.abandonRouterLinkBooking.mockResolvedValue({
      status: "cancel_pending",
      error: "provider evidence remains private",
      managePath: "/schedule/manage/public-token",
      conferenceUrl: null,
      repName: "Morgan Rep",
      startsAt,
      endsAt,
    });

    const response = await abandonBookingHandoffRequest(
      jsonRequest("/api/handoff/bookings/abandon", {
        routerSlug: "demo-request",
        sessionToken,
      }),
      dependencies(repository, {
        findOwnedCalendarEvent: vi.fn().mockResolvedValue(providerEvent),
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "cancel_pending" });
    expect(repository.abandonRouterLinkBooking).toHaveBeenCalledWith(
      "acme",
      "demo-request",
      sessionToken,
      providerEvent,
    );
  });
});
