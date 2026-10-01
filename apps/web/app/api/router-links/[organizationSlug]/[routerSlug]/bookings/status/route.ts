import {
  enforcePublicRateLimits,
  publicClientAddress,
  publicError,
  readPublicJson,
} from "../../../../../../public-api";
import { repository } from "../../../../../../repository";
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
    return publicError(404, "Smart Router Link not found.", "not_found");
  }

  try {
    const body = sessionInput.safeParse(await readPublicJson(request));
    if (!body.success) {
      return publicError(404, "Booking not found.", "not_found");
    }

    const booking = await repository.routerLinkBookingStatus(
      params.data.organizationSlug,
      params.data.routerSlug,
      body.data.sessionToken,
    );
    if (!booking) {
      const activeLink = await repository.publicRouterLink(
        params.data.organizationSlug,
        params.data.routerSlug,
      );
      if (!activeLink) {
        return publicError(404, "Booking not found.", "not_found");
      }
    }

    const clientAddress = publicClientAddress(request);
    const limited = await enforcePublicRateLimits(
      repository,
      params.data.organizationSlug,
      [
        {
          scope: "router_status_ip_link",
          identifier: `${clientAddress}:${params.data.routerSlug}`,
          limit: 120,
          windowSeconds: 60,
        },
        {
          scope: "router_status_session",
          identifier: body.data.sessionToken,
          limit: 90,
          windowSeconds: 60,
        },
      ],
    );
    if (limited) return limited;
    if (!booking) {
      return publicError(404, "Booking not found.", "not_found");
    }

    return bookingStatusResponse(booking);
  } catch (error) {
    return publicRouterError(error);
  }
}
