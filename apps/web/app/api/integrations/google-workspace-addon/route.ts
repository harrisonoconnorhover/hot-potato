import {
  createGoogleWorkspaceAddonVerifier,
  GoogleWorkspaceAddonVerificationError,
} from "@hot-potato/integrations";
import {
  createEmailTimeChoices,
  revalidateEmailTimeSelection,
  renderBookingLink,
  renderSuggestedTimes,
  validateTimezone,
} from "@hot-potato/email-composer";
import { NextResponse } from "next/server";
import {
  configuredAppOrigin,
  emailComposerAssets,
  emailToolCatalogForVerifiedIdentity,
} from "../../../email-tools";
import {
  googleWorkspaceComposeCard,
  googleWorkspaceInsertedCard,
  googleWorkspaceNotification,
  googleWorkspaceScopeRequest,
  googleWorkspaceSetupCard,
  googleWorkspaceStringInput,
  googleWorkspaceStringInputs,
  googleWorkspaceTimePickerCard,
} from "../../../google-workspace-addon";
import {
  availablePublicSlots,
  loadPublicSchedule,
} from "../../../public-scheduling";
import {
  PublicBodyError,
  publicBodyError,
  readPublicJson,
} from "../../../public-api";
import { repository } from "../../../repository";

export const dynamic = "force-dynamic";

function addonEndpoint(): string {
  return new URL(
    "/api/integrations/google-workspace-addon",
    configuredAppOrigin(),
  ).toString();
}

function verifier() {
  const oauthClientId = process.env.GOOGLE_WORKSPACE_ADDON_OAUTH_CLIENT_ID;
  const systemServiceAccountEmail =
    process.env.GOOGLE_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL;
  if (!oauthClientId || !systemServiceAccountEmail) return null;
  return createGoogleWorkspaceAddonVerifier({
    endpointAudience: addonEndpoint(),
    oauthClientId,
    systemServiceAccountEmail,
  });
}

function addonJson(value: Record<string, unknown>, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function POST(request: Request) {
  const requestVerifier = verifier();
  if (!requestVerifier) {
    return addonJson(
      { error: "Google Workspace add-on identity is not configured." },
      503,
    );
  }

  try {
    const event = await readPublicJson(request, 64 * 1024);
    const verified = await requestVerifier.verify({
      authorizationHeader: request.headers.get("authorization"),
      event,
    });
    if (verified.kind === "requesting_google_scopes") {
      return addonJson(googleWorkspaceScopeRequest());
    }
    const identity = await repository.repIdentityForVerifiedEmail(
      verified.identity.email,
    );
    if (!identity) {
      return addonJson(
        googleWorkspaceSetupCard(
          "Your verified Google email is not mapped to one active Hot Potato representative. Ask an admin to add it or remove the duplicate mapping.",
        ),
      );
    }
    const rateLimit = await repository.consumePublicRateLimit({
      organizationSlug: identity.organization.slug,
      scope: "gmail_addon_user",
      identifier: verified.identity.subject,
      limit: 180,
      windowSeconds: 10 * 60,
    });
    if (!rateLimit.allowed) {
      return addonJson(
        googleWorkspaceNotification(
          "Too many requests. Wait a moment, then try again.",
        ),
      );
    }
    const catalog = await emailToolCatalogForVerifiedIdentity(identity);
    if (!catalog) {
      return addonJson(
        googleWorkspaceSetupCard(
          "Your Hot Potato representative is inactive or no longer belongs to this workspace.",
        ),
      );
    }
    const assets = emailComposerAssets(catalog);
    const action = verified.event.parameters.action;
    if (!action) {
      return addonJson(
        googleWorkspaceComposeCard({
          endpoint: addonEndpoint(),
          repName: catalog.repName,
          organizationName: catalog.organizationName,
          assets,
          recentLinkAssetId: catalog.recentLinkAssetId,
          recentMeetingTypeId: catalog.recentMeetingTypeId,
        }),
      );
    }

    if (action === "insert_link") {
      const assetId = googleWorkspaceStringInput(verified.event, "linkAssetId");
      const asset = assets.find((candidate) => candidate.id === assetId);
      if (!asset) {
        return addonJson(
          googleWorkspaceNotification(
            "Choose an active scheduling link and try again.",
          ),
        );
      }
      await repository
        .rememberEmailToolRecentAsset({
          organizationSlug: identity.organization.slug,
          repId: identity.rep.id,
          purpose: "link",
          assetId: asset.id,
        })
        .catch((error: unknown) => {
          console.error(
            "Gmail recent scheduling link could not be saved:",
            error instanceof Error ? error.name : "Unknown error",
          );
        });
      return addonJson(
        googleWorkspaceInsertedCard({
          endpoint: addonEndpoint(),
          content: renderBookingLink(asset),
        }),
      );
    }

    if (
      action === "choose_times" ||
      action === "refresh_times" ||
      action === "insert_times"
    ) {
      const assetId =
        verified.event.parameters.meetingAssetId ??
        googleWorkspaceStringInput(verified.event, "meetingAssetId");
      const asset = assets.find(
        (candidate) =>
          candidate.id === assetId && candidate.kind === "meeting_type",
      );
      if (!asset) {
        return addonJson(
          googleWorkspaceNotification(
            "Choose an active meeting type and try again.",
          ),
        );
      }
      let timezone: string;
      try {
        timezone = validateTimezone(
          googleWorkspaceStringInput(verified.event, "displayTimezone") ??
            verified.event.timeZone?.id ??
            "UTC",
        );
      } catch {
        return addonJson(
          googleWorkspaceNotification("Choose a valid display timezone."),
        );
      }
      const locale = verified.event.userLocale ?? "en-US";
      const schedule = await loadPublicSchedule(
        identity.organization.slug,
        asset.slug,
      );
      if (!schedule) {
        return addonJson(
          googleWorkspaceNotification(
            "That meeting type is not ready to accept bookings.",
          ),
        );
      }
      const available = await availablePublicSlots(schedule);
      const fresh = createEmailTimeChoices({
        asset,
        available,
        timezone,
        locale,
        choiceCount: 12,
      });
      if (fresh.choices.length === 0) {
        return addonJson(
          googleWorkspaceNotification(
            "No live times are open right now. Insert the booking link instead.",
          ),
        );
      }
      if (action !== "insert_times") {
        return addonJson(
          googleWorkspaceTimePickerCard({
            endpoint: addonEndpoint(),
            asset,
            timeChoices: fresh,
            navigation: action === "choose_times" ? "pushCard" : "updateCard",
          }),
        );
      }

      const revalidated = revalidateEmailTimeSelection({
        choices: fresh.choices,
        selectedStartsAt: googleWorkspaceStringInputs(
          verified.event,
          "selectedStartsAt",
        ),
      });
      if (!revalidated.ok) {
        if (revalidated.reason === "stale_selection") {
          return addonJson(
            googleWorkspaceTimePickerCard({
              endpoint: addonEndpoint(),
              asset,
              timeChoices: fresh,
              navigation: "updateCard",
              notification:
                "Availability changed. Review the refreshed choices before inserting.",
            }),
          );
        }
        return addonJson(
          googleWorkspaceNotification(
            "Choose one to five distinct available times.",
          ),
        );
      }
      await repository
        .rememberEmailToolRecentAsset({
          organizationSlug: identity.organization.slug,
          repId: identity.rep.id,
          purpose: "times",
          assetId: asset.id,
        })
        .catch((error: unknown) => {
          console.error(
            "Gmail recent meeting type could not be saved:",
            error instanceof Error ? error.name : "Unknown error",
          );
        });
      return addonJson(
        googleWorkspaceInsertedCard({
          endpoint: addonEndpoint(),
          content: renderSuggestedTimes({
            asset,
            slots: revalidated.slots,
            timezone: fresh.timezone,
          }),
        }),
      );
    }

    return addonJson(
      googleWorkspaceNotification("That Hot Potato action is not supported."),
    );
  } catch (error) {
    if (error instanceof PublicBodyError) return publicBodyError(error);
    if (error instanceof GoogleWorkspaceAddonVerificationError) {
      return addonJson({ error: error.message }, error.statusCode);
    }
    console.error(
      "Google Workspace add-on request failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return addonJson(
      googleWorkspaceNotification(
        "Hot Potato could not prepare scheduling options. Try again in a moment.",
      ),
    );
  }
}
