import type {
  BookingLifecycleStatus,
  PublicBookingStatus,
} from "@hot-potato/db";

export type AuthoritativeBookingSlot = Pick<
  PublicBookingStatus,
  "startsAt" | "endsAt"
>;

const processingStatuses = new Set<BookingLifecycleStatus>([
  "attempting",
  "pending",
  "reschedule_pending",
  "cancel_pending",
]);

export function bookingStatusIsProcessing(
  status: BookingLifecycleStatus | undefined,
) {
  return Boolean(status && processingStatuses.has(status));
}

export function bookingStatusIsDurable(
  status: BookingLifecycleStatus | undefined,
) {
  return Boolean(status && status !== "attempting");
}

export function bookingPollMayReopenAvailability(
  sawNotFound: boolean,
  durableStatusObserved: boolean,
) {
  return sawNotFound && !durableStatusObserved;
}

export function slotFromBookingStatus(
  value: Partial<AuthoritativeBookingSlot>,
): AuthoritativeBookingSlot | null {
  if (typeof value.startsAt !== "string" || typeof value.endsAt !== "string") {
    return null;
  }
  const startsAt = Date.parse(value.startsAt);
  const endsAt = Date.parse(value.endsAt);
  return Number.isFinite(startsAt) &&
    Number.isFinite(endsAt) &&
    endsAt > startsAt
    ? { startsAt: value.startsAt, endsAt: value.endsAt }
    : null;
}
