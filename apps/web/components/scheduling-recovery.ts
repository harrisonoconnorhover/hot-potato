import { slotFromBookingStatus } from "./booking-status";
import type { PublicBookingStatus } from "@hot-potato/db";
import { fetchBookingJson } from "./booking-fetch";

type SchedulingResponse = Partial<PublicBookingStatus>;

export type SchedulingRequest = {
  organizationSlug: string;
  schedulingSlug: string;
  externalId: string;
  startsAt: string;
  attendeeName: string;
  attendeeEmail: string;
  additionalAttendeeEmails: string[];
  website: string;
};

export type SchedulingRecovery = {
  version: 1;
  submitted: boolean;
  request: SchedulingRequest;
  endsAt: string;
};

export function schedulingRecoveryKey(organization: string, schedule: string) {
  return `hot-potato:personal-booking:${encodeURIComponent(organization)}:${encodeURIComponent(schedule)}`;
}

export function parseSchedulingRecovery(
  raw: string | null,
  organization: string,
  schedule: string,
): SchedulingRecovery | null {
  if (!raw || raw.length > 8_000) return null;
  try {
    const value = JSON.parse(raw) as SchedulingRecovery;
    const request = value?.request;
    if (
      value.version !== 1 ||
      typeof value.submitted !== "boolean" ||
      !request ||
      request.organizationSlug !== organization ||
      request.schedulingSlug !== schedule ||
      typeof request.externalId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        request.externalId,
      ) ||
      !slotFromBookingStatus({
        startsAt: request.startsAt,
        endsAt: value.endsAt,
      }) ||
      typeof request.attendeeName !== "string" ||
      request.attendeeName.length > 80 ||
      typeof request.attendeeEmail !== "string" ||
      request.attendeeEmail.length > 320 ||
      typeof request.website !== "string" ||
      request.website.length > 200 ||
      !Array.isArray(request.additionalAttendeeEmails) ||
      request.additionalAttendeeEmails.length > 10 ||
      request.additionalAttendeeEmails.some(
        (email) => typeof email !== "string" || email.length > 320,
      )
    ) {
      return null;
    }
    // Only return the known request fields; storage cannot add API properties.
    return {
      version: 1,
      submitted: value.submitted,
      request: {
        organizationSlug: organization,
        schedulingSlug: schedule,
        externalId: request.externalId,
        startsAt: request.startsAt,
        attendeeName: request.attendeeName,
        attendeeEmail: request.attendeeEmail,
        additionalAttendeeEmails: [...request.additionalAttendeeEmails],
        website: request.website,
      },
      endsAt: value.endsAt,
    };
  } catch {
    return null;
  }
}

export function readSchedulingStatus(
  request: SchedulingRequest,
  send: typeof fetch = fetch,
) {
  const query = new URLSearchParams({
    organization: request.organizationSlug,
    rep: request.schedulingSlug,
    externalId: request.externalId,
  });
  return fetchBookingJson<SchedulingResponse>(
    `/api/scheduling/bookings?${query}`,
    { cache: "no-store" },
    send,
  );
}

export function submitSchedulingRequest(
  request: SchedulingRequest,
  send: typeof fetch = fetch,
) {
  return fetchBookingJson<SchedulingResponse>(
    "/api/scheduling/bookings",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
    send,
  );
}

export function schedulingRejectionMayUnlock(
  recovery: SchedulingRecovery,
  status: number,
) {
  return !recovery.submitted && [404, 409, 422].includes(status);
}
