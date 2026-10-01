import { describe, expect, it } from "vitest";
import {
  includesSchedulingSlot,
  schedulingSlots,
  withoutBusyIntervals,
  type Rep,
} from "../src/index.js";

const weekdayAvailability = {
  monday: [{ start: "09:00", end: "17:00" }],
  tuesday: [{ start: "09:00", end: "17:00" }],
  wednesday: [{ start: "09:00", end: "17:00" }],
  thursday: [{ start: "09:00", end: "17:00" }],
  friday: [{ start: "09:00", end: "17:00" }],
};

const rep: Rep = {
  id: "rep-1",
  name: "Ada Chen",
  email: "ada@example.com",
  timezone: "America/New_York",
  weight: 1,
  active: true,
  availability: weekdayAvailability,
};

describe("public scheduling slots", () => {
  it("honors notice, working hours, duration, and the rep timezone", () => {
    const slots = schedulingSlots({
      rep,
      now: new Date("2026-08-24T12:00:00.000Z"),
      durationMinutes: 30,
      minNoticeMinutes: 60,
      windowDays: 1,
    });

    expect(slots[0]).toEqual({
      startsAt: new Date("2026-08-24T13:00:00.000Z"),
      endsAt: new Date("2026-08-24T13:30:00.000Z"),
    });
    expect(slots.at(-1)?.startsAt).toEqual(
      new Date("2026-08-24T20:30:00.000Z"),
    );
  });

  it("aligns slots to local half hours in quarter-hour timezones", () => {
    const kathmanduRep: Rep = {
      ...rep,
      timezone: "Asia/Kathmandu",
      availability: { monday: [{ start: "09:00", end: "10:00" }] },
    };
    const slots = schedulingSlots({
      rep: kathmanduRep,
      now: new Date("2026-08-24T02:00:00.000Z"),
      durationMinutes: 30,
      minNoticeMinutes: 0,
      windowDays: 1,
    });

    expect(slots.map((slot) => slot.startsAt.toISOString())).toEqual([
      "2026-08-24T03:15:00.000Z",
      "2026-08-24T03:45:00.000Z",
    ]);
  });

  it("keeps every meeting inside one continuous working period", () => {
    const splitDayRep: Rep = {
      ...rep,
      availability: {
        monday: [
          { start: "09:00", end: "12:00" },
          { start: "13:00", end: "17:00" },
        ],
      },
    };
    const slots = schedulingSlots({
      rep: splitDayRep,
      now: new Date("2026-08-24T12:00:00.000Z"),
      durationMinutes: 90,
      minNoticeMinutes: 0,
      windowDays: 1,
    });
    const starts = slots.map((slot) => slot.startsAt.toISOString());

    expect(starts).toContain("2026-08-24T13:00:00.000Z");
    expect(starts).not.toContain("2026-08-24T15:30:00.000Z");
    expect(starts).toContain("2026-08-24T17:00:00.000Z");
  });

  it("uses date overrides before the normal weekday schedule", () => {
    const overriddenRep: Rep = {
      ...rep,
      availabilityOverrides: {
        "2026-08-24": [],
        "2026-08-25": [
          { start: "11:00", end: "12:00" },
          { start: "14:00", end: "15:00" },
        ],
      },
    };
    const slots = schedulingSlots({
      rep: overriddenRep,
      now: new Date("2026-08-24T12:00:00.000Z"),
      durationMinutes: 30,
      minNoticeMinutes: 0,
      windowDays: 2,
    });

    expect(
      slots.some(
        (slot) =>
          slot.startsAt >= new Date("2026-08-24T12:00:00.000Z") &&
          slot.startsAt < new Date("2026-08-25T04:00:00.000Z"),
      ),
    ).toBe(false);
    expect(slots.map((slot) => slot.startsAt.toISOString())).toEqual([
      "2026-08-25T15:00:00.000Z",
      "2026-08-25T15:30:00.000Z",
      "2026-08-25T18:00:00.000Z",
      "2026-08-25T18:30:00.000Z",
    ]);
  });

  it("removes overlaps and recognizes an exact offered slot", () => {
    const slots = schedulingSlots({
      rep,
      now: new Date("2026-08-24T12:00:00.000Z"),
      durationMinutes: 30,
      minNoticeMinutes: 60,
      windowDays: 1,
    });
    const available = withoutBusyIntervals(slots, [
      {
        startsAt: new Date("2026-08-24T13:30:00.000Z"),
        endsAt: new Date("2026-08-24T14:15:00.000Z"),
      },
    ]);

    expect(available.map((slot) => slot.startsAt.toISOString())).not.toContain(
      "2026-08-24T13:30:00.000Z",
    );
    expect(available.map((slot) => slot.startsAt.toISOString())).not.toContain(
      "2026-08-24T14:00:00.000Z",
    );
    expect(
      includesSchedulingSlot(available, new Date("2026-08-24T14:30:00.000Z")),
    ).toBe(true);
  });
});
