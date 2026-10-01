import { describe, expect, it } from "vitest";
import {
  additionalAttendeeEmailsInput,
  withoutPrimaryAttendee,
} from "../app/booking-guests";

describe("additional booking guests", () => {
  it("keeps old clients compatible and canonicalizes duplicate addresses", () => {
    expect(additionalAttendeeEmailsInput.parse(undefined)).toEqual([]);
    expect(
      additionalAttendeeEmailsInput.parse([
        " Guest@Example.com ",
        "guest@example.com",
        "observer@example.com",
      ]),
    ).toEqual(["guest@example.com", "observer@example.com"]);
  });

  it("removes the primary booker and rejects invalid or oversized lists", () => {
    expect(
      withoutPrimaryAttendee("BUYER@example.com", [
        "buyer@example.com",
        "guest@example.com",
      ]),
    ).toEqual(["guest@example.com"]);
    expect(() =>
      additionalAttendeeEmailsInput.parse(["not-an-email"]),
    ).toThrow();
    expect(() =>
      additionalAttendeeEmailsInput.parse(
        Array.from({ length: 6 }, (_, index) => `guest-${index}@example.com`),
      ),
    ).toThrow("Invite no more than 5 additional guests.");
  });
});
