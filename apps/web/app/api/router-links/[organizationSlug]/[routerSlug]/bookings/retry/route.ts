import {
  CalendarSlotUnavailableError,
  RouterLinkConflictError,
  type BookingCandidateQuote,
} from "@hot-potato/db";
import { availablePublicSlotOptions } from "../../../../../../public-scheduling";
import { findOwnedRepCalendarEvent } from "../../../../../../rep-calendar-availability";
import {
  enforcePublicRateLimits,
  publicClientAddress,
  publicError,
  readPublicJson,
} from "../../../../../../public-api";
import { repository } from "../../../../../../repository";
import { verifiedFailedRouterProviderEvent } from "../../../../../../router-booking-recovery";
import {
  bookingStatusResponse,
  publicRouterError,
} from "../../../../responses";
import { parseRouterParams, sessionInput } from "../../../../schemas";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: {
    params: Promise<{ organizationSlug: string; routerSlug: string }>;
  },
) {
  const params = parseRouterParams(await context.params);
  if (!params.success) {
    return publicError(404, "Booking not found.", "not_found");
  }

  try {
    const body = sessionInput.safeParse(await readPublicJson(request));
    if (!body.success) {
      return publicError(404, "Booking not found.", "not_found");
    }

    const retryContext = await repository.routerLinkBookingRetryContext(
      params.data.organizationSlug,
      params.data.routerSlug,
      body.data.sessionToken,
    );
    if (!retryContext) {
      return publicError(404, "Booking not found.", "not_found");
    }

    const clientAddress = publicClientAddress(request);
    const limited = await enforcePublicRateLimits(
      repository,
      params.data.organizationSlug,
      [
        {
          scope: "router_retry_ip_link",
          identifier: `${clientAddress}:${params.data.routerSlug}`,
          limit: 12,
          windowSeconds: 10 * 60,
        },
        {
          scope: "router_retry_session",
          identifier: body.data.sessionToken,
          limit: 8,
          windowSeconds: 10 * 60,
        },
      ],
    );
    if (limited) return limited;

    let calendarQuote: BookingCandidateQuote | undefined;
    if (retryContext.status === "failed") {
      const providerEvent = await verifiedFailedRouterProviderEvent(
        retryContext,
        {
          findOwnedCalendarEvent: (context) =>
            findOwnedRepCalendarEvent({
              organizationSlug: context.organizationSlug,
              repId: context.repId,
              provider: context.calendarProvider,
              calendarExternalAccountId: context.calendarExternalAccountId,
              transactionId: context.transactionId,
              externalEventId: context.externalEventId,
              startsAt: new Date(context.startsAt),
              endsAt: new Date(context.endsAt),
            }),
          bindLegacyBookingCalendarAccount: (manageToken, proof) =>
            repository.bindLegacyBookingCalendarAccount(manageToken, proof),
        },
      );
      if (!providerEvent) {
        if (!retryContext.schedule) {
          throw new RouterLinkConflictError(
            "The original booking destination is no longer available to retry.",
          );
        }
        const available = await availablePublicSlotOptions(
          retryContext.schedule,
          new Date(),
          retryContext.repId,
          retryContext.transactionId,
        );
        const slot = available.find(
          (candidate) =>
            candidate.startsAt === retryContext.startsAt &&
            candidate.endsAt === retryContext.endsAt,
        );
        calendarQuote = slot?.candidateQuotes.find(
          (quote) => quote.repId === retryContext.repId,
        );
        if (!calendarQuote) {
          throw new CalendarSlotUnavailableError();
        }
      }
    }

    const booking = await repository.retryRouterLinkBooking(
      params.data.organizationSlug,
      params.data.routerSlug,
      body.data.sessionToken,
      calendarQuote,
    );
    if (!booking) {
      return publicError(404, "Booking not found.", "not_found");
    }
    return bookingStatusResponse(booking);
  } catch (error) {
    return publicRouterError(error);
  }
}
