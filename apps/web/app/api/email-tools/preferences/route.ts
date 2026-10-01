import { z } from "zod";
import { emailToolAccess } from "../../../email-tools";
import {
  enforcePublicRateLimits,
  publicBodyError,
  PublicBodyError,
  publicError,
  publicJson,
  readPublicJson,
} from "../../../public-api";
import { repository } from "../../../repository";

const preferenceInput = z
  .object({
    purpose: z.enum(["link", "times"]),
    assetId: z.uuid(),
  })
  .strict();

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await emailToolAccess(request);
    if (!access) {
      return publicError(
        401,
        "Sign in with Microsoft or enter a valid Outlook pairing key.",
        "invalid_outlook_identity",
      );
    }
    if (access.clientType !== "outlook") {
      return publicError(
        403,
        "This pairing key is not valid for Outlook.",
        "wrong_client",
      );
    }
    const limited = await enforcePublicRateLimits(
      repository,
      access.organization.slug,
      [
        {
          scope: "email_tool_preference_key",
          identifier: access.keyId,
          limit: 120,
          windowSeconds: 10 * 60,
        },
      ],
    );
    if (limited) return limited;

    const parsed = preferenceInput.safeParse(
      await readPublicJson(request, 1024),
    );
    if (!parsed.success) {
      return publicError(
        422,
        "Choose an active scheduling link.",
        "invalid_preference",
      );
    }
    const remembered = await repository.rememberEmailToolRecentAsset({
      organizationSlug: access.organization.slug,
      repId: access.rep.id,
      ...parsed.data,
    });
    if (!remembered) {
      return publicError(
        404,
        "That scheduling link is no longer active.",
        "asset_not_found",
      );
    }
    return publicJson({ remembered: true });
  } catch (error) {
    if (error instanceof PublicBodyError) return publicBodyError(error);
    console.error(
      "Outlook scheduling preference failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return publicError(
      503,
      "The recent scheduling choice could not be saved.",
      "service_unavailable",
    );
  }
}
