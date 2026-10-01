import { randomBytes } from "node:crypto";
import { CalendarSlotUnavailableError } from "@hot-potato/db";
import { availablePublicSlotOptions } from "../../../../../public-scheduling";
import {
  enforcePublicRateLimits,
  publicClientAddress,
  publicError,
  publicJson,
  readPublicJson,
} from "../../../../../public-api";
import { repository } from "../../../../../repository";
import { bookingStatusResponse, publicRouterError } from "../../../responses";
import { bookingInput, parseRouterParams } from "../../../schemas";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: {
    params: Promise<{ organizationSlug: string; routerSlug: string }>;
  },
) {
  const params = parseRouterParams(await context.params);
  if (!params.success) {
    return publicError(404, "Smart Router Link not found.", "not_found");
  }

  try {
    const body = bookingInput.safeParse(await readPublicJson(request));
    if (!body.success) {
      return publicError(
        422,
        body.error.issues[0]?.message ?? "Choose a valid available time.",
        "invalid_booking",
      );
    }

    const link = await repository.publicRouterLink(
      params.data.organizationSlug,
      params.data.routerSlug,
    );
    if (!link) {
      return publicError(404, "Smart Router Link not found.", "not_found");
    }

    const clientAddress = publicClientAddress(request);
    const limited = await enforcePublicRateLimits(
      repository,
      link.organizationSlug,
      [
        {
          scope: "router_booking_ip_link",
          identifier: `${clientAddress}:${link.slug}`,
          limit: 8,
          windowSeconds: 10 * 60,
        },
        {
          scope: "router_booking_session",
          identifier: body.data.sessionToken,
          limit: 6,
          windowSeconds: 10 * 60,
        },
      ],
    );
    if (limited) return limited;

    const existing = await repository.routerLinkBookingStatus(
      link.organizationSlug,
      link.slug,
      body.data.sessionToken,
    );
    if (existing) return bookingStatusResponse(existing);

    const session = await repository.routerLinkSession(
      link.organizationSlug,
      link.slug,
      body.data.sessionToken,
    );
    if (!session) {
      return publicError(404, "Routing session not found.", "not_found");
    }

    if (body.data.website) {
      return publicJson(
        {
          status: "pending",
          error: null,
          managePath: null,
          conferenceUrl: null,
          repName: null,
          startsAt: body.data.startsAt,
          endsAt: new Date(
            new Date(body.data.startsAt).getTime() +
              session.schedule.durationMinutes * 60_000,
          ).toISOString(),
        },
        202,
      );
    }

    const startsAt = new Date(body.data.startsAt);
    const endsAt = new Date(
      startsAt.getTime() + session.schedule.durationMinutes * 60_000,
    );
    const attemptToken = randomBytes(32).toString("base64url");
    const attempt = await repository.beginRouterLinkBookingAttempt({
      organizationSlug: link.organizationSlug,
      routerSlug: link.slug,
      sessionToken: body.data.sessionToken,
      attemptToken,
      startsAt,
      endsAt,
    });
    if (!attempt.acquired) return bookingStatusResponse(attempt.booking);

    try {
      const offeredSlots = await availablePublicSlotOptions(session.schedule);
      const selected = offeredSlots.find(
        (slot) =>
          slot.startsAt === startsAt.toISOString() &&
          slot.endsAt === endsAt.toISOString(),
      );
      if (!selected) throw new CalendarSlotUnavailableError();

      const booking = await repository.bookRouterLinkSession({
        organizationSlug: link.organizationSlug,
        routerSlug: link.slug,
        sessionToken: body.data.sessionToken,
        attemptToken,
        candidateQuotes: selected.candidateQuotes,
        startsAt,
        endsAt,
        additionalAttendeeEmails: body.data.additionalAttendeeEmails,
      });
      return bookingStatusResponse(booking);
    } catch (error) {
      await repository
        .releaseRouterLinkBookingAttempt(
          link.organizationSlug,
          link.slug,
          body.data.sessionToken,
          attemptToken,
        )
        .catch(() => undefined);
      throw error;
    }
  } catch (error) {
    return publicRouterError(error);
  }
}
