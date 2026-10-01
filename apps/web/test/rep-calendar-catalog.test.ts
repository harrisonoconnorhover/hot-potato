import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Provider = "google" | "microsoft";
type ConnectedCalendar = { id: string; name: string; isDefault: boolean };
type CatalogSettings = {
  connected: true;
  accountName: string | null;
  checkConflicts: boolean;
  canSyncCalendars: boolean;
  calendarCatalogSyncedAt: string | null;
  calendarCatalogError: string | null;
  calendars: Array<{
    calendarId: string;
    name: string;
    isDefault: boolean;
    selected: boolean;
    available: boolean;
    lastSeenAt: string | null;
    missingSince: string | null;
  }>;
};

const mocks = vi.hoisted(() => ({
  accessToken:
    vi.fn<
      (
        organizationSlug: string,
        repId: string,
        provider: Provider,
      ) => Promise<string>
    >(),
  googleAdapterConstructed: vi.fn(),
  microsoftAdapterConstructed: vi.fn(),
  googleListCalendars:
    vi.fn<(input: { signal?: AbortSignal }) => Promise<ConnectedCalendar[]>>(),
  microsoftListCalendars:
    vi.fn<(input: { signal?: AbortSignal }) => Promise<ConnectedCalendar[]>>(),
  repCalendarSettings:
    vi.fn<
      (
        organizationSlug: string,
        repId: string,
        provider: Provider,
      ) => Promise<CatalogSettings | null>
    >(),
  syncRepCalendarSources:
    vi.fn<
      (input: {
        organizationSlug: string;
        repId: string;
        provider: Provider;
        calendars: ConnectedCalendar[];
      }) => Promise<void>
    >(),
  recordRepCalendarCatalogError:
    vi.fn<
      (input: {
        organizationSlug: string;
        repId: string;
        provider: Provider;
        message: string;
      }) => Promise<void>
    >(),
}));

vi.mock("@hot-potato/integrations", () => ({
  GoogleRepCalendarAdapter: class MockGoogleRepCalendarAdapter {
    constructor(private readonly getAccessToken: () => Promise<string>) {
      mocks.googleAdapterConstructed();
    }

    async listCalendars(input: { signal?: AbortSignal }) {
      await this.getAccessToken();
      return mocks.googleListCalendars(input);
    }
  },
  MicrosoftRepCalendarAdapter: class MockMicrosoftRepCalendarAdapter {
    constructor(private readonly getAccessToken: () => Promise<string>) {
      mocks.microsoftAdapterConstructed();
    }

    async listCalendars(input: { signal?: AbortSignal }) {
      await this.getAccessToken();
      return mocks.microsoftListCalendars(input);
    }
  },
}));

vi.mock("../app/connections", () => ({
  repCalendarManager: () => ({ accessToken: mocks.accessToken }),
}));

vi.mock("../app/repository", () => ({
  repository: {
    repCalendarSettings: mocks.repCalendarSettings,
    syncRepCalendarSources: mocks.syncRepCalendarSources,
    recordRepCalendarCatalogError: mocks.recordRepCalendarCatalogError,
  },
}));

import {
  repCalendarCatalogFailure,
  syncRepCalendarCatalog,
} from "../app/rep-calendar-catalog";

const catalogInput = {
  organizationSlug: "acme",
  repId: "8a90b1e8-f323-4f24-a19c-41b4a7766545",
} as const;

function settings(overrides: Partial<CatalogSettings> = {}): CatalogSettings {
  return {
    connected: true,
    accountName: "rep@example.com",
    checkConflicts: true,
    canSyncCalendars: true,
    calendarCatalogSyncedAt: null,
    calendarCatalogError: null,
    calendars: [],
    ...overrides,
  };
}

async function capturedFailure(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error("Expected catalog sync to reject.");
  } catch (error) {
    return repCalendarCatalogFailure(error);
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.accessToken.mockResolvedValue("rep-access-token");
  mocks.syncRepCalendarSources.mockResolvedValue();
  mocks.recordRepCalendarCatalogError.mockResolvedValue();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("representative calendar catalog sync", () => {
  it("persists the complete discovered catalog and returns redacted settings", async () => {
    const calendars = [
      { id: "default", name: "Main calendar", isDefault: true },
      { id: "sales-team", name: "Sales team", isDefault: false },
    ];
    const updated = settings({
      calendarCatalogSyncedAt: "2026-08-30T22:00:00.000Z",
      calendars: [
        {
          calendarId: "default",
          name: "Main calendar",
          isDefault: true,
          selected: true,
          available: true,
          lastSeenAt: "2026-08-30T22:00:00.000Z",
          missingSince: null,
        },
        {
          calendarId: "sales-team",
          name: "Sales team",
          isDefault: false,
          selected: false,
          available: true,
          lastSeenAt: "2026-08-30T22:00:00.000Z",
          missingSince: null,
        },
      ],
    });
    mocks.repCalendarSettings
      .mockResolvedValueOnce(settings())
      .mockResolvedValueOnce(updated);
    mocks.microsoftListCalendars.mockResolvedValue(calendars);

    const result = await syncRepCalendarCatalog({
      ...catalogInput,
      provider: "microsoft",
    });

    expect(mocks.microsoftAdapterConstructed).toHaveBeenCalledOnce();
    expect(mocks.googleAdapterConstructed).not.toHaveBeenCalled();
    expect(mocks.accessToken).toHaveBeenCalledWith(
      catalogInput.organizationSlug,
      catalogInput.repId,
      "microsoft",
    );
    expect(mocks.microsoftListCalendars).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
    });
    expect(mocks.syncRepCalendarSources).toHaveBeenCalledWith({
      ...catalogInput,
      provider: "microsoft",
      calendars,
    });
    expect(result).toEqual(updated);
    expect(result).not.toHaveProperty("accessToken");
    expect(result).not.toHaveProperty("refreshToken");
    expect(JSON.stringify(result)).not.toContain("rep-access-token");
    expect(mocks.recordRepCalendarCatalogError).not.toHaveBeenCalled();
  });

  it("requires Google reconnection before provider access when discovery scope is missing", async () => {
    mocks.repCalendarSettings.mockResolvedValue(
      settings({ canSyncCalendars: false }),
    );

    const failure = await capturedFailure(
      syncRepCalendarCatalog({ ...catalogInput, provider: "google" }),
    );

    expect(failure).toEqual({
      status: 409,
      body: {
        error: "Reconnect Google Calendar to choose additional calendars.",
        code: "reconnect_required",
        reconnectRequired: true,
      },
    });
    expect(mocks.googleAdapterConstructed).not.toHaveBeenCalled();
    expect(mocks.accessToken).not.toHaveBeenCalled();
    expect(mocks.googleListCalendars).not.toHaveBeenCalled();
    expect(mocks.syncRepCalendarSources).not.toHaveBeenCalled();
    expect(mocks.recordRepCalendarCatalogError).not.toHaveBeenCalled();
  });

  it("sanitizes provider rejection and records only the safe catalog error", async () => {
    mocks.repCalendarSettings.mockResolvedValue(settings());
    mocks.googleListCalendars.mockRejectedValue(
      new Error("provider response body: private tenant details"),
    );

    const failure = await capturedFailure(
      syncRepCalendarCatalog({ ...catalogInput, provider: "google" }),
    );

    expect(failure).toEqual({
      status: 502,
      body: {
        error: "Calendar list could not be refreshed. Try again.",
        code: "refresh_failed",
      },
    });
    expect(mocks.recordRepCalendarCatalogError).toHaveBeenCalledOnce();
    expect(mocks.recordRepCalendarCatalogError).toHaveBeenCalledWith({
      ...catalogInput,
      provider: "google",
      message: "Calendar refresh failed.",
    });
    expect(
      JSON.stringify(mocks.recordRepCalendarCatalogError.mock.calls),
    ).not.toContain("private tenant details");
    expect(mocks.syncRepCalendarSources).not.toHaveBeenCalled();
  });

  it("aborts provider discovery at the hard deadline and reports a safe timeout", async () => {
    vi.useFakeTimers();
    mocks.repCalendarSettings.mockResolvedValue(settings());
    let providerSignal: AbortSignal | undefined;
    mocks.googleListCalendars.mockImplementation((input) => {
      providerSignal = input.signal;
      return new Promise<ConnectedCalendar[]>(() => undefined);
    });

    const result = syncRepCalendarCatalog({
      ...catalogInput,
      provider: "google",
    });
    const rejection = capturedFailure(result);
    await vi.advanceTimersByTimeAsync(0);

    expect(providerSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(providerSignal?.aborted).toBe(false);
    expect(mocks.recordRepCalendarCatalogError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(rejection).resolves.toEqual({
      status: 504,
      body: {
        error: "Calendar refresh timed out. Try again.",
        code: "refresh_timeout",
      },
    });
    expect(providerSignal?.aborted).toBe(true);
    expect(mocks.recordRepCalendarCatalogError).toHaveBeenCalledWith({
      ...catalogInput,
      provider: "google",
      message: "Calendar refresh timed out.",
    });
    expect(mocks.syncRepCalendarSources).not.toHaveBeenCalled();
  });

  it("sanitizes repository catalog validation as a recorded 502", async () => {
    mocks.repCalendarSettings.mockResolvedValue(settings());
    mocks.googleListCalendars.mockResolvedValue([
      { id: "primary", name: "Primary", isDefault: true },
    ]);
    mocks.syncRepCalendarSources.mockRejectedValue(
      new Error(
        "Calendar discovery must return exactly one default calendar: private provider value.",
      ),
    );

    const failure = await capturedFailure(
      syncRepCalendarCatalog({ ...catalogInput, provider: "google" }),
    );

    expect(failure).toEqual({
      status: 502,
      body: {
        error: "Calendar list could not be refreshed. Try again.",
        code: "refresh_failed",
      },
    });
    expect(mocks.recordRepCalendarCatalogError).toHaveBeenCalledWith({
      ...catalogInput,
      provider: "google",
      message: "Calendar refresh failed.",
    });
    expect(
      JSON.stringify(mocks.recordRepCalendarCatalogError.mock.calls),
    ).not.toContain("private provider value");
  });
});
