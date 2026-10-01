import { randomBytes } from "node:crypto";
import {
  publicClientAddress,
  enforcePublicRateLimits,
  publicError,
  publicJson,
  readPublicJson,
} from "../../../../../public-api";
import { resolveHubSpotOwnership } from "../../../../../hubspot-routing-context";
import { repository } from "../../../../../repository";
import { publicRouterError } from "../../../responses";
import { parseRouterParams, qualificationInput } from "../../../schemas";

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
    const link = await repository.publicRouterLink(
      params.data.organizationSlug,
      params.data.routerSlug,
    );
    if (!link) {
      return publicError(404, "Smart Router Link not found.", "not_found");
    }

    const body = qualificationInput.safeParse(await readPublicJson(request));
    if (!body.success) {
      return publicError(
        422,
        body.error.issues[0]?.message ?? "Check the qualification details.",
        "invalid_answers",
      );
    }

    const clientAddress = publicClientAddress(request);
    const limited = await enforcePublicRateLimits(
      repository,
      link.organizationSlug,
      [
        {
          scope: "router_qualify_ip_link",
          identifier: `${clientAddress}:${link.slug}`,
          limit: 15,
          windowSeconds: 60,
        },
        {
          scope: "router_qualify_email_link",
          identifier: `${link.slug}:${body.data.attendeeEmail}`,
          limit: 8,
          windowSeconds: 10 * 60,
        },
      ],
    );
    if (limited) return limited;

    if (body.data.website) {
      return publicJson(
        { outcome: "no_match", noMatchMessage: link.noMatchMessage },
        422,
      );
    }

    const ownership = await resolveHubSpotOwnership({
      organizationSlug: link.organizationSlug,
      contactEmail: body.data.attendeeEmail,
    });
    const qualification = await repository.qualifyRouterLink({
      organizationSlug: link.organizationSlug,
      routerSlug: link.slug,
      sessionToken: randomBytes(32).toString("base64url"),
      attendeeName: body.data.attendeeName,
      attendeeEmail: body.data.attendeeEmail,
      answers: body.data.answers,
      ...(ownership.ownerEmail
        ? { currentOwnerEmail: ownership.ownerEmail }
        : {}),
    });

    if (qualification.outcome === "no_match") {
      return publicJson(
        {
          outcome: qualification.outcome,
          noMatchMessage: qualification.noMatchMessage,
        },
        422,
      );
    }

    return publicJson({
      outcome: qualification.outcome,
      sessionToken: qualification.sessionToken,
      expiresAt: qualification.expiresAt,
      meetingType: qualification.meetingType,
    });
  } catch (error) {
    return publicRouterError(error);
  }
}
