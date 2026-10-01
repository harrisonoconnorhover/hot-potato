import { describe, expect, it } from "vitest";
import {
  bookingEmailShouldSend,
  calendarMutationShouldRun,
  reconciliationNeedsFinalization,
  requiredCalendarExternalAccountId,
} from "../src/calendar-job";
import { bookingEmail } from "../src/booking-email";

describe("calendar job safety", () => {
  it("never finalizes a close reconciliation before cancellation", () => {
    expect(
      reconciliationNeedsFinalization(
        "close",
        new Date("2031-01-01T15:30:00.000Z"),
        new Date("2031-01-01T15:00:00.000Z"),
      ),
    ).toBe(false);
  });

  it("finalizes only future resolve events", () => {
    const now = new Date("2031-01-01T15:00:00.000Z");
    expect(
      reconciliationNeedsFinalization(
        "resolve",
        new Date("2031-01-01T15:30:00.000Z"),
        now,
      ),
    ).toBe(true);
    expect(
      reconciliationNeedsFinalization(
        "resolve",
        new Date("2031-01-01T14:30:00.000Z"),
        now,
      ),
    ).toBe(false);
  });

  it("requires the exact provider account identity", () => {
    expect(
      requiredCalendarExternalAccountId({
        calendarExternalAccountId: " account-A ",
      }),
    ).toBe(" account-A ");
    expect(() => requiredCalendarExternalAccountId({})).toThrow(
      "not bound to a verified calendar account",
    );
  });

  it("never mutates a calendar after the requested meeting has ended", () => {
    const payload = {
      startsAt: "2031-01-01T15:00:00.000Z",
      endsAt: "2031-01-01T15:30:00.000Z",
    };
    expect(
      calendarMutationShouldRun(payload, new Date("2031-01-01T15:29:59.999Z")),
    ).toBe(true);
    expect(
      calendarMutationShouldRun(payload, new Date("2031-01-01T15:30:00.000Z")),
    ).toBe(false);
  });

  it("skips stale lifecycle mail while still allowing cancellation mail", () => {
    const payload = {
      startsAt: "2031-01-01T15:00:00.000Z",
      endsAt: "2031-01-01T15:30:00.000Z",
    };
    const afterMeeting = new Date("2031-01-01T15:31:00.000Z");
    expect(
      bookingEmailShouldSend(
        "email.booking.confirmation",
        payload,
        afterMeeting,
      ),
    ).toBe(false);
    expect(
      bookingEmailShouldSend(
        "email.booking.rescheduled",
        payload,
        afterMeeting,
      ),
    ).toBe(false);
    expect(
      bookingEmailShouldSend(
        "email.booking.reminder",
        payload,
        new Date("2031-01-01T15:00:00.000Z"),
      ),
    ).toBe(false);
    expect(
      bookingEmailShouldSend("email.booking.cancelled", payload, afterMeeting),
    ).toBe(true);
  });
});

describe("booking email management links", () => {
  const baseJob = {
    id: 1,
    type: "email.booking.confirmation",
    attempts: 1,
    claimToken: "11111111-1111-4111-8111-111111111111",
    payload: {
      to: "taylor@example.com",
      meetingTitle: "Discovery call",
      repName: "Alex Rep",
      attendeeName: "Taylor",
      organizationName: "Acme",
      timezone: "UTC",
      startsAt: "2031-01-01T15:00:00.000Z",
      conferenceUrl: null,
    },
  };

  it("omits management copy when no verified manage path exists", () => {
    const message = bookingEmail(baseJob);
    expect(message.text).not.toContain("Manage:");
    expect(message.html).not.toContain("Reschedule or cancel");
    expect(message.text).not.toContain("undefined");
    expect(message.text).not.toContain("null");
  });

  it("includes only a UUID management capability path", () => {
    const validPath = "/schedule/manage/22222222-2222-4222-8222-222222222222";
    const valid = bookingEmail({
      ...baseJob,
      payload: { ...baseJob.payload, managePath: validPath },
    });
    expect(valid.text).toContain(`Manage: http://localhost:3000${validPath}`);

    const invalid = bookingEmail({
      ...baseJob,
      payload: { ...baseJob.payload, managePath: "/schedule/manage/order-1" },
    });
    expect(invalid.text).not.toContain("Manage:");
  });
});
