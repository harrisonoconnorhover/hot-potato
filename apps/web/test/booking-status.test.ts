import { describe, expect, it } from "vitest";
import {
  bookingPollMayReopenAvailability,
  bookingStatusIsDurable,
  bookingStatusIsProcessing,
  slotFromBookingStatus,
} from "../components/booking-status";

describe("booking status UI helpers", () => {
  it.each([
    "attempting",
    "pending",
    "reschedule_pending",
    "cancel_pending",
  ] as const)("keeps %s locked and polling", (status) => {
    expect(bookingStatusIsProcessing(status)).toBe(true);
  });

  it.each(["confirmed", "cancelled", "failed"] as const)(
    "treats %s as terminal",
    (status) => {
      expect(bookingStatusIsProcessing(status)).toBe(false);
    },
  );

  it("distinguishes an ephemeral attempt lease from a durable booking", () => {
    expect(bookingStatusIsDurable("attempting")).toBe(false);
    expect(bookingStatusIsDurable("pending")).toBe(true);
    expect(bookingStatusIsDurable("failed")).toBe(true);
    expect(bookingStatusIsDurable(undefined)).toBe(false);
  });

  it("accepts only a valid authoritative server range", () => {
    expect(
      slotFromBookingStatus({
        startsAt: "2031-01-01T15:00:00.000Z",
        endsAt: "2031-01-01T15:30:00.000Z",
      }),
    ).toEqual({
      startsAt: "2031-01-01T15:00:00.000Z",
      endsAt: "2031-01-01T15:30:00.000Z",
    });
    expect(
      slotFromBookingStatus({
        startsAt: "2031-01-01T15:30:00.000Z",
        endsAt: "2031-01-01T15:00:00.000Z",
      }),
    ).toBeNull();
    expect(slotFromBookingStatus({})).toBeNull();
  });

  it("reopens after attempting followed only by not-found responses", () => {
    const durableStatusObserved = bookingStatusIsDurable("attempting");
    expect(bookingPollMayReopenAvailability(true, durableStatusObserved)).toBe(
      true,
    );
  });

  it("stays locked after attempting, then pending, then not-found", () => {
    let durableStatusObserved = bookingStatusIsDurable("attempting");
    durableStatusObserved ||= bookingStatusIsDurable("pending");
    expect(bookingPollMayReopenAvailability(true, durableStatusObserved)).toBe(
      false,
    );
    expect(bookingPollMayReopenAvailability(false, true)).toBe(false);
  });
});
