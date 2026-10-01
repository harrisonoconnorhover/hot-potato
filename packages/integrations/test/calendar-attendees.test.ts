import { describe, expect, it } from "vitest";
import { calendarEventAttendees } from "../src/types.js";

describe("calendar event attendees", () => {
  it("includes co-hosts once across buyer and team attendee lists", () => {
    expect(
      calendarEventAttendees({
        subject: "Discovery",
        startsAt: new Date("2031-01-01T15:00:00.000Z"),
        endsAt: new Date("2031-01-01T15:30:00.000Z"),
        attendeeEmail: "buyer@example.com",
        attendeeName: "Buyer",
        additionalAttendeeEmails: ["guest@example.com", "TEAM@example.com"],
        cohostEmails: ["team@example.com", "solutions@example.com"],
        transactionId: "booking-1",
      }),
    ).toEqual([
      { email: "buyer@example.com", name: "Buyer" },
      { email: "guest@example.com" },
      { email: "team@example.com" },
      { email: "solutions@example.com" },
    ]);
  });
});
