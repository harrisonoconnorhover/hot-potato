import type { CalendarOAuthProvider } from "@hot-potato/db";
import {
  GoogleRepCalendarAdapter,
  MicrosoftRepCalendarAdapter,
  type ConnectedCalendar,
} from "@hot-potato/integrations";
import { repCalendarManager } from "./connections";
import { repository } from "./repository";

const catalogDeadlineMs = 10_000;

export type RepCalendarCatalogFailureCode =
  | "not_found"
  | "reconnect_required"
  | "refresh_timeout"
  | "refresh_failed";

export class RepCalendarCatalogError extends Error {
  constructor(
    readonly code: RepCalendarCatalogFailureCode,
    readonly status: 404 | 409 | 502 | 504,
    message: string,
  ) {
    super(message);
    this.name = "RepCalendarCatalogError";
  }
}

class CalendarCatalogDeadlineError extends Error {}

function catalogNotFound(): RepCalendarCatalogError {
  return new RepCalendarCatalogError(
    "not_found",
    404,
    "Calendar connection not found.",
  );
}

function calendarAdapter(
  organizationSlug: string,
  repId: string,
  provider: CalendarOAuthProvider,
) {
  const getAccessToken = () =>
    repCalendarManager().accessToken(organizationSlug, repId, provider);
  return provider === "google"
    ? new GoogleRepCalendarAdapter(getAccessToken)
    : new MicrosoftRepCalendarAdapter(getAccessToken);
}

async function discoveredCalendars(input: {
  organizationSlug: string;
  repId: string;
  provider: CalendarOAuthProvider;
}) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new CalendarCatalogDeadlineError());
    }, catalogDeadlineMs);
  });
  try {
    return await Promise.race([
      calendarAdapter(
        input.organizationSlug,
        input.repId,
        input.provider,
      ).listCalendars({ signal: controller.signal }),
      deadline,
    ]);
  } catch (error) {
    if (timedOut) throw new CalendarCatalogDeadlineError();
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function recordSafeCatalogError(
  input: {
    organizationSlug: string;
    repId: string;
    provider: CalendarOAuthProvider;
  },
  message: string,
): Promise<void> {
  try {
    await repository.recordRepCalendarCatalogError({ ...input, message });
  } catch {
    console.error("Calendar catalog failure status could not be recorded.");
  }
}

export function repCalendarCatalogFailure(error: unknown): {
  status: 404 | 409 | 502 | 504;
  body: {
    error: string;
    code: RepCalendarCatalogFailureCode;
    reconnectRequired?: true;
  };
} | null {
  if (!(error instanceof RepCalendarCatalogError)) return null;
  return {
    status: error.status,
    body: {
      error: error.message,
      code: error.code,
      ...(error.code === "reconnect_required"
        ? { reconnectRequired: true as const }
        : {}),
    },
  };
}

export async function repCalendarCatalogSettings(input: {
  organizationSlug: string;
  repId: string;
  provider: CalendarOAuthProvider;
}) {
  const settings = await repository.repCalendarSettings(
    input.organizationSlug,
    input.repId,
    input.provider,
  );
  if (!settings) throw catalogNotFound();
  return settings;
}

export async function syncRepCalendarCatalog(input: {
  organizationSlug: string;
  repId: string;
  provider: CalendarOAuthProvider;
}) {
  const current = await repCalendarCatalogSettings(input);
  if (input.provider === "google" && !current.canSyncCalendars) {
    throw new RepCalendarCatalogError(
      "reconnect_required",
      409,
      "Reconnect Google Calendar to choose additional calendars.",
    );
  }

  let calendars: ConnectedCalendar[];
  try {
    calendars = await discoveredCalendars(input);
  } catch (error) {
    if (error instanceof CalendarCatalogDeadlineError) {
      await recordSafeCatalogError(input, "Calendar refresh timed out.");
      throw new RepCalendarCatalogError(
        "refresh_timeout",
        504,
        "Calendar refresh timed out. Try again.",
      );
    }
    await recordSafeCatalogError(input, "Calendar refresh failed.");
    throw new RepCalendarCatalogError(
      "refresh_failed",
      502,
      "Calendar list could not be refreshed. Try again.",
    );
  }

  try {
    await repository.syncRepCalendarSources({ ...input, calendars });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.toLowerCase().includes("not found")) throw catalogNotFound();
    await recordSafeCatalogError(input, "Calendar refresh failed.");
    throw new RepCalendarCatalogError(
      "refresh_failed",
      502,
      "Calendar list could not be refreshed. Try again.",
    );
  }
  return repCalendarCatalogSettings(input);
}
