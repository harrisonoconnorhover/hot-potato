export function requiredCalendarExternalAccountId(
  payload: Record<string, unknown>,
): string {
  const accountId = payload.calendarExternalAccountId;
  if (
    typeof accountId !== "string" ||
    accountId.length === 0 ||
    accountId.length > 1_024 ||
    /[\u0000-\u001f\u007f]/.test(accountId)
  ) {
    throw new Error(
      "This booking is not bound to a verified calendar account. Reconnect its original account before retrying provider work.",
    );
  }
  return accountId;
}

export function reconciliationNeedsFinalization(
  intent: unknown,
  endsAt: Date,
  now = new Date(),
): boolean {
  if (intent !== "resolve" && intent !== "close") {
    throw new Error("Calendar reconciliation intent is invalid.");
  }
  if (!Number.isFinite(endsAt.getTime()) || !Number.isFinite(now.getTime())) {
    throw new Error("Calendar reconciliation time is invalid.");
  }
  return intent === "resolve" && endsAt.getTime() > now.getTime();
}

function requiredJobTime(payload: Record<string, unknown>, field: string) {
  const value = payload[field];
  const date = new Date(typeof value === "string" ? value : "");
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Calendar job ${field} is invalid.`);
  }
  return date;
}

export function calendarMutationShouldRun(
  payload: Record<string, unknown>,
  now = new Date(),
): boolean {
  const startsAt = requiredJobTime(payload, "startsAt");
  const endsAt = requiredJobTime(payload, "endsAt");
  if (!Number.isFinite(now.getTime()) || endsAt <= startsAt) {
    throw new Error("Calendar job time range is invalid.");
  }
  return endsAt > now;
}

export function bookingEmailShouldSend(
  type: string,
  payload: Record<string, unknown>,
  now = new Date(),
): boolean {
  if (type === "email.booking.cancelled") return true;
  if (type === "email.booking.reminder") {
    return requiredJobTime(payload, "startsAt") > now;
  }
  return requiredJobTime(payload, "endsAt") > now;
}
