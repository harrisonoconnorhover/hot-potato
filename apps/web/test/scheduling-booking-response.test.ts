import type { PublicBookingStatus } from "@hot-potato/db";
import { describe, expect, it } from "vitest";
import { safeSchedulingBookingStatus } from "../app/api/scheduling/bookings/response";

const booking: PublicBookingStatus = {
  status: "confirmed",
  error: null,
  managePath: "/schedule/manage/booking-token",
  conferenceUrl: "https://meet.example.com/room",
  repName: "Avery Rivera",
  startsAt: "2031-01-01T15:00:00.000Z",
  endsAt: "2031-01-01T15:30:00.000Z",
};

describe("public scheduling booking responses", () => {
  it("returns the authoritative booking range", () => {
    expect(safeSchedulingBookingStatus(booking)).toMatchObject({
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      managePath: booking.managePath,
    });
  });

  it("never exposes a raw calendar-provider error", () => {
    const response = safeSchedulingBookingStatus({
      ...booking,
      status: "failed",
      error: "oauth token=secret-provider-detail",
    });

    expect(response.error).toContain("Open the manage link");
    expect(response.error).not.toContain("secret-provider-detail");
  });
});
