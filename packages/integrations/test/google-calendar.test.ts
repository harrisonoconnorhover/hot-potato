import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_PRIMARY_CALENDAR_ID,
  GoogleCalendarAdapter,
  GoogleOAuthClient,
  GoogleRepCalendarAdapter,
} from "../src/index.js";

function googleBookingEvent(
  transactionId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `hp${createHash("sha256").update(transactionId).digest("hex")}`,
    status: "confirmed",
    extendedProperties: {
      private: { hotPotatoExternalId: transactionId },
    },
    start: { dateTime: "2026-08-24T16:00:00Z" },
    end: { dateTime: "2026-08-24T16:30:00Z" },
    ...overrides,
  };
}

describe("Google representative OAuth", () => {
  it("requests PKCE plus free/busy and event write scopes", () => {
    const client = new GoogleOAuthClient({
      clientId: "client",
      clientSecret: "secret",
      calendarAccess: "readwrite",
    });
    const authorization = new URL(
      client.authorizationUrl({
        state: "state-value",
        redirectUri: "http://localhost:3000/rep-callback",
        codeChallenge: "pkce-challenge",
      }),
    );
    expect(authorization.searchParams.get("code_challenge")).toBe(
      "pkce-challenge",
    );
    expect(authorization.searchParams.get("scope")).toContain(
      "calendar.freebusy",
    );
    expect(authorization.searchParams.get("scope")).toContain(
      "calendar.events",
    );
    expect(authorization.searchParams.get("scope")).toContain(
      "calendar.calendarlist.readonly",
    );
  });

  it("does not request calendar-list or event access for shared free/busy", () => {
    const authorization = new URL(
      new GoogleOAuthClient({
        clientId: "client",
        clientSecret: "secret",
      }).authorizationUrl({
        state: "state-value",
        redirectUri: "http://localhost:3000/callback",
      }),
    );
    const scope = authorization.searchParams.get("scope") ?? "";
    expect(scope).toContain("calendar.freebusy");
    expect(scope).not.toContain("calendar.events");
    expect(scope).not.toContain("calendar.calendarlist.readonly");
  });
});

describe("representative-owned Google calendars", () => {
  it("discovers calendars, maps the provider primary, and forwards abort", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/calendar/v3/users/me/calendarList");
      expect(url.searchParams.get("maxResults")).toBe("250");
      expect(url.searchParams.get("minAccessRole")).toBe("freeBusyReader");
      expect(url.searchParams.has("pageToken")).toBe(false);
      expect(init?.signal).toBe(controller.signal);
      return Response.json({
        items: [
          {
            id: "rep@example.com",
            summary: "Rep calendar",
            summaryOverride: "My calendar",
            primary: true,
          },
          { id: "team@example.com", summary: "Team calendar" },
          { id: "team@example.com", summary: "Team calendar" },
        ],
      });
    });
    const adapter = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      request,
    );

    await expect(
      adapter.listCalendars({ signal: controller.signal }),
    ).resolves.toEqual([
      {
        id: GOOGLE_PRIMARY_CALENDAR_ID,
        name: "My calendar",
        isDefault: true,
      },
      {
        id: "team@example.com",
        name: "Team calendar",
        isDefault: false,
      },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("fully paginates calendar discovery and deduplicates across pages", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        Response.json({
          items: [
            {
              id: "rep@example.com",
              summary: "Primary",
              primary: true,
            },
            { id: "team@example.com", summary: "Team" },
          ],
          nextPageToken: "page-two",
        }),
      )
      .mockImplementationOnce(async (input) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("pageToken")).toBe("page-two");
        return Response.json({
          items: [
            { id: "team@example.com", summary: "Team" },
            { id: "focus@example.com", summary: "Focus" },
          ],
        });
      });
    const adapter = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      request,
    );

    await expect(adapter.listCalendars()).resolves.toEqual([
      { id: GOOGLE_PRIMARY_CALENDAR_ID, name: "Primary", isDefault: true },
      { id: "team@example.com", name: "Team", isDefault: false },
      { id: "focus@example.com", name: "Focus", isDefault: false },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects repeated and excessive calendar-list pagination", async () => {
    const repeated = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      vi.fn<typeof fetch>(async () =>
        Response.json({
          items: [
            {
              id: "rep@example.com",
              summary: "Primary",
              primary: true,
            },
          ],
          nextPageToken: "same-page",
        }),
      ),
    );
    await expect(repeated.listCalendars()).rejects.toThrow(
      "repeated a calendar-list page token",
    );

    let page = 0;
    const excessiveRequest = vi.fn<typeof fetch>(async () => {
      page += 1;
      return Response.json({
        items:
          page === 1
            ? [
                {
                  id: "rep@example.com",
                  summary: "Primary",
                  primary: true,
                },
              ]
            : [],
        nextPageToken: `page-${page}`,
      });
    });
    const excessive = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      excessiveRequest,
    );
    await expect(excessive.listCalendars()).rejects.toThrow(
      "too many calendar-list pages",
    );
    expect(excessiveRequest).toHaveBeenCalledTimes(20);
  });

  it.each([
    {
      name: "a malformed response",
      body: { items: "not-an-array" },
      error: "invalid calendar list",
    },
    {
      name: "an entry without an identifier",
      body: { items: [{ summary: "Missing id", primary: true }] },
      error: "invalid calendar identifier",
    },
    {
      name: "an entry without a name",
      body: { items: [{ id: "rep@example.com", primary: true }] },
      error: "invalid calendar name",
    },
    {
      name: "no primary calendar",
      body: { items: [{ id: "team@example.com", summary: "Team" }] },
      error: "exactly one primary calendar",
    },
    {
      name: "multiple primary calendars",
      body: {
        items: [
          { id: "one@example.com", summary: "One", primary: true },
          { id: "two@example.com", summary: "Two", primary: true },
        ],
      },
      error: "exactly one primary calendar",
    },
  ])("fails closed on $name", async ({ body, error }) => {
    const adapter = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      async () => Response.json(body),
    );
    await expect(adapter.listCalendars()).rejects.toThrow(error);
  });

  it("returns the signed-in representative's busy intervals", async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        items: Array<{ id: string }>;
      };
      expect(body.items).toEqual([{ id: "primary" }]);
      return Response.json({
        calendars: {
          primary: {
            busy: [
              {
                start: "2026-08-24T16:00:00Z",
                end: "2026-08-24T16:30:00Z",
              },
            ],
          },
        },
      });
    });
    const adapter = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      request,
    );
    await expect(
      adapter.busyIntervals({
        startsAt: new Date("2026-08-24T15:00:00Z"),
        endsAt: new Date("2026-08-24T17:00:00Z"),
      }),
    ).resolves.toEqual([
      {
        startsAt: new Date("2026-08-24T16:00:00Z"),
        endsAt: new Date("2026-08-24T16:30:00Z"),
      },
    ]);
  });

  it("checks every selected calendar once and forwards the abort signal", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        calendarExpansionMax: number;
        items: Array<{ id: string }>;
      };
      expect(body.calendarExpansionMax).toBe(50);
      expect(body.items).toEqual([
        { id: GOOGLE_PRIMARY_CALENDAR_ID },
        { id: "team@example.com" },
      ]);
      expect(init?.signal).toBe(controller.signal);
      return Response.json({
        calendars: {
          [GOOGLE_PRIMARY_CALENDAR_ID]: {
            busy: [
              {
                start: "2026-08-24T16:00:00Z",
                end: "2026-08-24T16:30:00Z",
              },
            ],
          },
          "team@example.com": {
            busy: [
              {
                start: "2026-08-24T15:30:00Z",
                end: "2026-08-24T16:00:00Z",
              },
              {
                start: "2026-08-24T16:00:00Z",
                end: "2026-08-24T16:30:00Z",
              },
            ],
          },
        },
      });
    });
    const adapter = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      request,
    );

    await expect(
      adapter.busyIntervals({
        startsAt: new Date("2026-08-24T15:00:00Z"),
        endsAt: new Date("2026-08-24T17:00:00Z"),
        calendarIds: [
          GOOGLE_PRIMARY_CALENDAR_ID,
          "team@example.com",
          "team@example.com",
        ],
        signal: controller.signal,
      }),
    ).resolves.toEqual([
      {
        startsAt: new Date("2026-08-24T15:30:00Z"),
        endsAt: new Date("2026-08-24T16:00:00Z"),
      },
      {
        startsAt: new Date("2026-08-24T16:00:00Z"),
        endsAt: new Date("2026-08-24T16:30:00Z"),
      },
    ]);
  });

  it.each([
    {
      name: "a selected calendar is missing",
      calendars: { [GOOGLE_PRIMARY_CALENDAR_ID]: { busy: [] } },
    },
    {
      name: "a selected calendar reports an error",
      calendars: {
        [GOOGLE_PRIMARY_CALENDAR_ID]: { busy: [] },
        "team@example.com": { errors: [{ reason: "notFound" }] },
      },
    },
    {
      name: "a selected calendar returns a malformed interval",
      calendars: {
        [GOOGLE_PRIMARY_CALENDAR_ID]: { busy: [] },
        "team@example.com": {
          busy: [{ start: "not-a-date", end: "2026-08-24T16:30:00Z" }],
        },
      },
    },
  ])("fails closed when $name", async ({ calendars }) => {
    const adapter = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      async () => Response.json({ calendars }),
    );
    await expect(
      adapter.busyIntervals({
        startsAt: new Date("2026-08-24T15:00:00Z"),
        endsAt: new Date("2026-08-24T17:00:00Z"),
        calendarIds: [GOOGLE_PRIMARY_CALENDAR_ID, "team@example.com"],
      }),
    ).rejects.toThrow("could not verify availability");
  });

  it("rejects empty, invalid, and oversized calendar selections", async () => {
    const adapter = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      vi.fn<typeof fetch>(),
    );
    const input = {
      startsAt: new Date("2026-08-24T15:00:00Z"),
      endsAt: new Date("2026-08-24T17:00:00Z"),
    };
    await expect(
      adapter.busyIntervals({ ...input, calendarIds: [] }),
    ).rejects.toThrow("at least one Google calendar");
    await expect(
      adapter.busyIntervals({ ...input, calendarIds: [" invalid "] }),
    ).rejects.toThrow("invalid calendar identifier");
    await expect(
      adapter.busyIntervals({
        ...input,
        calendarIds: Array.from({ length: 51 }, (_, index) => `cal-${index}`),
      }),
    ).rejects.toThrow("no more than 50 Google calendars");
  });

  it("reconciles only the deterministic owned event at the reserved time", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toMatch(
        /\/calendar\/v3\/calendars\/primary\/events\/hp[0-9a-f]{64}$/,
      );
      expect(url.searchParams.get("fields")).toContain("extendedProperties");
      expect(init?.method).toBeUndefined();
      expect(init?.signal).toBe(controller.signal);
      const id = url.pathname.split("/").at(-1)!;
      return Response.json({
        id,
        status: "confirmed",
        htmlLink: "https://calendar.google.com/owned",
        hangoutLink: "https://meet.google.com/owned-room",
        extendedProperties: {
          private: { hotPotatoExternalId: "booking-owned" },
        },
        start: { dateTime: "2026-08-24T16:00:00Z" },
        end: { dateTime: "2026-08-24T16:30:00Z" },
      });
    });
    const adapter = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      request,
    );

    await expect(
      adapter.findEventByTransactionId({
        transactionId: "booking-owned",
        startsAt: new Date("2026-08-24T16:00:00Z"),
        endsAt: new Date("2026-08-24T16:30:00Z"),
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      webLink: "https://calendar.google.com/owned",
      conferenceUrl: "https://meet.google.com/owned-room",
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("preserves an exact whitespace-bearing legacy transaction identity", async () => {
    const transactionId = " legacy-booking-id ";
    const expectedEventId = `hp${createHash("sha256").update(transactionId).digest("hex")}`;
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname.split("/").at(-1)).toBe(expectedEventId);
      return Response.json({
        id: expectedEventId,
        status: "confirmed",
        extendedProperties: {
          private: { hotPotatoExternalId: transactionId },
        },
        start: { dateTime: "2026-08-24T16:00:00Z" },
        end: { dateTime: "2026-08-24T16:30:00Z" },
      });
    });
    const adapter = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      request,
    );

    await expect(
      adapter.findEventByTransactionId({
        transactionId,
        startsAt: new Date("2026-08-24T16:00:00Z"),
        endsAt: new Date("2026-08-24T16:30:00Z"),
      }),
    ).resolves.toMatchObject({ externalEventId: expectedEventId });
    expect(request).toHaveBeenCalledOnce();
  });

  it("distinguishes a missing owned event from provider uncertainty", async () => {
    const input = {
      transactionId: "booking-missing",
      startsAt: new Date("2026-08-24T16:00:00Z"),
      endsAt: new Date("2026-08-24T16:30:00Z"),
    };
    const missing = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      async () => new Response("missing", { status: 404 }),
    );
    await expect(missing.findEventByTransactionId(input)).resolves.toBeNull();

    const uncertain = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      async () => new Response("upstream timeout", { status: 503 }),
    );
    await expect(uncertain.findEventByTransactionId(input)).rejects.toThrow(
      "booking event reconciliation failed with HTTP 503",
    );
  });

  it("fails closed when deterministic ownership or the reserved time conflicts", async () => {
    const input = {
      transactionId: "booking-conflict",
      startsAt: new Date("2026-08-24T16:00:00Z"),
      endsAt: new Date("2026-08-24T16:30:00Z"),
    };
    const conflicting = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      async (request) => {
        const id = new URL(String(request)).pathname.split("/").at(-1)!;
        return Response.json({
          id,
          extendedProperties: {
            private: { hotPotatoExternalId: "different-booking" },
          },
          start: { dateTime: "2026-08-24T16:00:00Z" },
          end: { dateTime: "2026-08-24T16:30:00Z" },
        });
      },
    );
    await expect(conflicting.findEventByTransactionId(input)).rejects.toThrow(
      "conflicting booking ownership evidence",
    );

    const moved = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      async (request) => {
        const id = new URL(String(request)).pathname.split("/").at(-1)!;
        return Response.json({
          id,
          start: { dateTime: "2026-08-24T17:00:00Z" },
          end: { dateTime: "2026-08-24T17:30:00Z" },
        });
      },
    );
    await expect(moved.findEventByTransactionId(input)).rejects.toThrow(
      "outside the reserved time",
    );
  });

  it("creates an idempotent event and emails the attendee", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
      expect(url.searchParams.get("sendUpdates")).toBe("all");
      const body = JSON.parse(String(init?.body)) as {
        id: string;
        summary: string;
        description: string;
        attendees: Array<{ email: string; displayName?: string }>;
        extendedProperties: { private: { hotPotatoExternalId: string } };
      };
      expect(body.id).toMatch(/^hp[0-9a-f]{64}$/);
      expect(body).toMatchObject({
        summary: "Intro meeting",
        description: "Scheduled through Hot Potato",
        attendees: [
          { email: "lead@example.com", displayName: "Maya Buyer" },
          { email: "colleague@example.com" },
          { email: "observer@example.com" },
        ],
        extendedProperties: {
          private: { hotPotatoExternalId: "booking-123" },
        },
      });
      return Response.json(
        googleBookingEvent(
          body.extendedProperties.private.hotPotatoExternalId,
          {
            id: body.id,
            htmlLink: "https://calendar.google.com/event-1",
            attendees: body.attendees,
          },
        ),
        { status: 201 },
      );
    });
    const adapter = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      request,
    );
    const result = await adapter.createEvent({
      subject: "Intro meeting",
      startsAt: new Date("2026-08-24T16:00:00Z"),
      endsAt: new Date("2026-08-24T16:30:00Z"),
      attendeeEmail: "lead@example.com",
      attendeeName: "Maya Buyer",
      additionalAttendeeEmails: [
        "colleague@example.com",
        "LEAD@example.com",
        "observer@example.com",
      ],
      description: "Scheduled through Hot Potato",
      transactionId: "booking-123",
    });
    expect(result.externalEventId).toMatch(/^hp[0-9a-f]{64}$/);
    expect(result.webLink).toBe("https://calendar.google.com/event-1");
  });

  it("returns the existing deterministic event after an insert retry", async () => {
    const expectedEventId = `hp${createHash("sha256").update("booking-123").digest("hex")}`;
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("already exists", { status: 409 }))
      .mockResolvedValueOnce(
        Response.json(
          googleBookingEvent("booking-123", {
            htmlLink: "https://calendar.google.com/existing",
            hangoutLink: "https://meet.google.com/existing-room",
            attendees: [{ email: "lead@example.com" }],
          }),
        ),
      )
      .mockImplementationOnce(async (_input, init) => {
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          attendees: [
            { email: "lead@example.com" },
            { email: "guest@example.com" },
          ],
        });
        return Response.json({
          attendees: [
            { email: "lead@example.com" },
            { email: "guest@example.com" },
          ],
        });
      });
    const adapter = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      request,
    );
    await expect(
      adapter.createEvent({
        subject: "Intro meeting",
        startsAt: new Date("2026-08-24T16:00:00Z"),
        endsAt: new Date("2026-08-24T16:30:00Z"),
        attendeeEmail: "lead@example.com",
        additionalAttendeeEmails: ["guest@example.com"],
        transactionId: "booking-123",
        conferenceProvider: "google_meet",
      }),
    ).resolves.toEqual({
      externalEventId: expectedEventId,
      webLink: "https://calendar.google.com/existing",
      conferenceUrl: "https://meet.google.com/existing-room",
    });
    expect(new URL(String(request.mock.calls[1]?.[0])).pathname).toMatch(
      /\/calendars\/primary\/events\/hp[0-9a-f]{64}$/,
    );
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("rejects moved, cancelled, or malformed create results", async () => {
    const input = {
      subject: "Intro meeting",
      startsAt: new Date("2026-08-24T16:00:00Z"),
      endsAt: new Date("2026-08-24T16:30:00Z"),
      transactionId: "booking-create-proof",
    };
    const moved = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      async () =>
        Response.json(
          googleBookingEvent(input.transactionId, {
            start: { dateTime: "2026-08-24T17:00:00Z" },
            end: { dateTime: "2026-08-24T17:30:00Z" },
          }),
        ),
    );
    await expect(moved.createEvent(input)).rejects.toThrow(
      "outside the reserved time",
    );

    const cancelled = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      async () =>
        Response.json(
          googleBookingEvent(input.transactionId, { status: "cancelled" }),
        ),
    );
    await expect(cancelled.createEvent(input)).rejects.toThrow(
      "cancelled booking event",
    );

    const malformed = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      async () =>
        Response.json(
          googleBookingEvent(input.transactionId, { htmlLink: " " }),
        ),
    );
    await expect(malformed.createEvent(input)).rejects.toThrow(
      "invalid booking event link",
    );
  });

  it("waits for asynchronous Google Meet creation to return a join URL", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          googleBookingEvent("booking-pending", {
            conferenceData: {
              createRequest: { status: { statusCode: "pending" } },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          googleBookingEvent("booking-pending", {
            conferenceData: {
              createRequest: { status: { statusCode: "pending" } },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          googleBookingEvent("booking-pending", {
            conferenceData: {
              createRequest: { status: { statusCode: "success" } },
              entryPoints: [
                {
                  entryPointType: "video",
                  uri: "https://meet.google.com/pending-room",
                },
              ],
            },
          }),
        ),
      );
    const wait = vi.fn(async () => undefined);
    const adapter = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      request,
      wait,
    );

    await expect(
      adapter.createEvent({
        subject: "Product tour",
        startsAt: new Date("2026-08-24T16:00:00Z"),
        endsAt: new Date("2026-08-24T16:30:00Z"),
        transactionId: "booking-pending",
        conferenceProvider: "google_meet",
      }),
    ).resolves.toMatchObject({
      conferenceUrl: "https://meet.google.com/pending-room",
    });
    expect(wait.mock.calls).toEqual([[200], [400]]);
    expect(String(request.mock.calls[1]?.[0])).toMatch(
      /\/calendars\/primary\/events\/hp[0-9a-f]{64}$/,
    );
  });

  it("fails immediately when Google reports Meet creation failure", async () => {
    const wait = vi.fn(async () => undefined);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          googleBookingEvent("booking-failed", {
            conferenceData: {
              createRequest: { status: { statusCode: "failure" } },
            },
          }),
        ),
      )
      .mockImplementationOnce(async (_input, init) => {
        expect(init?.method).toBe("DELETE");
        return new Response(null, { status: 204 });
      });
    const adapter = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      request,
      wait,
    );

    await expect(
      adapter.createEvent({
        subject: "Product tour",
        startsAt: new Date("2026-08-24T16:00:00Z"),
        endsAt: new Date("2026-08-24T16:30:00Z"),
        transactionId: "booking-failed",
        conferenceProvider: "google_meet",
      }),
    ).rejects.toThrow("could not create the Google Meet room");
    expect(wait).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails closed when Google Meet creation remains pending", async () => {
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(
        googleBookingEvent("booking-still-pending", {
          conferenceData: {
            createRequest: { status: { statusCode: "pending" } },
          },
        }),
      ),
    );
    const wait = vi.fn(async () => undefined);
    const adapter = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      request,
      wait,
    );

    await expect(
      adapter.createEvent({
        subject: "Product tour",
        startsAt: new Date("2026-08-24T16:00:00Z"),
        endsAt: new Date("2026-08-24T16:30:00Z"),
        transactionId: "booking-still-pending",
        conferenceProvider: "google_meet",
      }),
    ).rejects.toThrow("did not finish creating the Google Meet room");
    expect(request).toHaveBeenCalledTimes(6);
    expect(wait).toHaveBeenCalledTimes(5);
  });

  it("creates, time-only reschedules, and cancels a Google Meet event", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (input, init) => {
        expect(String(input)).toContain(
          `/calendars/${GOOGLE_PRIMARY_CALENDAR_ID}/events`,
        );
        const body = JSON.parse(String(init?.body)) as {
          attendees: unknown[];
          conferenceData: {
            createRequest: { conferenceSolutionKey: { type: string } };
          };
        };
        expect(body.attendees).toEqual([]);
        expect(
          body.conferenceData.createRequest.conferenceSolutionKey.type,
        ).toBe("hangoutsMeet");
        return Response.json(
          googleBookingEvent("booking-456", {
            htmlLink: "https://calendar.google.com/event-1",
            hangoutLink: "https://meet.google.com/abc-defg-hij",
          }),
        );
      })
      .mockImplementationOnce(async (input, init) => {
        expect(String(input)).toMatch(
          /\/events\/hp[0-9a-f]{64}\?sendUpdates=all/,
        );
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          attendees: [
            { email: "lead@example.com", displayName: "Maya Buyer" },
            { email: "colleague@example.com" },
          ],
        });
        return Response.json({
          htmlLink: "https://calendar.google.com/event-1",
          hangoutLink: "https://meet.google.com/abc-defg-hij",
          attendees: [
            { email: "lead@example.com" },
            { email: "colleague@example.com" },
          ],
        });
      })
      .mockImplementationOnce(async (input, init) => {
        expect(String(input)).toContain(
          `/calendars/${GOOGLE_PRIMARY_CALENDAR_ID}/events/event-1`,
        );
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          start: {
            dateTime: "2026-08-24T16:00:00.000Z",
            timeZone: "UTC",
          },
          end: {
            dateTime: "2026-08-24T16:30:00.000Z",
            timeZone: "UTC",
          },
        });
        return Response.json(
          googleBookingEvent("booking-456", {
            id: "event-1",
            htmlLink: "https://calendar.google.com/event-1",
            hangoutLink: "https://meet.google.com/abc-defg-hij",
          }),
        );
      })
      .mockImplementationOnce(async (input, init) => {
        expect(String(input)).toContain(
          `/calendars/${GOOGLE_PRIMARY_CALENDAR_ID}/events/event-1`,
        );
        expect(init?.method).toBe("DELETE");
        return new Response(null, { status: 204 });
      });
    const adapter = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      request,
    );
    const input = {
      subject: "Product tour",
      startsAt: new Date("2026-08-24T16:00:00Z"),
      endsAt: new Date("2026-08-24T16:30:00Z"),
      attendeeEmail: "lead@example.com",
      attendeeName: "Maya Buyer",
      additionalAttendeeEmails: ["colleague@example.com"],
      description: "Keep the organizer's edited agenda",
      transactionId: "booking-456",
      conferenceProvider: "google_meet" as const,
    };
    await expect(adapter.createEvent(input)).resolves.toMatchObject({
      conferenceUrl: "https://meet.google.com/abc-defg-hij",
    });
    await expect(adapter.updateEvent("event-1", input)).resolves.toMatchObject({
      externalEventId: "event-1",
    });
    await expect(adapter.cancelEvent("event-1")).resolves.toBeUndefined();
  });

  it("rejects wrong, moved, or cancelled update results", async () => {
    const input = {
      subject: "Product tour",
      startsAt: new Date("2026-08-24T16:00:00Z"),
      endsAt: new Date("2026-08-24T16:30:00Z"),
      transactionId: "booking-update-proof",
    };
    const wrong = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      async () => Response.json(googleBookingEvent(input.transactionId)),
    );
    await expect(wrong.updateEvent("owned-event", input)).rejects.toThrow(
      "wrong booking event",
    );

    const moved = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      async () =>
        Response.json(
          googleBookingEvent(input.transactionId, {
            id: "owned-event",
            start: { dateTime: "2026-08-24T17:00:00Z" },
            end: { dateTime: "2026-08-24T17:30:00Z" },
          }),
        ),
    );
    await expect(moved.updateEvent("owned-event", input)).rejects.toThrow(
      "outside the reserved time",
    );

    const cancelled = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      async () =>
        Response.json(
          googleBookingEvent(input.transactionId, {
            id: "owned-event",
            status: "cancelled",
          }),
        ),
    );
    await expect(cancelled.updateEvent("owned-event", input)).rejects.toThrow(
      "cancelled booking event",
    );
  });

  it("attaches a configured Zoom room to a Google event", async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        location: string;
        conferenceData?: unknown;
      };
      expect(body.location).toBe("https://zoom.us/j/123456789");
      expect(body.conferenceData).toBeUndefined();
      return Response.json(googleBookingEvent("booking-zoom"));
    });
    const adapter = new GoogleRepCalendarAdapter(
      async () => "rep-token",
      request,
    );

    await expect(
      adapter.createEvent({
        subject: "Zoom room",
        startsAt: new Date("2026-08-24T16:00:00Z"),
        endsAt: new Date("2026-08-24T16:30:00Z"),
        transactionId: "booking-zoom",
        conferenceProvider: "zoom",
        conferenceUrl: "https://zoom.us/j/123456789",
      }),
    ).resolves.toMatchObject({
      conferenceUrl: "https://zoom.us/j/123456789",
    });
  });

  it("does not start a provider write when the deadline aborts during token acquisition", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>();
    const adapter = new GoogleRepCalendarAdapter(async () => {
      controller.abort();
      return "rep-token";
    }, request);

    await expect(
      adapter.createEvent({
        subject: "Product tour",
        startsAt: new Date("2026-08-24T16:00:00Z"),
        endsAt: new Date("2026-08-24T16:30:00Z"),
        transactionId: "booking-aborted-before-write",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("Google Calendar free/busy", () => {
  it("returns only representatives with overlapping busy periods", async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        items: Array<{ id: string }>;
      };
      expect(body.items).toEqual([
        { id: "ada@acme.example" },
        { id: "marcus@acme.example" },
      ]);
      return Response.json({
        calendars: {
          "ada@acme.example": {
            busy: [
              {
                start: "2026-08-24T16:00:00Z",
                end: "2026-08-24T16:30:00Z",
              },
            ],
          },
          "marcus@acme.example": { busy: [] },
        },
      });
    });
    const adapter = new GoogleCalendarAdapter(
      async () => "access-token",
      request,
    );

    const busy = await adapter.busyRepEmails({
      repEmails: ["ada@acme.example", "marcus@acme.example"],
      startsAt: new Date("2026-08-24T16:00:00Z"),
      endsAt: new Date("2026-08-24T16:30:00Z"),
    });

    expect(busy).toEqual(["ada@acme.example"]);
  });

  it("fails closed when a calendar cannot be checked", async () => {
    const adapter = new GoogleCalendarAdapter(
      async () => "access-token",
      async () => Response.json({ calendars: {} }),
    );
    await expect(
      adapter.busyRepEmails({
        repEmails: ["ada@acme.example"],
        startsAt: new Date("2026-08-24T16:00:00Z"),
        endsAt: new Date("2026-08-24T16:30:00Z"),
      }),
    ).rejects.toThrow("could not verify availability");
  });
});
