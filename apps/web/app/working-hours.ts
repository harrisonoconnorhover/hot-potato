import type {
  DateAvailabilityOverrides,
  TimeRange,
  WeeklyAvailability,
} from "@hot-potato/router";
import { z } from "zod";

export const workingHoursDays = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type WorkingHoursDay = (typeof workingHoursDays)[number];

const timeRangeSchema = z
  .object({
    start: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Enter a valid start time."),
    end: z
      .string()
      .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Enter a valid end time."),
  })
  .strict()
  .refine((range) => range.start < range.end, {
    message: "Working hours must end after they start.",
  });

const dayRangesSchema = z
  .array(timeRangeSchema)
  .max(4, {
    message: "Use no more than four working periods in one day.",
  })
  .superRefine((ranges, context) => {
    const sorted = [...ranges].sort((left, right) =>
      left.start.localeCompare(right.start),
    );
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index]!.start < sorted[index - 1]!.end) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Working periods on the same day cannot overlap.",
        });
      }
    }
  })
  .transform((ranges): TimeRange[] =>
    [...ranges].sort((left, right) => left.start.localeCompare(right.start)),
  );

export const weeklyAvailabilitySchema = z
  .object({
    monday: dayRangesSchema.optional(),
    tuesday: dayRangesSchema.optional(),
    wednesday: dayRangesSchema.optional(),
    thursday: dayRangesSchema.optional(),
    friday: dayRangesSchema.optional(),
    saturday: dayRangesSchema.optional(),
    sunday: dayRangesSchema.optional(),
  })
  .strict()
  .transform((availability): WeeklyAvailability => {
    const normalized: WeeklyAvailability = {};
    for (const day of workingHoursDays) {
      const ranges = availability[day];
      if (!ranges?.length) continue;
      normalized[day] = ranges;
    }
    return normalized;
  });

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

const calendarDateSchema = z
  .string()
  .refine(validCalendarDate, "Choose a real calendar date.");

export const availabilityOverridesSchema = z
  .record(calendarDateSchema, dayRangesSchema)
  .superRefine((overrides, context) => {
    if (Object.keys(overrides).length > 120) {
      context.addIssue({
        code: "custom",
        message: "Use no more than 120 date overrides.",
      });
    }
  })
  .transform((overrides): DateAvailabilityOverrides => {
    const normalized: DateAvailabilityOverrides = {};
    for (const date of Object.keys(overrides).sort()) {
      normalized[date] = overrides[date] ?? [];
    }
    return normalized;
  });

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

const timezoneSchema = z
  .string()
  .trim()
  .min(1, "Choose a timezone.")
  .max(100, "Choose a shorter timezone name.")
  .refine(validTimezone, "Choose a valid timezone.");

export const workingHoursSettingsSchema = z
  .object({
    timezone: timezoneSchema,
    availability: weeklyAvailabilitySchema,
    availabilityOverrides: availabilityOverridesSchema.optional(),
    availabilityScheduleId: z.uuid().nullable().optional(),
    dailyMeetingLimit: z
      .number()
      .int("Daily capacity must be a whole number.")
      .min(1, "Daily capacity must be at least 1.")
      .max(100, "Daily capacity cannot exceed 100.")
      .nullable()
      .optional(),
    weeklyMeetingLimit: z
      .number()
      .int("Weekly capacity must be a whole number.")
      .min(1, "Weekly capacity must be at least 1.")
      .max(500, "Weekly capacity cannot exceed 500.")
      .nullable()
      .optional(),
  })
  .strict();

export const workingHoursInputSchema = workingHoursSettingsSchema.extend({
  repId: z.uuid("Check the representative identifier."),
});

export const availabilityScheduleInputSchema = z
  .object({
    id: z.uuid().optional(),
    name: z.string().trim().min(2).max(80),
    availability: weeklyAvailabilitySchema,
  })
  .strict();

export const availabilityScheduleDeleteSchema = z
  .object({ id: z.uuid() })
  .strict();
