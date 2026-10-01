import {
  CalendarSlotUnavailableError,
  InviteeBookingLimitError,
  RouterLinkConflictError,
  RouterLinkNotFoundError,
  RouterLinkSessionExpiredError,
  RouterLinkValidationError,
  type PublicBookingStatus,
} from "@hot-potato/db";
import {
  PublicBodyError,
  publicBodyError,
  publicError,
  publicJson,
} from "../../public-api";

export function safeBookingStatus(booking: PublicBookingStatus) {
  return {
    status: booking.status,
    error:
      booking.status === "failed"
        ? "The calendar provider did not return a complete result. Retry or close this same booking safely."
        : booking.status === "confirmed" && booking.error
          ? "The requested calendar change could not be completed. The existing provider event remains active."
          : null,
    managePath: booking.managePath,
    conferenceUrl: booking.conferenceUrl,
    repName: booking.repName,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
  };
}

export function publicRouterError(error: unknown) {
  if (error instanceof PublicBodyError) return publicBodyError(error);
  if (error instanceof RouterLinkValidationError) {
    return publicError(422, error.message, "invalid_answers");
  }
  if (error instanceof CalendarSlotUnavailableError) {
    return publicError(409, error.message, "slot_unavailable");
  }
  if (error instanceof InviteeBookingLimitError) {
    return publicError(409, error.message, "booking_limit_reached");
  }
  if (error instanceof RouterLinkConflictError) {
    return publicError(409, error.message, "booking_conflict");
  }
  if (error instanceof RouterLinkSessionExpiredError) {
    return publicError(
      410,
      "This routing session has expired. Submit your details again.",
      "session_expired",
    );
  }
  if (error instanceof RouterLinkNotFoundError) {
    return publicError(404, "Smart Router Link not found.", "not_found");
  }

  console.error(
    "Public Smart Router request failed:",
    error instanceof Error ? error.name : "Unknown error",
  );
  return publicError(
    503,
    "The Smart Router is temporarily unavailable. Please try again.",
    "service_unavailable",
  );
}

export function bookingStatusResponse(booking: PublicBookingStatus) {
  const status =
    booking.status === "attempting" ||
    booking.status === "pending" ||
    booking.status === "cancel_pending"
      ? 202
      : 200;
  return publicJson(safeBookingStatus(booking), status);
}
