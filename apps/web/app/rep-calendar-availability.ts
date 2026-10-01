import type {
  CalendarConflictSource,
  CalendarOAuthProvider,
} from "@hot-potato/db";
import {
  GoogleRepCalendarAdapter,
  MicrosoftRepCalendarAdapter,
  type CalendarEventResult,
} from "@hot-potato/integrations";
import { repCalendarManager } from "./connections";

export type BusyInterval = { startsAt: Date; endsAt: Date };

const calendarCheckTimeoutMs = 10_000;

async function withTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs = calendarCheckTimeoutMs,
  timeoutMessage = "Calendar availability timed out.",
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    return await Promise.race([
      task(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error(timeoutMessage));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function findOwnedRepCalendarEvent(input: {
  organizationSlug: string;
  repId: string;
  provider: CalendarOAuthProvider;
  calendarExternalAccountId: string | null;
  transactionId: string;
  externalEventId?: string | null;
  startsAt: Date;
  endsAt: Date;
  timeoutMs?: number;
}): Promise<CalendarEventResult | null> {
  if (
    typeof input.calendarExternalAccountId !== "string" ||
    input.calendarExternalAccountId.length === 0 ||
    input.calendarExternalAccountId.length > 1_024 ||
    /[\u0000-\u001f\u007f]/.test(input.calendarExternalAccountId)
  ) {
    throw new Error(
      "This booking is not bound to a verified calendar account. Reconnect its original account before retrying provider work.",
    );
  }
  const calendarExternalAccountId = input.calendarExternalAccountId;
  const timeoutMs = Math.max(
    1,
    Math.min(input.timeoutMs ?? calendarCheckTimeoutMs, calendarCheckTimeoutMs),
  );
  const event = await withTimeout(
    (signal) =>
      adapter(
        input.organizationSlug,
        input.repId,
        input.provider,
        calendarExternalAccountId,
      ).findEventByTransactionId({
        transactionId: input.transactionId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        signal,
      }),
    timeoutMs,
    "Calendar event reconciliation timed out.",
  );
  if (
    event &&
    input.externalEventId &&
    event.externalEventId !== input.externalEventId
  ) {
    throw new Error(
      "The connected calendar returned conflicting booking event evidence.",
    );
  }
  return event;
}

function adapter(
  organizationSlug: string,
  repId: string,
  provider: CalendarOAuthProvider,
  expectedExternalAccountId?: string,
) {
  const getAccessToken = () =>
    repCalendarManager().accessToken(
      organizationSlug,
      repId,
      provider,
      expectedExternalAccountId,
    );
  return provider === "google"
    ? new GoogleRepCalendarAdapter(getAccessToken)
    : new MicrosoftRepCalendarAdapter(getAccessToken);
}

export function calendarSource(
  calendars: CalendarConflictSource[],
): "google_calendar" | "microsoft_calendar" | "connected_calendars" {
  const unique = [...new Set(calendars.map((calendar) => calendar.provider))];
  if (unique.length > 1) return "connected_calendars";
  return unique[0] === "microsoft" ? "microsoft_calendar" : "google_calendar";
}

export async function combinedRepBusyIntervals(input: {
  organizationSlug: string;
  repId: string;
  calendars: CalendarConflictSource[];
  startsAt: Date;
  endsAt: Date;
  timeoutMs?: number;
}): Promise<BusyInterval[]> {
  if (input.calendars.some((calendar) => !calendar.available)) {
    throw new Error(
      "A selected conflict calendar is no longer available. Refresh the calendar list.",
    );
  }
  const grouped = new Map<
    CalendarOAuthProvider,
    { calendarExternalAccountId: string; calendarIds: Set<string> }
  >();
  for (const calendar of input.calendars) {
    if (
      typeof calendar.calendarExternalAccountId !== "string" ||
      calendar.calendarExternalAccountId.length === 0 ||
      calendar.calendarExternalAccountId.length > 1_024 ||
      /[\u0000-\u001f\u007f]/.test(calendar.calendarExternalAccountId)
    ) {
      throw new Error(
        "A selected conflict calendar has no verified account identity.",
      );
    }
    const existing = grouped.get(calendar.provider);
    if (
      existing &&
      existing.calendarExternalAccountId !== calendar.calendarExternalAccountId
    ) {
      throw new Error(
        "Selected conflict calendars disagree about their connected account.",
      );
    }
    const group = existing ?? {
      calendarExternalAccountId: calendar.calendarExternalAccountId,
      calendarIds: new Set<string>(),
    };
    group.calendarIds.add(calendar.calendarId);
    grouped.set(calendar.provider, group);
  }
  const providers = [...grouped.keys()].sort();
  if (providers.length === 0) {
    throw new Error("The representative has no conflict calendar selected.");
  }
  const timeoutMs = Math.max(
    1,
    Math.min(input.timeoutMs ?? calendarCheckTimeoutMs, calendarCheckTimeoutMs),
  );

  const intervals = await Promise.all(
    providers.map((provider) =>
      withTimeout(
        (signal) =>
          adapter(
            input.organizationSlug,
            input.repId,
            provider,
            grouped.get(provider)!.calendarExternalAccountId,
          ).busyIntervals({
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            calendarIds: [...grouped.get(provider)!.calendarIds],
            signal,
          }),
        timeoutMs,
      ),
    ),
  );
  return intervals
    .flat()
    .filter(
      (interval) =>
        interval.startsAt < input.endsAt && interval.endsAt > input.startsAt,
    )
    .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
}
