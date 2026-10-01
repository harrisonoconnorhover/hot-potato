import { z } from "zod";

export const maximumAdditionalAttendees = 5;

const guestEmail = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid guest email address.").max(320));

export const additionalAttendeeEmailsInput = z
  .array(guestEmail)
  .transform((values) => [...new Set(values)])
  .pipe(
    z
      .array(z.string())
      .max(
        maximumAdditionalAttendees,
        `Invite no more than ${maximumAdditionalAttendees} additional guests.`,
      ),
  )
  .default([]);

export function withoutPrimaryAttendee(
  primaryEmail: string,
  additionalAttendeeEmails: readonly string[],
): string[] {
  const primary = primaryEmail.trim().toLowerCase();
  return additionalAttendeeEmails.filter((email) => email !== primary);
}
