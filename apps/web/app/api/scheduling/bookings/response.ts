import type { PublicBookingStatus } from "@hot-potato/db";

export function safeSchedulingBookingStatus(booking: PublicBookingStatus) {
  return {
    status: booking.status,
    error:
      booking.status === "failed"
        ? "The calendar provider result could not be safely confirmed. Open the manage link to verify or recover this booking."
        : null,
    managePath: booking.managePath,
    conferenceUrl: booking.conferenceUrl,
    repName: booking.repName,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
  };
}
