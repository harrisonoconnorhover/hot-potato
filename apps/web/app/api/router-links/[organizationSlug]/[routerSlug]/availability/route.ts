import { cachedAvailablePublicSlots } from "../../../../../public-scheduling";
import {
  enforcePublicRateLimits,
  publicClientAddress,
  publicError,
  publicJson,
  readPublicJson,
} from "../../../../../public-api";
import { repository } from "../../../../../repository";
import { publicRouterError } from "../../../responses";
import { parseRouterParams, sessionInput } from "../../../schemas";

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
      return publicError(404, "Routing session not found.", "not_found");
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
          scope: "router_availability_ip_link",
          identifier: `${clientAddress}:${link.slug}`,
          limit: 60,
          windowSeconds: 60,
        },
        {
          scope: "router_availability_session",
          identifier: body.data.sessionToken,
          limit: 45,
          windowSeconds: 60,
        },
      ],
    );
    if (limited) return limited;

    const session = await repository.routerLinkSession(
      link.organizationSlug,
      link.slug,
      body.data.sessionToken,
    );
    if (!session) {
      return publicError(404, "Routing session not found.", "not_found");
    }

    const slots = await cachedAvailablePublicSlots(session.schedule);
    return publicJson({ slots });
  } catch (error) {
    return publicRouterError(error);
  }
}
