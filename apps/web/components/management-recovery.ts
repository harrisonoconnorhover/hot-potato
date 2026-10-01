import type { ManagedBookingView } from "../app/managed-booking";
import { fetchBookingJson } from "./booking-fetch";

export type ManagementChange = {
  action:
    | "cancel"
    | "reschedule"
    | "retry_failed_router"
    | "close_failed_router";
  token: string;
  startsAt?: string;
};

export function managementRejectionMayUnlock(
  result: { accepted: boolean; uncertain: boolean },
  previouslyUncertain: boolean,
) {
  return !result.accepted && !result.uncertain && !previouslyUncertain;
}

export function managementChangeObserved(
  change: ManagementChange,
  booking: ManagedBookingView,
): boolean {
  if (change.action === "cancel" || change.action === "close_failed_router") {
    return (
      booking.status === "cancel_pending" || booking.status === "cancelled"
    );
  }
  if (change.action === "reschedule") {
    return (
      booking.startsAt === change.startsAt &&
      (booking.status === "reschedule_pending" ||
        booking.status === "confirmed")
    );
  }
  return booking.status !== "failed";
}

export async function submitManagementChange(
  change: ManagementChange,
  send: typeof fetch = fetch,
): Promise<{ accepted: boolean; uncertain: boolean; error: string | null }> {
  try {
    const response = await fetchBookingJson<{ error?: string }>(
      "/api/scheduling/manage",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(change),
      },
      send,
    );
    if (response.ok) return { accepted: true, uncertain: false, error: null };
    return {
      accepted: false,
      uncertain: response.status >= 500,
      error: response.body.error ?? "The booking could not be changed.",
    };
  } catch {
    return {
      accepted: false,
      uncertain: true,
      error:
        "We lost contact while changing your meeting. Check its status or retry the same change safely.",
    };
  }
}
