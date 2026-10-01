import { InviteeBookingLimitError } from "@hot-potato/db";
import { describe, expect, it } from "vitest";
import { bookingChangeIsOpen } from "../app/booking-change-policy";
import { publicRouterError } from "../app/api/router-links/responses";
import { handoffError } from "../app/handoff-api";

describe("booking policy", () => {
  it("keeps no-deadline policies open and closes exactly at the deadline", () => {
    const deadline = "2031-01-01T15:00:00.000Z";
    const boundary = new Date(deadline).getTime();

    expect(bookingChangeIsOpen(null, Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(bookingChangeIsOpen(deadline, boundary - 1)).toBe(true);
    expect(bookingChangeIsOpen(deadline, boundary)).toBe(false);
    expect(bookingChangeIsOpen("not-a-date", 0)).toBe(false);
  });

  it("returns a stable buyer-facing conflict from Smart Router and Handoff", async () => {
    const error = new InviteeBookingLimitError("domain");
    const routerResponse = publicRouterError(error);
    const handoffResponse = handoffError(error, "booking");

    expect(routerResponse.status).toBe(409);
    expect(await routerResponse.json()).toMatchObject({
      code: "booking_limit_reached",
      error: expect.stringContaining("email domain"),
    });
    expect(handoffResponse.status).toBe(409);
    expect(await handoffResponse.json()).toMatchObject({
      code: "booking_limit_reached",
    });
  });
});
