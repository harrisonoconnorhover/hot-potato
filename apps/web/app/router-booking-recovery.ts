import {
  RouterLinkConflictError,
  type LegacyBookingCalendarAccountProof,
  type ReconciledCalendarEvent,
  type RouterLinkBookingRetryContext,
} from "@hot-potato/db";

export async function verifiedFailedRouterProviderEvent(
  context: RouterLinkBookingRetryContext,
  dependencies: {
    findOwnedCalendarEvent: (
      context: RouterLinkBookingRetryContext,
    ) => Promise<ReconciledCalendarEvent | null>;
    bindLegacyBookingCalendarAccount: (
      manageToken: string,
      proof: LegacyBookingCalendarAccountProof,
    ) => Promise<boolean>;
  },
): Promise<ReconciledCalendarEvent | null> {
  if (context.status !== "failed") return null;
  const wasAlreadyBound = Boolean(context.calendarExternalAccountId);
  const calendarExternalAccountId =
    context.calendarExternalAccountId ??
    context.currentCalendarExternalAccountId;
  if (!calendarExternalAccountId) {
    throw new RouterLinkConflictError(
      "Reconnect the original Google or Outlook account before recovering this booking.",
    );
  }

  const lookupContext = { ...context, calendarExternalAccountId };
  const event = await dependencies.findOwnedCalendarEvent(lookupContext);
  if (!event) {
    if (wasAlreadyBound) return null;
    throw new RouterLinkConflictError(
      "The connected account does not positively prove ownership of this legacy booking. Reconnect the original account before recovering it.",
    );
  }

  if (!wasAlreadyBound || !context.externalEventId) {
    const bound = await dependencies.bindLegacyBookingCalendarAccount(
      context.transactionId,
      {
        calendarExternalAccountId,
        externalEventId: event.externalEventId,
        startsAt: new Date(context.startsAt),
        endsAt: new Date(context.endsAt),
      },
    );
    if (!bound) {
      throw new RouterLinkConflictError(
        "This booking changed before its calendar account could be verified.",
      );
    }
  }
  return event;
}
