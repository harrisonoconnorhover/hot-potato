import {
  CalendarSlotUnavailableError,
  InviteeBookingLimitError,
} from "@hot-potato/db";
import { z } from "zod";
import {
  availablePublicSlotOptions,
  loadPublicSchedule,
} from "../../../public-scheduling";
import {
  enforcePublicRateLimits,
  PublicBodyError,
  publicBodyError,
  publicClientAddress,
  publicError,
  publicJson,
  readPublicJson,
} from "../../../public-api";
import { repository } from "../../../repository";
import {
  additionalAttendeeEmailsInput,
  withoutPrimaryAttendee,
} from "../../../booking-guests";
import { safeSchedulingBookingStatus } from "./response";

const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(80);

const bookingRequest = z
  .object({
    organizationSlug: slug,
    schedulingSlug: slug,
    externalId: z.uuid(),
    startsAt: z.iso.datetime(),
    attendeeName: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
    attendeeEmail: z
      .email()
      .max(320)
      .transform((value) => value.toLowerCase()),
    additionalAttendeeEmails: additionalAttendeeEmailsInput,
    website: z.string().max(200).optional(),
  })
  .strict();

const statusRequest = z.object({
  organization: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  rep: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  externalId: z.uuid(),
});

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const parsed = bookingRequest.safeParse(await readPublicJson(request));
    if (!parsed.success) {
      return publicError(
        422,
        "Enter your name, a valid email, and an available time.",
        "invalid_booking",
      );
    }

    const schedule = await loadPublicSchedule(
      parsed.data.organizationSlug,
      parsed.data.schedulingSlug,
    );
    if (!schedule) {
      return publicError(404, "Scheduling link not found.", "not_found");
    }

    const limited = await enforcePublicRateLimits(
      repository,
      schedule.organizationSlug,
      [
        {
          scope: "scheduling_booking_link",
          identifier: schedule.schedulingSlug,
          limit: 120,
          windowSeconds: 10 * 60,
        },
        {
          scope: "scheduling_booking_ip_link",
          identifier: `${publicClientAddress(request)}:${schedule.schedulingSlug}`,
          limit: 12,
          windowSeconds: 10 * 60,
        },
        {
          scope: "scheduling_booking_external_id",
          identifier: parsed.data.externalId,
          limit: 8,
          windowSeconds: 10 * 60,
        },
      ],
    );
    if (limited) return limited;

    if (parsed.data.website) {
      return publicJson({ status: "completed", error: null });
    }

    const existing = await repository.publicBookingStatus(
      schedule.organizationSlug,
      schedule.schedulingSlug,
      parsed.data.externalId,
    );
    if (existing) {
      return publicJson(safeSchedulingBookingStatus(existing), 202);
    }

    const offeredSlots = await availablePublicSlotOptions(schedule);
    const offered = offeredSlots.find(
      (slot) => slot.startsAt === parsed.data.startsAt,
    );
    if (!offered) {
      return publicError(
        409,
        "That time is no longer available. Choose another time.",
        "slot_unavailable",
      );
    }

    const additionalAttendeeEmails = withoutPrimaryAttendee(
      parsed.data.attendeeEmail,
      parsed.data.additionalAttendeeEmails,
    );
    const booking = await repository.enqueuePublicBooking({
      organizationSlug: schedule.organizationSlug,
      schedulingSlug: schedule.schedulingSlug,
      meetingTypeId: schedule.meetingTypeId,
      candidateQuotes: offered.candidateQuotes,
      externalId: parsed.data.externalId,
      startsAt: new Date(offered.startsAt),
      endsAt: new Date(offered.endsAt),
      attendeeName: parsed.data.attendeeName,
      attendeeEmail: parsed.data.attendeeEmail,
      additionalAttendeeEmails,
      subject: `${schedule.meetingTitle} · ${parsed.data.attendeeName}`,
      conferenceProvider: schedule.conferenceProvider,
      zoomJoinUrl: schedule.zoomJoinUrl,
      reminderMinutes: schedule.reminderMinutes,
      description: `Scheduled through Hot Potato.\nAttendee: ${parsed.data.attendeeName} <${parsed.data.attendeeEmail}>`,
    });
    return publicJson(safeSchedulingBookingStatus(booking), 202);
  } catch (error) {
    if (error instanceof PublicBodyError) return publicBodyError(error);
    if (error instanceof CalendarSlotUnavailableError) {
      return publicError(409, error.message, "slot_unavailable");
    }
    if (error instanceof InviteeBookingLimitError) {
      return publicError(409, error.message, "booking_limit_reached");
    }
    console.error(
      "Public calendar booking failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return publicError(
      503,
      "The meeting could not be confirmed. Please try again.",
      "service_unavailable",
    );
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = statusRequest.safeParse({
    organization: url.searchParams.get("organization"),
    rep: url.searchParams.get("rep"),
    externalId: url.searchParams.get("externalId"),
  });
  if (!parsed.success) {
    return publicError(404, "Booking not found.", "not_found");
  }

  try {
    const limited = await enforcePublicRateLimits(
      repository,
      parsed.data.organization,
      [
        {
          scope: "scheduling_status_ip_link",
          identifier: `${publicClientAddress(request)}:${parsed.data.rep}`,
          limit: 120,
          windowSeconds: 10 * 60,
        },
      ],
    );
    if (limited) return limited;

    const booking = await repository.publicBookingStatus(
      parsed.data.organization,
      parsed.data.rep,
      parsed.data.externalId,
    );
    if (!booking) {
      return publicError(404, "Booking not found.", "not_found");
    }
    return publicJson(safeSchedulingBookingStatus(booking));
  } catch (error) {
    console.error(
      "Public booking status failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return publicError(
      503,
      "The booking status could not be loaded. Please try again.",
      "service_unavailable",
    );
  }
}
