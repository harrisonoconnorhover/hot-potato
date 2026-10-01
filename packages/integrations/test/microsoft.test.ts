import { describe, expect, it, vi } from "vitest";
import {
  MICROSOFT_DEFAULT_CALENDAR_ID,
  MicrosoftCalendarAdapter,
  MicrosoftOAuthClient,
  MicrosoftRepCalendarAdapter,
} from "../src/index.js";

const personalIdToken = `header.${Buffer.from(
  JSON.stringify({ tid: "9188040d-6c67-4c5b-b112-36a304b66dad" }),
).toString("base64url")}.signature`;

function microsoftBookingEvent(
  transactionId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `event-${transactionId}`,
    transactionId,
    isCancelled: false,
    start: { dateTime: "2026-08-24T16:00:00", timeZone: "UTC" },
    end: { dateTime: "2026-08-24T16:30:00", timeZone: "UTC" },
    ...overrides,
  };
}

describe("Microsoft OAuth", () => {
  it("uses PKCE and stores the authorized Microsoft identity", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/token")) {
        const form = init?.body as URLSearchParams;
        expect(form.get("code_verifier")).toBe("pkce-verifier");
        expect(form.get("grant_type")).toBe("authorization_code");
        return Response.json({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          id_token: personalIdToken,
          scope: "User.Read Calendars.ReadBasic",
        });
      }
      expect(url).toContain("graph.microsoft.com/v1.0/me");
      return Response.json({
        id: "microsoft-user-1",
        displayName: "Ada Chen",
        mail: "ada@acme.example",
        userPrincipalName: "ada@acme.example",
      });
    });
    const client = new MicrosoftOAuthClient(
      { clientId: "client", clientSecret: "secret" },
      request,
    );
    const authorization = new URL(
      client.authorizationUrl({
        state: "state-value",
        redirectUri: "http://localhost:3000/callback",
        codeChallenge: "pkce-challenge",
      }),
    );
    expect(authorization.pathname).toContain("/common/");
    expect(authorization.searchParams.get("code_challenge")).toBe(
      "pkce-challenge",
    );
    expect(authorization.searchParams.get("scope")).toContain(
      "Calendars.ReadBasic",
    );

    const tokens = await client.exchangeCode({
      code: "oauth-code",
      redirectUri: "http://localhost:3000/callback",
      codeVerifier: "pkce-verifier",
    });
    expect(tokens.refreshToken).toBe("refresh");
    expect(tokens.externalAccountId).toBe("microsoft-user-1");
    expect(tokens.externalAccountName).toBe("ada@acme.example");
    expect(tokens.metadata).toMatchObject({
      accountType: "personal",
      availabilityMode: "unsupported",
    });
  });

  it("requests write access for representative-owned calendars", () => {
    const client = new MicrosoftOAuthClient({
      clientId: "client",
      clientSecret: "secret",
      calendarScope: "Calendars.ReadWrite",
    });
    const authorization = new URL(
      client.authorizationUrl({
        state: "state-value",
        redirectUri: "http://localhost:3000/rep-callback",
        codeChallenge: "pkce-challenge",
      }),
    );
    expect(authorization.searchParams.get("scope")).toContain(
      "Calendars.ReadWrite",
    );
    expect(authorization.searchParams.get("scope")).not.toContain(
      "Calendars.ReadBasic",
    );
  });
});

describe("representative-owned Microsoft calendars", () => {
  it("discovers owned calendars across pages and maps the default to a stable ID", async () => {
    const controller = new AbortController();
    const request = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/v1.0/me/calendars");
        expect(url.searchParams.get("$select")).toBe(
          "id,name,isDefaultCalendar",
        );
        expect(init?.signal).toBe(controller.signal);
        return Response.json({
          value: [
            {
              id: "outlook-default-id",
              name: "Calendar",
              isDefaultCalendar: true,
            },
            {
              id: "focus/calendar",
              name: "Focus",
              isDefaultCalendar: false,
            },
          ],
          "@odata.nextLink":
            "https://graph.microsoft.com/v1.0/me/calendars?$skip=100",
        });
      })
      .mockResolvedValueOnce(
        Response.json({
          value: [
            {
              id: "focus/calendar",
              name: "Focus",
              isDefaultCalendar: false,
            },
            {
              id: "travel-id",
              name: "Travel",
              isDefaultCalendar: false,
            },
          ],
        }),
      );
    const adapter = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      request,
    );

    await expect(
      adapter.listCalendars({ signal: controller.signal }),
    ).resolves.toEqual([
      {
        id: MICROSOFT_DEFAULT_CALENDAR_ID,
        name: "Calendar",
        isDefault: true,
      },
      { id: "focus/calendar", name: "Focus", isDefault: false },
      { id: "travel-id", name: "Travel", isDefault: false },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("requires exactly one valid default calendar during discovery", async () => {
    const noDefault = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      async () =>
        Response.json({
          value: [
            { id: "secondary", name: "Secondary", isDefaultCalendar: false },
          ],
        }),
    );
    await expect(noDefault.listCalendars()).rejects.toThrow(
      "exactly one default calendar",
    );

    const twoDefaults = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      async () =>
        Response.json({
          value: [
            { id: "one", name: "One", isDefaultCalendar: true },
            { id: "two", name: "Two", isDefaultCalendar: true },
          ],
        }),
    );
    await expect(twoDefaults.listCalendars()).rejects.toThrow(
      "exactly one default calendar",
    );
  });

  it.each([
    "https://example.com/v1.0/me/calendars?$skip=100",
    "https://graph.microsoft.com/v1.0/users/other/calendars?$skip=100",
  ])("rejects unsafe calendar discovery pagination: %s", async (nextLink) => {
    const adapter = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      async () =>
        Response.json({
          value: [{ id: "default", name: "Calendar", isDefaultCalendar: true }],
          "@odata.nextLink": nextLink,
        }),
    );
    await expect(adapter.listCalendars()).rejects.toThrow("unsafe next page");
  });

  it("bounds calendar discovery pagination", async () => {
    let page = 0;
    const request = vi.fn<typeof fetch>(async () => {
      page += 1;
      return Response.json({
        value:
          page === 1
            ? [
                {
                  id: "outlook-default-id",
                  name: "Calendar",
                  isDefaultCalendar: true,
                },
              ]
            : [],
        "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/calendars?$skip=${page * 100}`,
      });
    });
    const adapter = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      request,
    );

    await expect(adapter.listCalendars()).rejects.toThrow(
      "exceeded the pagination limit",
    );
    expect(request).toHaveBeenCalledTimes(50);
  });

  it("checks the signed-in representative's own calendar view", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1.0/me/calendarView");
      expect(url.searchParams.get("startDateTime")).toBe(
        "2026-08-24T16:00:00.000Z",
      );
      return Response.json({
        value: [
          {
            showAs: "busy",
            isCancelled: false,
            start: { dateTime: "2026-08-24T16:00:00", timeZone: "UTC" },
            end: { dateTime: "2026-08-24T16:30:00", timeZone: "UTC" },
          },
        ],
      });
    });
    const adapter = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      request,
    );
    await expect(
      adapter.busyRepEmails({
        repEmails: ["ada@acme.example"],
        startsAt: new Date("2026-08-24T16:00:00Z"),
        endsAt: new Date("2026-08-24T16:30:00Z"),
      }),
    ).resolves.toEqual(["ada@acme.example"]);
  });

  it("returns busy intervals across paginated calendar results", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          value: [
            {
              showAs: "free",
              isCancelled: false,
              start: { dateTime: "2026-08-24T15:00:00", timeZone: "UTC" },
              end: { dateTime: "2026-08-24T15:30:00", timeZone: "UTC" },
            },
          ],
          "@odata.nextLink":
            "https://graph.microsoft.com/v1.0/me/calendarView?$skip=1000",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          value: [
            {
              showAs: "busy",
              isCancelled: false,
              start: { dateTime: "2026-08-24T16:00:00", timeZone: "UTC" },
              end: { dateTime: "2026-08-24T16:30:00", timeZone: "UTC" },
            },
          ],
        }),
      );
    const adapter = new MicrosoftRepCalendarAdapter(
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
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("unions default and selected secondary calendar conflicts once", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(init?.headers).toMatchObject({
        authorization: "Bearer rep-token",
        prefer: 'outlook.timezone="UTC"',
      });
      const startsAt = url.pathname.includes("secondary%2Fcalendar")
        ? "2026-08-24T17:00:00"
        : "2026-08-24T16:00:00";
      return Response.json({
        value: [
          {
            showAs: "busy",
            isCancelled: false,
            start: { dateTime: startsAt, timeZone: "UTC" },
            end: {
              dateTime: startsAt.replace(":00:00", ":30:00"),
              timeZone: "UTC",
            },
          },
        ],
      });
    });
    const adapter = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      request,
    );

    await expect(
      adapter.busyIntervals({
        startsAt: new Date("2026-08-24T15:00:00Z"),
        endsAt: new Date("2026-08-24T18:00:00Z"),
        calendarIds: [
          MICROSOFT_DEFAULT_CALENDAR_ID,
          "secondary/calendar",
          MICROSOFT_DEFAULT_CALENDAR_ID,
        ],
      }),
    ).resolves.toEqual([
      {
        startsAt: new Date("2026-08-24T16:00:00Z"),
        endsAt: new Date("2026-08-24T16:30:00Z"),
      },
      {
        startsAt: new Date("2026-08-24T17:00:00Z"),
        endsAt: new Date("2026-08-24T17:30:00Z"),
      },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(new URL(String(request.mock.calls[0]![0])).pathname).toBe(
      "/v1.0/me/calendarView",
    );
    expect(new URL(String(request.mock.calls[1]![0])).pathname).toBe(
      "/v1.0/me/calendars/secondary%2Fcalendar/calendarView",
    );
  });

  it("limits selected calendar reads to four concurrent requests", async () => {
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const request = vi.fn<typeof fetch>(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
      return Response.json({ value: [] });
    });
    const adapter = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      request,
    );
    const pending = adapter.busyIntervals({
      startsAt: new Date("2026-08-24T15:00:00Z"),
      endsAt: new Date("2026-08-24T18:00:00Z"),
      calendarIds: [
        MICROSOFT_DEFAULT_CALENDAR_ID,
        "one",
        "two",
        "three",
        "four",
      ],
    });

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
    expect(maximum).toBe(4);
    release();
    await expect(pending).resolves.toEqual([]);
    expect(request).toHaveBeenCalledTimes(5);
  });

  it("rejects repeated calendar-view pages", async () => {
    const repeated =
      "https://graph.microsoft.com/v1.0/me/calendarView?$skip=1000";
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ value: [], "@odata.nextLink": repeated }),
      )
      .mockResolvedValueOnce(
        Response.json({ value: [], "@odata.nextLink": repeated }),
      );
    const adapter = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      request,
    );

    await expect(
      adapter.busyIntervals({
        startsAt: new Date("2026-08-24T15:00:00Z"),
        endsAt: new Date("2026-08-24T18:00:00Z"),
      }),
    ).rejects.toThrow("repeated a page");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("aborts an in-flight calendar read through the caller signal", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          expect(init?.signal).toBe(controller.signal);
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );
    const adapter = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      request,
    );
    const pending = adapter.busyIntervals({
      startsAt: new Date("2026-08-24T15:00:00Z"),
      endsAt: new Date("2026-08-24T18:00:00Z"),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("fails closed when any selected calendar cannot be read", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      return url.pathname.includes("unavailable")
        ? new Response("calendar missing", { status: 404 })
        : Response.json({ value: [] });
    });
    const adapter = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      request,
    );

    await expect(
      adapter.busyIntervals({
        startsAt: new Date("2026-08-24T15:00:00Z"),
        endsAt: new Date("2026-08-24T18:00:00Z"),
        calendarIds: [MICROSOFT_DEFAULT_CALENDAR_ID, "unavailable"],
      }),
    ).rejects.toThrow(
      "representative calendar availability failed with HTTP 404",
    );
  });

  it.each(["", " leading-space", "x".repeat(1_025)])(
    "rejects an invalid selected calendar ID",
    async (calendarId) => {
      const request = vi.fn<typeof fetch>();
      const adapter = new MicrosoftRepCalendarAdapter(
        async () => "rep-token",
        request,
      );
      await expect(
        adapter.busyIntervals({
          startsAt: new Date("2026-08-24T15:00:00Z"),
          endsAt: new Date("2026-08-24T18:00:00Z"),
          calendarIds: [calendarId],
        }),
      ).rejects.toThrow("invalid ID");
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("treats free, working elsewhere, and cancelled events as available", async () => {
    const event = (showAs: string, startsAt: string, isCancelled = false) => ({
      showAs,
      isCancelled,
      start: { dateTime: startsAt, timeZone: "UTC" },
      end: {
        dateTime: new Date(new Date(`${startsAt}Z`).getTime() + 30 * 60 * 1_000)
          .toISOString()
          .slice(0, 19),
        timeZone: "UTC",
      },
    });
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        value: [
          event("free", "2026-08-24T15:00:00"),
          event("workingElsewhere", "2026-08-24T15:30:00"),
          event("busy", "2026-08-24T16:00:00", true),
          event("tentative", "2026-08-24T16:30:00"),
          event("busy", "2026-08-24T17:00:00"),
          event("oof", "2026-08-24T17:30:00"),
          event("unknown", "2026-08-24T18:00:00"),
        ],
      }),
    );
    const adapter = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      request,
    );

    await expect(
      adapter.busyIntervals({
        startsAt: new Date("2026-08-24T15:00:00Z"),
        endsAt: new Date("2026-08-24T19:00:00Z"),
      }),
    ).resolves.toEqual([
      {
        startsAt: new Date("2026-08-24T16:30:00Z"),
        endsAt: new Date("2026-08-24T17:00:00Z"),
      },
      {
        startsAt: new Date("2026-08-24T17:00:00Z"),
        endsAt: new Date("2026-08-24T17:30:00Z"),
      },
      {
        startsAt: new Date("2026-08-24T17:30:00Z"),
        endsAt: new Date("2026-08-24T18:00:00Z"),
      },
      {
        startsAt: new Date("2026-08-24T18:00:00Z"),
        endsAt: new Date("2026-08-24T18:30:00Z"),
      },
    ]);
  });

  it("reconciles the owned transaction through the exact default-calendar view", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1.0/me/calendarView");
      expect(url.searchParams.get("startDateTime")).toBe(
        "2026-08-24T16:00:00.000Z",
      );
      expect(url.searchParams.get("endDateTime")).toBe(
        "2026-08-24T16:30:00.000Z",
      );
      expect(url.searchParams.get("$select")).toContain("transactionId");
      expect(init?.method).toBeUndefined();
      expect(init?.signal).toBe(controller.signal);
      return Response.json({
        value: [
          {
            id: "unrelated",
            transactionId: "someone-else",
          },
          {
            id: "owned-event",
            transactionId: "booking-owned",
            isCancelled: false,
            webLink: "https://outlook.office.com/owned",
            onlineMeeting: {
              joinUrl: "https://teams.microsoft.com/owned",
            },
            start: { dateTime: "2026-08-24T16:00:00", timeZone: "UTC" },
            end: { dateTime: "2026-08-24T16:30:00", timeZone: "UTC" },
          },
        ],
      });
    });
    const adapter = new MicrosoftRepCalendarAdapter(
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
    ).resolves.toEqual({
      externalEventId: "owned-event",
      webLink: "https://outlook.office.com/owned",
      conferenceUrl: "https://teams.microsoft.com/owned",
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("preserves an exact whitespace-bearing legacy transaction identity", async () => {
    const transactionId = " legacy-booking-id ";
    const request = vi.fn<typeof fetch>(async () =>
      Response.json({
        value: [
          {
            id: "legacy-owned-event",
            transactionId,
            isCancelled: false,
            start: { dateTime: "2026-08-24T16:00:00", timeZone: "UTC" },
            end: { dateTime: "2026-08-24T16:30:00", timeZone: "UTC" },
          },
        ],
      }),
    );
    const adapter = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      request,
    );

    await expect(
      adapter.findEventByTransactionId({
        transactionId,
        startsAt: new Date("2026-08-24T16:00:00Z"),
        endsAt: new Date("2026-08-24T16:30:00Z"),
      }),
    ).resolves.toMatchObject({ externalEventId: "legacy-owned-event" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("returns null only for a definitive absence and fails closed on uncertainty", async () => {
    const input = {
      transactionId: "booking-missing",
      startsAt: new Date("2026-08-24T16:00:00Z"),
      endsAt: new Date("2026-08-24T16:30:00Z"),
    };
    const missing = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      async () => Response.json({ value: [] }),
    );
    await expect(missing.findEventByTransactionId(input)).resolves.toBeNull();

    const uncertain = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      async () => new Response("upstream timeout", { status: 503 }),
    );
    await expect(uncertain.findEventByTransactionId(input)).rejects.toThrow(
      "booking event reconciliation failed with HTTP 503",
    );
  });

  it("rejects ambiguous or moved transaction matches", async () => {
    const input = {
      transactionId: "booking-conflict",
      startsAt: new Date("2026-08-24T16:00:00Z"),
      endsAt: new Date("2026-08-24T16:30:00Z"),
    };
    const event = {
      id: "event-one",
      transactionId: input.transactionId,
      isCancelled: false,
      start: { dateTime: "2026-08-24T16:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-08-24T16:30:00", timeZone: "UTC" },
    };
    const ambiguous = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      async () =>
        Response.json({ value: [event, { ...event, id: "event-two" }] }),
    );
    await expect(ambiguous.findEventByTransactionId(input)).rejects.toThrow(
      "ambiguous booking ownership evidence",
    );

    const moved = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      async () =>
        Response.json({
          value: [
            {
              ...event,
              start: {
                dateTime: "2026-08-24T17:00:00",
                timeZone: "UTC",
              },
              end: {
                dateTime: "2026-08-24T17:30:00",
                timeZone: "UTC",
              },
            },
          ],
        }),
    );
    await expect(moved.findEventByTransactionId(input)).rejects.toThrow(
      "outside the reserved time",
    );
  });

  it("keeps idempotent writes on the signed-in default calendar", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://graph.microsoft.com/v1.0/me/events");
      const body = JSON.parse(String(init?.body)) as {
        subject: string;
        transactionId: string;
        body?: { content: string };
        attendees: Array<{
          emailAddress: { address: string; name?: string };
        }>;
      };
      expect(body).toMatchObject({
        subject: "Intro meeting",
        transactionId: "booking-123",
      });
      expect(body.attendees[0]?.emailAddress.address).toBe("lead@example.com");
      expect(body.attendees[0]?.emailAddress.name).toBe("Maya Buyer");
      expect(body.attendees.slice(1)).toEqual([
        {
          emailAddress: { address: "colleague@example.com" },
          type: "required",
        },
        {
          emailAddress: { address: "observer@example.com" },
          type: "required",
        },
      ]);
      expect(body.body?.content).toContain("Scheduled through Hot Potato");
      return Response.json(
        microsoftBookingEvent("booking-123", {
          id: "event-1",
          webLink: "https://outlook.office.com/event-1",
          attendees: body.attendees,
        }),
        { status: 201 },
      );
    });
    const adapter = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      request,
    );
    await expect(
      adapter.createEvent({
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
      }),
    ).resolves.toEqual({
      externalEventId: "event-1",
      webLink: "https://outlook.office.com/event-1",
      conferenceUrl: null,
    });
  });

  it("repairs a missing guest on an idempotent Outlook create response", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          microsoftBookingEvent("booking-retry-guests", {
            id: "event-retry-guests",
            attendees: [
              {
                emailAddress: { address: "lead@example.com" },
                type: "required",
              },
            ],
          }),
        ),
      )
      .mockImplementationOnce(async (input, init) => {
        expect(String(input)).toContain("/events/event-retry-guests");
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          attendees: [
            {
              emailAddress: { address: "lead@example.com" },
              type: "required",
            },
            {
              emailAddress: { address: "guest@example.com" },
              type: "required",
            },
          ],
        });
        return Response.json(
          microsoftBookingEvent("booking-retry-guests", {
            id: "event-retry-guests",
            attendees: [
              {
                emailAddress: { address: "lead@example.com" },
                type: "required",
              },
              {
                emailAddress: { address: "guest@example.com" },
                type: "required",
              },
            ],
          }),
        );
      });
    const adapter = new MicrosoftRepCalendarAdapter(
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
        transactionId: "booking-retry-guests",
      }),
    ).resolves.toMatchObject({ externalEventId: "event-retry-guests" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects moved, cancelled, or malformed create results", async () => {
    const input = {
      subject: "Intro meeting",
      startsAt: new Date("2026-08-24T16:00:00Z"),
      endsAt: new Date("2026-08-24T16:30:00Z"),
      transactionId: "booking-create-proof",
    };
    const moved = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      async () =>
        Response.json(
          microsoftBookingEvent(input.transactionId, {
            start: { dateTime: "2026-08-24T17:00:00", timeZone: "UTC" },
            end: { dateTime: "2026-08-24T17:30:00", timeZone: "UTC" },
          }),
        ),
    );
    await expect(moved.createEvent(input)).rejects.toThrow(
      "outside the reserved time",
    );

    const cancelled = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      async () =>
        Response.json(
          microsoftBookingEvent(input.transactionId, { isCancelled: true }),
        ),
    );
    await expect(cancelled.createEvent(input)).rejects.toThrow(
      "cancelled booking event",
    );

    const malformed = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      async () =>
        Response.json(microsoftBookingEvent(input.transactionId, { id: "" })),
    );
    await expect(malformed.createEvent(input)).rejects.toThrow(
      "invalid booking event ID",
    );
  });

  it("keeps event writes on the default calendar after checking a secondary", async () => {
    const paths: string[] = [];
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (init?.method === "POST") {
        return Response.json(
          microsoftBookingEvent("default-after-secondary", {
            id: "event-after-secondary",
          }),
          { status: 201 },
        );
      }
      return Response.json({ value: [] });
    });
    const adapter = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      request,
    );
    await adapter.busyIntervals({
      startsAt: new Date("2026-08-24T15:00:00Z"),
      endsAt: new Date("2026-08-24T18:00:00Z"),
      calendarIds: ["secondary"],
    });
    await adapter.createEvent({
      subject: "Default calendar write",
      startsAt: new Date("2026-08-24T16:00:00Z"),
      endsAt: new Date("2026-08-24T16:30:00Z"),
      transactionId: "default-after-secondary",
    });

    expect(paths).toEqual([
      "/v1.0/me/calendars/secondary/calendarView",
      "/v1.0/me/events",
    ]);
  });

  it("creates, time-only reschedules, and cancels a Microsoft Teams event", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          attendees: unknown[];
          isOnlineMeeting: boolean;
          onlineMeetingProvider: string;
        };
        expect(body.attendees).toEqual([]);
        expect(body.isOnlineMeeting).toBe(true);
        expect(body.onlineMeetingProvider).toBe("teamsForBusiness");
        return Response.json(
          microsoftBookingEvent("booking-789", {
            id: "event-2",
            webLink: "https://outlook.office.com/event-2",
            onlineMeeting: {
              joinUrl: "https://teams.microsoft.com/l/meetup-join/2",
            },
          }),
        );
      })
      .mockImplementationOnce(async (input, init) => {
        expect(String(input)).toContain("/events/event-2");
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          attendees: [
            {
              emailAddress: {
                address: "lead@example.com",
                name: "Maya Buyer",
              },
              type: "required",
            },
            {
              emailAddress: { address: "colleague@example.com" },
              type: "required",
            },
          ],
        });
        return Response.json({
          id: "event-2",
          webLink: "https://outlook.office.com/event-2",
          onlineMeeting: {
            joinUrl: "https://teams.microsoft.com/l/meetup-join/2",
          },
          attendees: [
            { emailAddress: { address: "lead@example.com" }, type: "required" },
            {
              emailAddress: { address: "colleague@example.com" },
              type: "required",
            },
          ],
        });
      })
      .mockImplementationOnce(async (input, init) => {
        expect(String(input)).toContain("/events/event-2");
        expect(init?.method).toBe("PATCH");
        expect(JSON.parse(String(init?.body))).toEqual({
          start: { dateTime: "2026-08-24T16:00:00", timeZone: "UTC" },
          end: { dateTime: "2026-08-24T16:30:00", timeZone: "UTC" },
        });
        return Response.json(
          microsoftBookingEvent("booking-789", {
            id: "event-2",
            webLink: "https://outlook.office.com/event-2",
            onlineMeeting: {
              joinUrl: "https://teams.microsoft.com/l/meetup-join/2",
            },
          }),
        );
      })
      .mockImplementationOnce(async (_input, init) => {
        expect(init?.method).toBe("DELETE");
        return new Response(null, { status: 204 });
      });
    const adapter = new MicrosoftRepCalendarAdapter(
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
      transactionId: "booking-789",
      conferenceProvider: "microsoft_teams" as const,
    };
    await expect(adapter.createEvent(input)).resolves.toMatchObject({
      conferenceUrl: "https://teams.microsoft.com/l/meetup-join/2",
    });
    await expect(adapter.updateEvent("event-2", input)).resolves.toMatchObject({
      externalEventId: "event-2",
    });
    await expect(adapter.cancelEvent("event-2")).resolves.toBeUndefined();
  });

  it("rejects wrong, moved, or cancelled update results", async () => {
    const input = {
      subject: "Product tour",
      startsAt: new Date("2026-08-24T16:00:00Z"),
      endsAt: new Date("2026-08-24T16:30:00Z"),
      transactionId: "booking-update-proof",
    };
    const wrong = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      async () => Response.json(microsoftBookingEvent(input.transactionId)),
    );
    await expect(wrong.updateEvent("owned-event", input)).rejects.toThrow(
      "wrong booking event",
    );

    const moved = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      async () =>
        Response.json(
          microsoftBookingEvent(input.transactionId, {
            id: "owned-event",
            start: { dateTime: "2026-08-24T17:00:00", timeZone: "UTC" },
            end: { dateTime: "2026-08-24T17:30:00", timeZone: "UTC" },
          }),
        ),
    );
    await expect(moved.updateEvent("owned-event", input)).rejects.toThrow(
      "outside the reserved time",
    );

    const cancelled = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      async () =>
        Response.json(
          microsoftBookingEvent(input.transactionId, {
            id: "owned-event",
            isCancelled: true,
          }),
        ),
    );
    await expect(cancelled.updateEvent("owned-event", input)).rejects.toThrow(
      "cancelled booking event",
    );
  });

  it("fails closed when a required Teams join URL is missing", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          microsoftBookingEvent("booking-without-teams-url", {
            id: "event-without-teams-url",
            webLink: "https://outlook.office.com/event-without-teams-url",
            onlineMeeting: null,
          }),
        ),
      )
      .mockImplementationOnce(async (_input, init) => {
        expect(init?.method).toBe("DELETE");
        return new Response(null, { status: 204 });
      })
      .mockResolvedValueOnce(
        Response.json(
          microsoftBookingEvent("booking-without-teams-url", {
            id: "event-without-teams-url",
            webLink: "https://outlook.office.com/event-without-teams-url",
            onlineMeeting: null,
          }),
        ),
      );
    const adapter = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      request,
    );
    const input = {
      subject: "Product tour",
      startsAt: new Date("2026-08-24T16:00:00Z"),
      endsAt: new Date("2026-08-24T16:30:00Z"),
      transactionId: "booking-without-teams-url",
      conferenceProvider: "microsoft_teams" as const,
    };

    await expect(adapter.createEvent(input)).rejects.toThrow(
      "did not return a Microsoft Teams join URL",
    );
    await expect(
      adapter.updateEvent("event-without-teams-url", input),
    ).rejects.toThrow("did not return a Microsoft Teams join URL");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("cleans up after a permanent Teams attendee invitation failure", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { attendees: unknown[] };
        expect(body.attendees).toEqual([]);
        return Response.json(
          microsoftBookingEvent("booking-invite-failed", {
            id: "event-invite-failed",
            onlineMeeting: {
              joinUrl: "https://teams.microsoft.com/l/meetup-join/failed",
            },
          }),
        );
      })
      .mockResolvedValueOnce(new Response("invalid attendee", { status: 400 }))
      .mockImplementationOnce(async (_input, init) => {
        expect(init?.method).toBe("DELETE");
        return new Response(null, { status: 204 });
      });
    const adapter = new MicrosoftRepCalendarAdapter(
      async () => "rep-token",
      request,
    );

    await expect(
      adapter.createEvent({
        subject: "Product tour",
        startsAt: new Date("2026-08-24T16:00:00Z"),
        endsAt: new Date("2026-08-24T16:30:00Z"),
        attendeeEmail: "lead@example.com",
        transactionId: "booking-invite-failed",
        conferenceProvider: "microsoft_teams",
      }),
    ).rejects.toThrow("calendar attendee invitation failed with HTTP 400");
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("attaches a configured Zoom room to an Outlook event", async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        location: { displayName: string; locationUri: string };
        isOnlineMeeting?: boolean;
      };
      expect(body.location).toEqual({
        displayName: "Zoom",
        locationUri: "https://zoom.us/j/123456789",
      });
      expect(body.isOnlineMeeting).toBeUndefined();
      return Response.json(
        microsoftBookingEvent("booking-zoom", { id: "event-zoom" }),
      );
    });
    const adapter = new MicrosoftRepCalendarAdapter(
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
    const adapter = new MicrosoftRepCalendarAdapter(async () => {
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

describe("Microsoft 365 free/busy", () => {
  it("returns only representatives with non-free Outlook slots", async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        schedules: string[];
        startTime: { timeZone: string };
      };
      expect(body.schedules).toEqual([
        "ada@acme.example",
        "marcus@acme.example",
        "grace@acme.example",
      ]);
      expect(body.startTime.timeZone).toBe("UTC");
      return Response.json({
        value: [
          { scheduleId: "ada@acme.example", availabilityView: "2" },
          { scheduleId: "marcus@acme.example", availabilityView: "0" },
          { scheduleId: "grace@acme.example", availabilityView: "4" },
        ],
      });
    });
    const adapter = new MicrosoftCalendarAdapter(
      async () => "access-token",
      request,
    );

    const busy = await adapter.busyRepEmails({
      repEmails: [
        "ada@acme.example",
        "marcus@acme.example",
        "grace@acme.example",
      ],
      startsAt: new Date("2026-08-24T16:00:00Z"),
      endsAt: new Date("2026-08-24T16:30:00Z"),
    });

    expect(busy).toEqual(["ada@acme.example"]);
  });

  it("fails closed when Outlook cannot return a requested schedule", async () => {
    const adapter = new MicrosoftCalendarAdapter(
      async () => "access-token",
      async () => Response.json({ value: [] }),
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
