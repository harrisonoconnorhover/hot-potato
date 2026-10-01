import { z } from "zod";
import { additionalAttendeeEmailsInput } from "../../booking-guests";

export const routerSlug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(80);

export const routerSessionToken = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const safeFieldPath = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/)
  .max(160)
  .refine(
    (value) =>
      value
        .split(".")
        .every(
          (part) =>
            part !== "__proto__" &&
            part !== "prototype" &&
            part !== "constructor",
        ),
    { message: "Use a valid qualification field." },
  );

const answerValue = z.union([
  z.string().max(500),
  z.number().finite().min(-1_000_000_000_000).max(1_000_000_000_000),
]);

const answers = z
  .record(safeFieldPath, answerValue)
  .refine((value) => Object.keys(value).length <= 20, {
    message: "Submit no more than 20 qualification answers.",
  })
  .refine(
    (value) =>
      !Object.keys(value).some(
        (field) =>
          field === "email" ||
          field === "name" ||
          field === "current_owner_email" ||
          field === "attendee_name",
      ),
    { message: "Submit identity fields using the dedicated fields." },
  );

const attendeeName = z
  .string()
  .trim()
  .min(2)
  .max(80)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: "Enter your name without control characters.",
  });

export const qualificationInput = z
  .object({
    attendeeName,
    attendeeEmail: z
      .email()
      .max(320)
      .transform((value) => value.toLowerCase()),
    answers,
    website: z.string().max(200).optional(),
  })
  .strict();

export const sessionInput = z
  .object({ sessionToken: routerSessionToken })
  .strict();

export const bookingInput = z
  .object({
    sessionToken: routerSessionToken,
    startsAt: z.iso.datetime(),
    additionalAttendeeEmails: additionalAttendeeEmailsInput,
    website: z.string().max(200).optional(),
  })
  .strict();

export function parseRouterParams(input: {
  organizationSlug: string;
  routerSlug: string;
}) {
  return z
    .object({ organizationSlug: routerSlug, routerSlug })
    .safeParse(input);
}
