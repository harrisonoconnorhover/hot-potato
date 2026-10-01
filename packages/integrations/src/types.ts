export type CrmOwnerWriteback = {
  decisionId: string;
  leadEmail: string;
  ownerEmail: string;
  signal?: AbortSignal;
};

export type CrmRoleOwner = {
  propertyName: string;
  ownerEmail: string;
};

export type CrmRoleWriteback = {
  bookingId: string;
  leadEmail: string;
  roleOwners: CrmRoleOwner[];
  signal?: AbortSignal;
};

export type CrmWritebackResult = {
  externalReference: string;
};

export interface CrmAdapter {
  readonly key: string;
  writeOwner(input: CrmOwnerWriteback): Promise<CrmWritebackResult>;
  writeRoles(input: CrmRoleWriteback): Promise<CrmWritebackResult>;
}

export type AvailabilityQuery = {
  repEmails: string[];
  startsAt: Date;
  endsAt: Date;
};

export interface CalendarAdapter {
  readonly key: string;
  busyRepEmails(input: AvailabilityQuery): Promise<string[]>;
}

export type ConnectedCalendar = {
  id: string;
  name: string;
  isDefault: boolean;
};

export type CalendarIntervalQuery = {
  startsAt: Date;
  endsAt: Date;
  calendarIds?: string[];
  signal?: AbortSignal;
};

export type CalendarConferenceProvider =
  | "none"
  | "google_meet"
  | "microsoft_teams"
  | "zoom";

export type CalendarEventInput = {
  subject: string;
  startsAt: Date;
  endsAt: Date;
  attendeeEmail?: string;
  attendeeName?: string;
  additionalAttendeeEmails?: string[];
  cohostEmails?: string[];
  description?: string;
  transactionId: string;
  conferenceProvider?: CalendarConferenceProvider;
  conferenceUrl?: string;
  signal?: AbortSignal;
};

export type CalendarEventAttendee = {
  email: string;
  name?: string;
};

export function calendarEventAttendees(
  input: CalendarEventInput,
): CalendarEventAttendee[] {
  const attendees = new Map<string, CalendarEventAttendee>();
  const add = (value: string, name?: string) => {
    const email = value.trim().toLowerCase();
    if (
      email.length < 3 ||
      email.length > 320 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      throw new Error("The calendar event contains an invalid attendee email.");
    }
    if (!attendees.has(email)) {
      attendees.set(email, { email, ...(name ? { name } : {}) });
    }
  };

  if (input.attendeeEmail) add(input.attendeeEmail, input.attendeeName);
  for (const email of input.additionalAttendeeEmails ?? []) add(email);
  for (const email of input.cohostEmails ?? []) add(email);
  if (attendees.size > 16) {
    throw new Error("The calendar event has too many attendees.");
  }
  return [...attendees.values()];
}

export type CalendarEventResult = {
  externalEventId: string;
  webLink: string | null;
  conferenceUrl: string | null;
};

export type CalendarEventLookupInput = {
  transactionId: string;
  startsAt: Date;
  endsAt: Date;
  signal?: AbortSignal;
};
