import type { ManagedBooking } from "@hot-potato/db";
import type { CalendarEventResult } from "@hot-potato/integrations";
import type { PublicSlotOption } from "../../../public-scheduling";

type FindOwnedEventAtRange = (range: {
  startsAt: Date;
  endsAt: Date;
}) => Promise<CalendarEventResult | null>;

export async function managedRescheduleSelection(
  booking: ManagedBooking,
  requestedStart: string,
  loadSlots: (booking: ManagedBooking) => Promise<PublicSlotOption[]>,
  findOwnedEventAtRange?: FindOwnedEventAtRange,
) {
  const exactFailedRetry =
    booking.status === "reschedule_pending" &&
    Boolean(booking.error) &&
    Date.parse(booking.startsAt) === Date.parse(requestedStart);
  if (exactFailedRetry) {
    if (
      !booking.externalEventId ||
      !booking.previousStartsAt ||
      !booking.previousEndsAt ||
      !findOwnedEventAtRange
    ) {
      return null;
    }
    const requestedRange = {
      startsAt: new Date(booking.startsAt),
      endsAt: new Date(booking.endsAt),
    };
    try {
      const requestedEvent = await findOwnedEventAtRange(requestedRange);
      if (requestedEvent) {
        return {
          slot: {
            startsAt: booking.startsAt,
            endsAt: booking.endsAt,
            candidateQuotes: [],
          },
          exactFailedRetry: true,
          providerEventAtRequested: true,
        };
      }
    } catch {
      // A provider can report the owned event as outside this range. Prove the
      // original range next; neither an error nor absence is accepted alone.
    }

    try {
      const originalEvent = await findOwnedEventAtRange({
        startsAt: new Date(booking.previousStartsAt),
        endsAt: new Date(booking.previousEndsAt),
      });
      if (!originalEvent) return null;
    } catch {
      return null;
    }
    const liveSlot = (await loadSlots(booking)).find(
      (slot) =>
        slot.startsAt === booking.startsAt && slot.endsAt === booking.endsAt,
    );
    if (!liveSlot) return null;
    return {
      slot: liveSlot,
      exactFailedRetry: true,
      providerEventAtRequested: false,
    };
  }
  const slot = (await loadSlots(booking)).find(
    (slot) => slot.startsAt === requestedStart,
  );
  return slot
    ? { slot, exactFailedRetry: false, providerEventAtRequested: undefined }
    : null;
}
