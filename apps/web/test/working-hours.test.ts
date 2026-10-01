import { describe, expect, it } from "vitest";
import {
  availabilityOverridesSchema,
  availabilityScheduleInputSchema,
  weeklyAvailabilitySchema,
  workingHoursSettingsSchema,
} from "../app/working-hours";

describe("working-hours validation", () => {
  it("normalizes multiple periods, removes empty days, and sorts by start", () => {
    const result = workingHoursSettingsSchema.parse({
      timezone: " America/New_York ",
      availability: {
        monday: [
          { start: "13:00", end: "17:00" },
          { start: "09:00", end: "12:00" },
        ],
        tuesday: [],
      },
    });

    expect(result).toEqual({
      timezone: "America/New_York",
      availability: {
        monday: [
          { start: "09:00", end: "12:00" },
          { start: "13:00", end: "17:00" },
        ],
      },
    });
  });

  it("accepts adjacent periods but rejects overlapping periods", () => {
    expect(
      weeklyAvailabilitySchema.safeParse({
        monday: [
          { start: "09:00", end: "12:00" },
          { start: "12:00", end: "17:00" },
        ],
      }).success,
    ).toBe(true);

    const overlap = weeklyAvailabilitySchema.safeParse({
      monday: [
        { start: "13:00", end: "17:00" },
        { start: "09:00", end: "14:00" },
      ],
    });
    expect(overlap.success).toBe(false);
    if (!overlap.success) {
      expect(overlap.error.issues[0]?.message).toBe(
        "Working periods on the same day cannot overlap.",
      );
    }
  });

  it("normalizes date overrides and keeps an empty day unavailable", () => {
    expect(
      availabilityOverridesSchema.parse({
        "2026-09-08": [
          { start: "14:00", end: "17:00" },
          { start: "09:00", end: "12:00" },
        ],
        "2026-09-07": [],
      }),
    ).toEqual({
      "2026-09-07": [],
      "2026-09-08": [
        { start: "09:00", end: "12:00" },
        { start: "14:00", end: "17:00" },
      ],
    });
  });

  it("rejects invalid dates, overlap, excess dates, and unknown range fields", () => {
    expect(
      availabilityOverridesSchema.safeParse({ "2026-02-30": [] }).success,
    ).toBe(false);
    expect(
      availabilityOverridesSchema.safeParse({
        "2026-09-08": [
          { start: "09:00", end: "14:00" },
          { start: "13:00", end: "17:00" },
        ],
      }).success,
    ).toBe(false);
    expect(
      availabilityOverridesSchema.safeParse(
        Object.fromEntries(
          Array.from({ length: 121 }, (_, index) => [
            new Date(Date.UTC(2027, 0, index + 1)).toISOString().slice(0, 10),
            [],
          ]),
        ),
      ).success,
    ).toBe(false);
    expect(
      availabilityOverridesSchema.safeParse({
        "2026-09-08": [{ start: "09:00", end: "17:00", hidden: true }],
      }).success,
    ).toBe(false);
  });

  it("rejects invalid timezones, malformed ranges, excess periods, and unknown fields", () => {
    const base = {
      timezone: "Not/A_Timezone",
      availability: { monday: [{ start: "09:00", end: "17:00" }] },
    };
    expect(workingHoursSettingsSchema.safeParse(base).success).toBe(false);
    expect(
      weeklyAvailabilitySchema.safeParse({
        monday: [{ start: "17:00", end: "09:00" }],
      }).success,
    ).toBe(false);
    expect(
      weeklyAvailabilitySchema.safeParse({
        monday: Array.from({ length: 5 }, (_, index) => ({
          start: `0${index}:00`,
          end: `0${index}:30`,
        })),
      }).success,
    ).toBe(false);
    expect(
      workingHoursSettingsSchema.safeParse({
        timezone: "UTC",
        availability: {},
        repId: "browser-controlled",
      }).success,
    ).toBe(false);
    expect(
      workingHoursSettingsSchema.parse({
        timezone: "UTC",
        availability: {},
      }),
    ).not.toHaveProperty("availabilityOverrides");
    expect(
      weeklyAvailabilitySchema.safeParse({
        monday: [{ start: "09:00", end: "17:00", label: "hidden" }],
      }).success,
    ).toBe(false);
  });

  it("normalizes reusable schedule names and periods", () => {
    expect(
      availabilityScheduleInputSchema.parse({
        name: " Revenue team ",
        availability: {
          monday: [
            { start: "13:00", end: "17:00" },
            { start: "09:00", end: "12:00" },
          ],
        },
      }),
    ).toEqual({
      name: "Revenue team",
      availability: {
        monday: [
          { start: "09:00", end: "12:00" },
          { start: "13:00", end: "17:00" },
        ],
      },
    });
    expect(
      availabilityScheduleInputSchema.safeParse({
        name: "x",
        availability: {},
      }).success,
    ).toBe(false);
  });

  it("accepts bounded meeting capacity and treats omitted limits as unlimited", () => {
    expect(
      workingHoursSettingsSchema.parse({
        timezone: "UTC",
        availability: {},
        dailyMeetingLimit: 4,
        weeklyMeetingLimit: 18,
      }),
    ).toEqual({
      timezone: "UTC",
      availability: {},
      dailyMeetingLimit: 4,
      weeklyMeetingLimit: 18,
    });
    expect(
      workingHoursSettingsSchema.parse({ timezone: "UTC", availability: {} }),
    ).not.toHaveProperty("dailyMeetingLimit");
    expect(
      workingHoursSettingsSchema.parse({ timezone: "UTC", availability: {} }),
    ).not.toHaveProperty("weeklyMeetingLimit");
    expect(
      workingHoursSettingsSchema.safeParse({
        timezone: "UTC",
        availability: {},
        dailyMeetingLimit: 0,
        weeklyMeetingLimit: 501,
      }).success,
    ).toBe(false);
  });
});
