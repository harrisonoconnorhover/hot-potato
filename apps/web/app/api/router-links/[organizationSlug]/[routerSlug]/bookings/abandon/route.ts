import {
  enforcePublicRateLimits,
  publicClientAddress,
  publicError,
  readPublicJson,
} from "../../../../../../public-api";
import { repository } from "../../../../../../repository";
import { findOwnedRepCalendarEvent } from "../../../../../../rep-calendar-availability";
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
          scope: "router_abandon_ip_link",
          identifier: `${clientAddress}:${params.data.routerSlug}`,
          limit: 10,
          windowSeconds: 10 * 60,
        },
        {
          scope: "router_abandon_session",
          identifier: body.data.sessionToken,
          limit: 6,
          windowSeconds: 10 * 60,
        },
      ],
    );
    if (limited) return limited;

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
    const booking = await repository.abandonRouterLinkBooking(
      params.data.organizationSlug,
      params.data.routerSlug,
      body.data.sessionToken,
      providerEvent,
    );
    if (!booking) {
      return publicError(404, "Booking not found.", "not_found");
    }
    return bookingStatusResponse(booking);
  } catch (error) {
    return publicRouterError(error);
  }
}
