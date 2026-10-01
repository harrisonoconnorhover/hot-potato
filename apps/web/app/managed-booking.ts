import type { ManagedBooking } from "@hot-potato/db";
import { findOwnedRepCalendarEvent } from "./rep-calendar-availability";
import { repository } from "./repository";

const legacyAccountMessage =
  "Reconnect the original Google or Outlook account so this meeting can be verified before it is changed.";

function withLegacyAccountError(booking: ManagedBooking): ManagedBooking {
  return { ...booking, error: legacyAccountMessage };
}

export type ManagedBookingView = Omit<
  ManagedBooking,
  | "calendarExternalAccountId"
  | "transactionId"
  | "externalEventId"
  | "previousStartsAt"
  | "previousEndsAt"
  | "rescheduleSchedule"
>;

export function managedBookingView(
  booking: ManagedBooking,
): ManagedBookingView {
  const {
    calendarExternalAccountId: _calendarExternalAccountId,
    transactionId: _transactionId,
    externalEventId: _externalEventId,
    previousStartsAt: _previousStartsAt,
    previousEndsAt: _previousEndsAt,
    rescheduleSchedule: _rescheduleSchedule,
    ...view
  } = booking;
  return view;
}

export async function managedBookingWithVerifiedCalendar(
  manageToken: string,
): Promise<ManagedBooking | null> {
  let booking = await repository.managedBooking(manageToken);
  if (
    !booking ||
    booking.calendarExternalAccountId ||
    (booking.status !== "confirmed" && booking.status !== "failed")
  ) {
    return booking;
  }
  const unverifiedBooking = booking;

  const context =
    await repository.legacyBookingCalendarAccountRepairContext(manageToken);
  if (!context?.currentCalendarExternalAccountId) {
    return withLegacyAccountError(unverifiedBooking);
  }

  try {
    const event = await findOwnedRepCalendarEvent({
      organizationSlug: context.organizationSlug,
      repId: context.repId,
      provider: context.calendarProvider,
      calendarExternalAccountId: context.currentCalendarExternalAccountId,
      transactionId: context.transactionId,
      externalEventId: context.externalEventId,
      startsAt: new Date(context.startsAt),
      endsAt: new Date(context.endsAt),
    });
    if (!event) return withLegacyAccountError(unverifiedBooking);

    await repository.bindLegacyBookingCalendarAccount(manageToken, {
      calendarExternalAccountId: context.currentCalendarExternalAccountId,
      externalEventId: event.externalEventId,
      startsAt: new Date(context.startsAt),
      endsAt: new Date(context.endsAt),
    });
    booking = await repository.managedBooking(manageToken);
    return booking ?? null;
  } catch (error) {
    console.error(
      "Legacy booking calendar-account verification failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return withLegacyAccountError(unverifiedBooking);
  }
}

export function unverifiedManagedBookingError(
  booking: ManagedBooking,
): string | null {
  return booking.calendarExternalAccountId ? null : legacyAccountMessage;
}
