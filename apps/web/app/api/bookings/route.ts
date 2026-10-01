import { CalendarSlotUnavailableError } from "@hot-potato/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { combinedRepBusyIntervals } from "../../rep-calendar-availability";
import { repository } from "../../repository";
import { additionalAttendeeEmailsInput } from "../../booking-guests";

const bookingRequest = z.object({
  externalId: z.string().min(1).max(200),
  decisionId: z.uuid(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  subject: z.string().trim().min(1).max(140),
  attendeeEmail: z.email().optional(),
  additionalAttendeeEmails: additionalAttendeeEmailsInput,
});

export async function POST(request: Request) {
  const parsed = bookingRequest.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Enter a valid meeting time and subject." },
      { status: 400 },
    );
  }

  const startsAt = new Date(parsed.data.startsAt);
  const endsAt = new Date(parsed.data.endsAt);
  if (
    startsAt.getTime() < Date.now() - 60_000 ||
    endsAt <= startsAt ||
    endsAt.getTime() - startsAt.getTime() > 8 * 60 * 60_000
  ) {
    return NextResponse.json(
      { error: "Choose a future meeting no longer than eight hours." },
      { status: 400 },
    );
  }

  try {
    const organizationSlug = process.env.HOT_POTATO_ORG ?? "acme";
    const existing = await repository.bookingByExternalId(
      organizationSlug,
      parsed.data.externalId,
    );
    if (existing) return NextResponse.json(existing);

    const rep = await repository.bookingContext(
      organizationSlug,
      parsed.data.decisionId,
    );
    if (!rep) {
      return NextResponse.json(
        {
          error:
            "The routed representative must connect Google Calendar or Outlook before booking.",
        },
        { status: 409 },
      );
    }
    const protectedStartsAt = new Date(
      startsAt.getTime() - rep.bufferBeforeMinutes * 60_000,
    );
    const protectedEndsAt = new Date(
      endsAt.getTime() + rep.bufferAfterMinutes * 60_000,
    );

    for (const participant of [
      rep.calendarQuote,
      ...(rep.calendarQuote.requiredCohosts ?? []),
    ]) {
      const busy = await combinedRepBusyIntervals({
        organizationSlug,
        repId: participant.repId,
        calendars: participant.conflictCalendars.map((calendar) => ({
          ...calendar,
          available: true,
        })),
        startsAt: protectedStartsAt,
        endsAt: protectedEndsAt,
      });
      if (busy.length > 0) {
        return NextResponse.json(
          {
            error:
              "That time is no longer available for everyone required to attend.",
          },
          { status: 409 },
        );
      }
    }
    const cohostGroups = [] as NonNullable<
      typeof rep.calendarQuote.cohostGroups
    >;
    for (const group of rep.calendarQuote.cohostGroups ?? []) {
      if (!group.requiredForAvailability) {
        cohostGroups.push(group);
        continue;
      }
      const candidateQuotes = [] as typeof group.candidateQuotes;
      for (const candidate of group.candidateQuotes) {
        const busy = await combinedRepBusyIntervals({
          organizationSlug,
          repId: candidate.repId,
          calendars: candidate.conflictCalendars.map((calendar) => ({
            ...calendar,
            available: true,
          })),
          startsAt: protectedStartsAt,
          endsAt: protectedEndsAt,
        });
        if (busy.length === 0) candidateQuotes.push(candidate);
      }
      if (candidateQuotes.length === 0) {
        return NextResponse.json(
          {
            error:
              "That time is no longer available for a required co-host role.",
          },
          { status: 409 },
        );
      }
      cohostGroups.push({ ...group, candidateQuotes });
    }

    const job = await repository.enqueueCalendarBooking({
      organizationSlug,
      externalId: parsed.data.externalId,
      decisionId: parsed.data.decisionId,
      startsAt,
      endsAt,
      subject: parsed.data.subject,
      provider: rep.provider,
      calendarQuote: { ...rep.calendarQuote, cohostGroups },
      attendeeEmail: parsed.data.attendeeEmail,
      additionalAttendeeEmails: parsed.data.additionalAttendeeEmails,
    });
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    if (error instanceof CalendarSlotUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error(
      "Calendar booking failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return NextResponse.json(
      { error: "Calendar availability could not be verified." },
      { status: 503 },
    );
  }
}
