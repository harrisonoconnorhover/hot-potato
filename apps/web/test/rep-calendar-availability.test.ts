import { afterEach, describe, expect, it, vi } from "vitest";

type IntervalQuery = {
  startsAt: Date;
  endsAt: Date;
  calendarIds?: string[];
  signal?: AbortSignal;
};

type BusyInterval = { startsAt: Date; endsAt: Date };
type LookupInput = {
  transactionId: string;
  startsAt: Date;
  endsAt: Date;
  signal?: AbortSignal;
};

const adapterMocks = vi.hoisted(() => ({
  accessToken: vi.fn(async () => "access-token"),
  googleBusyIntervals:
    vi.fn<(input: IntervalQuery) => Promise<BusyInterval[]>>(),
  microsoftBusyIntervals:
    vi.fn<(input: IntervalQuery) => Promise<BusyInterval[]>>(),
  googleFindEvent: vi.fn<
    (input: LookupInput) => Promise<{
      externalEventId: string;
      webLink: string | null;
      conferenceUrl: string | null;
    } | null>
  >(),
  microsoftFindEvent: vi.fn<
    (input: LookupInput) => Promise<{
      externalEventId: string;
      webLink: string | null;
      conferenceUrl: string | null;
    } | null>
  >(),
}));

vi.mock("@hot-potato/integrations", () => ({
  GoogleRepCalendarAdapter: class MockGoogleRepCalendarAdapter {
    constructor(private readonly getAccessToken: () => Promise<string>) {}
    async busyIntervals(input: IntervalQuery) {
      await this.getAccessToken();
      return adapterMocks.googleBusyIntervals(input);
    }
    async findEventByTransactionId(input: LookupInput) {
      await this.getAccessToken();
      return adapterMocks.googleFindEvent(input);
    }
  },
  MicrosoftRepCalendarAdapter: class MockMicrosoftRepCalendarAdapter {
    constructor(private readonly getAccessToken: () => Promise<string>) {}
    async busyIntervals(input: IntervalQuery) {
      await this.getAccessToken();
      return adapterMocks.microsoftBusyIntervals(input);
    }
    async findEventByTransactionId(input: LookupInput) {
      await this.getAccessToken();
      return adapterMocks.microsoftFindEvent(input);
    }
  },
}));

vi.mock("../app/connections", () => ({
  repCalendarManager: () => ({
    accessToken: adapterMocks.accessToken,
  }),
}));

import {
  calendarSource,
  combinedRepBusyIntervals,
  findOwnedRepCalendarEvent,
} from "../app/rep-calendar-availability";

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("representative calendar availability", () => {
  it("uses the assigned rep OAuth adapter for read-only owned-event reconciliation", async () => {
    const startsAt = new Date("2026-08-30T09:00:00.000Z");
    const endsAt = new Date("2026-08-30T09:30:00.000Z");
    adapterMocks.googleFindEvent.mockResolvedValue({
      externalEventId: "google-event",
      webLink: null,
      conferenceUrl: null,
    });

    await expect(
      findOwnedRepCalendarEvent({
        organizationSlug: "acme",
        repId: "rep-1",
        provider: "google",
        calendarExternalAccountId: "google-account-1",
        transactionId: "booking-1",
        startsAt,
        endsAt,
      }),
    ).resolves.toMatchObject({ externalEventId: "google-event" });
    expect(adapterMocks.googleFindEvent).toHaveBeenCalledWith({
      transactionId: "booking-1",
      startsAt,
      endsAt,
      signal: expect.any(AbortSignal),
    });
    expect(adapterMocks.microsoftFindEvent).not.toHaveBeenCalled();
    expect(adapterMocks.accessToken).toHaveBeenCalledWith(
      "acme",
      "rep-1",
      "google",
      "google-account-1",
    );
  });

  it("fails before provider access when a legacy booking has no account identity", async () => {
    await expect(
      findOwnedRepCalendarEvent({
        organizationSlug: "acme",
        repId: "rep-1",
        provider: "google",
        calendarExternalAccountId: null,
        transactionId: "legacy-booking",
        startsAt: new Date("2026-08-30T09:00:00.000Z"),
        endsAt: new Date("2026-08-30T09:30:00.000Z"),
      }),
    ).rejects.toThrow("not bound to a verified calendar account");
    expect(adapterMocks.googleFindEvent).not.toHaveBeenCalled();
    expect(adapterMocks.accessToken).not.toHaveBeenCalled();
  });

  it("fails closed when provider evidence conflicts with the durable event id", async () => {
    adapterMocks.microsoftFindEvent.mockResolvedValue({
      externalEventId: "different-event",
      webLink: null,
      conferenceUrl: null,
    });
    await expect(
      findOwnedRepCalendarEvent({
        organizationSlug: "acme",
        repId: "rep-1",
        provider: "microsoft",
        calendarExternalAccountId: "microsoft-account-1",
        transactionId: "booking-1",
        externalEventId: "durable-event",
        startsAt: new Date("2026-08-30T09:00:00.000Z"),
        endsAt: new Date("2026-08-30T09:30:00.000Z"),
      }),
    ).rejects.toThrow("conflicting booking event evidence");
  });

  it("groups and deduplicates selected calendar IDs while merging provider intervals in order", async () => {
    const startsAt = new Date("2026-08-30T08:00:00.000Z");
    const endsAt = new Date("2026-08-30T12:00:00.000Z");
    const early = {
      startsAt: new Date("2026-08-30T09:00:00.000Z"),
      endsAt: new Date("2026-08-30T09:15:00.000Z"),
    };
    const middle = {
      startsAt: new Date("2026-08-30T10:00:00.000Z"),
      endsAt: new Date("2026-08-30T10:30:00.000Z"),
    };
    const late = {
      startsAt: new Date("2026-08-30T11:00:00.000Z"),
      endsAt: new Date("2026-08-30T11:30:00.000Z"),
    };
    adapterMocks.googleBusyIntervals.mockResolvedValue([late, early]);
    adapterMocks.microsoftBusyIntervals.mockResolvedValue([middle]);

    const result = await combinedRepBusyIntervals({
      organizationSlug: "acme",
      repId: "rep-1",
      calendars: [
        {
          provider: "microsoft",
          calendarExternalAccountId: "microsoft-account-1",
          calendarId: "default",
          available: true,
        },
        {
          provider: "google",
          calendarExternalAccountId: "google-account-1",
          calendarId: "primary",
          available: true,
        },
        {
          provider: "google",
          calendarExternalAccountId: "google-account-1",
          calendarId: "sales",
          available: true,
        },
        {
          provider: "microsoft",
          calendarExternalAccountId: "microsoft-account-1",
          calendarId: "team-calendar",
          available: true,
        },
        {
          provider: "google",
          calendarExternalAccountId: "google-account-1",
          calendarId: "primary",
          available: true,
        },
        {
          provider: "microsoft",
          calendarExternalAccountId: "microsoft-account-1",
          calendarId: "default",
          available: true,
        },
      ],
      startsAt,
      endsAt,
    });

    expect(adapterMocks.googleBusyIntervals).toHaveBeenCalledOnce();
    expect(adapterMocks.googleBusyIntervals).toHaveBeenCalledWith({
      startsAt,
      endsAt,
      calendarIds: ["primary", "sales"],
      signal: expect.any(AbortSignal),
    });
    expect(adapterMocks.microsoftBusyIntervals).toHaveBeenCalledOnce();
    expect(adapterMocks.microsoftBusyIntervals).toHaveBeenCalledWith({
      startsAt,
      endsAt,
      calendarIds: ["default", "team-calendar"],
      signal: expect.any(AbortSignal),
    });
    expect(adapterMocks.accessToken).toHaveBeenCalledWith(
      "acme",
      "rep-1",
      "google",
      "google-account-1",
    );
    expect(adapterMocks.accessToken).toHaveBeenCalledWith(
      "acme",
      "rep-1",
      "microsoft",
      "microsoft-account-1",
    );
    expect(result).toEqual([early, middle, late]);
  });

  it("reports provider diversity in the availability source", () => {
    expect(
      calendarSource([
        {
          provider: "google",
          calendarExternalAccountId: "google-account-1",
          calendarId: "primary",
          available: true,
        },
        {
          provider: "microsoft",
          calendarExternalAccountId: "microsoft-account-1",
          calendarId: "default",
          available: true,
        },
      ]),
    ).toBe("connected_calendars");
    expect(
      calendarSource([
        {
          provider: "google",
          calendarExternalAccountId: "google-account-1",
          calendarId: "primary",
          available: true,
        },
      ]),
    ).toBe("google_calendar");
    expect(
      calendarSource([
        {
          provider: "microsoft",
          calendarExternalAccountId: "microsoft-account-1",
          calendarId: "default",
          available: true,
        },
      ]),
    ).toBe("microsoft_calendar");
  });

  it("fails closed when no conflict calendar is selected", async () => {
    await expect(
      combinedRepBusyIntervals({
        organizationSlug: "acme",
        repId: "rep-1",
        calendars: [],
        startsAt: new Date("2026-08-30T08:00:00.000Z"),
        endsAt: new Date("2026-08-30T12:00:00.000Z"),
      }),
    ).rejects.toThrow("The representative has no conflict calendar selected.");
    expect(adapterMocks.googleBusyIntervals).not.toHaveBeenCalled();
    expect(adapterMocks.microsoftBusyIntervals).not.toHaveBeenCalled();
  });

  it("fails closed when one provider's selected calendars span different accounts", async () => {
    await expect(
      combinedRepBusyIntervals({
        organizationSlug: "acme",
        repId: "rep-1",
        calendars: [
          {
            provider: "google",
            calendarExternalAccountId: "google-account-a",
            calendarId: "primary",
            available: true,
          },
          {
            provider: "google",
            calendarExternalAccountId: "google-account-b",
            calendarId: "sales",
            available: true,
          },
        ],
        startsAt: new Date("2026-08-30T08:00:00.000Z"),
        endsAt: new Date("2026-08-30T12:00:00.000Z"),
      }),
    ).rejects.toThrow("disagree about their connected account");
    expect(adapterMocks.googleBusyIntervals).not.toHaveBeenCalled();
    expect(adapterMocks.accessToken).not.toHaveBeenCalled();
  });

  it("fails closed before provider access when a selected calendar is stale", async () => {
    await expect(
      combinedRepBusyIntervals({
        organizationSlug: "acme",
        repId: "rep-1",
        calendars: [
          {
            provider: "google",
            calendarExternalAccountId: "google-account-1",
            calendarId: "removed",
            available: false,
          },
        ],
        startsAt: new Date("2026-08-30T08:00:00.000Z"),
        endsAt: new Date("2026-08-30T12:00:00.000Z"),
      }),
    ).rejects.toThrow("selected conflict calendar is no longer available");
    expect(adapterMocks.googleBusyIntervals).not.toHaveBeenCalled();
    expect(adapterMocks.microsoftBusyIntervals).not.toHaveBeenCalled();
  });

  it("aborts the provider signal and rejects as soon as its timeout expires", async () => {
    vi.useFakeTimers();
    let providerSignal: AbortSignal | undefined;
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    adapterMocks.googleBusyIntervals.mockImplementation((input) => {
      providerSignal = input.signal;
      markProviderStarted();
      return new Promise<BusyInterval[]>(() => undefined);
    });

    const result = combinedRepBusyIntervals({
      organizationSlug: "acme",
      repId: "rep-1",
      calendars: [
        {
          provider: "google",
          calendarExternalAccountId: "google-account-1",
          calendarId: "primary",
          available: true,
        },
      ],
      startsAt: new Date("2026-08-30T08:00:00.000Z"),
      endsAt: new Date("2026-08-30T12:00:00.000Z"),
      timeoutMs: 25,
    });
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const rejection = expect(result).rejects.toThrow(
      "Calendar availability timed out.",
    );

    await providerStarted;
    expect(providerSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(24);
    expect(settled).toBe(false);
    expect(providerSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(settled).toBe(true);
    expect(providerSignal?.aborted).toBe(true);
  });
});
