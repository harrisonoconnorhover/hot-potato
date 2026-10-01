import {
  emailComposerAssets,
  emailToolAccess,
  emailToolCatalogForAccess,
} from "../../../email-tools";
import {
  enforcePublicRateLimits,
  publicError,
  publicJson,
} from "../../../public-api";
import { repository } from "../../../repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
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
          scope: "email_tool_catalog_key",
          identifier: access.keyId,
          limit: 180,
          windowSeconds: 10 * 60,
        },
      ],
    );
    if (limited) return limited;

    const catalog = await emailToolCatalogForAccess(access);
    if (!catalog) {
      return publicError(
        403,
        "This representative no longer has access to scheduling links.",
        "access_removed",
      );
    }
    return publicJson({
      organizationName: catalog.organizationName,
      repName: catalog.repName,
      authentication: access.keyId.startsWith("entra:")
        ? "microsoft"
        : "pairing_key",
      recentLinkAssetId: catalog.recentLinkAssetId,
      recentMeetingTypeId: catalog.recentMeetingTypeId,
      recentPurpose: catalog.recentPurpose,
      assets: emailComposerAssets(catalog),
    });
  } catch (error) {
    console.error(
      "Email tool catalog failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return publicError(
      503,
      "Scheduling links could not be loaded. Please try again.",
      "service_unavailable",
    );
  }
}
