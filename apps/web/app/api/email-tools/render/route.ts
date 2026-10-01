import {
  createEmailTimeChoices,
  revalidateEmailTimeSelection,
  renderBookingLink,
  renderSuggestedTimes,
} from "@hot-potato/email-composer";
import { z } from "zod";
import {
  emailComposerAssets,
  emailToolAccess,
  emailToolCatalogForAccess,
} from "../../../email-tools";
import {
  availablePublicSlots,
  loadPublicSchedule,
} from "../../../public-scheduling";
import {
  enforcePublicRateLimits,
  PublicBodyError,
  publicBodyError,
  publicError,
  publicJson,
  readPublicJson,
} from "../../../public-api";
import { repository } from "../../../repository";

const requestIdentity = {
  assetId: z.uuid(),
  timezone: z.string().trim().min(1).max(100),
  locale: z.string().trim().min(1).max(80).default("en-US"),
};

const renderInput = z.discriminatedUnion("mode", [
  z
    .object({
      ...requestIdentity,
      mode: z.literal("link"),
    })
    .strict(),
  z
    .object({
      ...requestIdentity,
      mode: z.literal("choices"),
    })
    .strict(),
  z
    .object({
      ...requestIdentity,
      mode: z.literal("times"),
      selectedStartsAt: z.array(z.iso.datetime()).min(1).max(5),
    })
    .strict(),
]);

function distinct(values: string[]): boolean {
  return new Set(values).size === values.length;
}

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
          scope: "email_tool_render_key",
          identifier: access.keyId,
          limit: 120,
          windowSeconds: 10 * 60,
        },
      ],
    );
    if (limited) return limited;

    const parsed = renderInput.safeParse(
      await readPublicJson(request, 8 * 1024),
    );
    if (!parsed.success) {
      return publicError(
        422,
        parsed.error.issues[0]?.message ?? "Choose a scheduling link.",
        "invalid_request",
      );
    }
    if (
      parsed.data.mode === "times" &&
      !distinct(parsed.data.selectedStartsAt)
    ) {
      return publicError(
        422,
        "Choose one to five distinct available times.",
        "invalid_selection",
      );
    }
    const catalog = await emailToolCatalogForAccess(access);
    if (!catalog) {
      return publicError(
        403,
        "This representative no longer has access to scheduling links.",
        "access_removed",
      );
    }
    const asset = emailComposerAssets(catalog).find(
      (candidate) => candidate.id === parsed.data.assetId,
    );
    if (!asset) {
      return publicError(
        404,
        "That scheduling link is no longer active.",
        "asset_not_found",
      );
    }

    if (parsed.data.mode === "link") {
      return publicJson({ content: renderBookingLink(asset), slots: [] });
    }
    if (asset.kind !== "meeting_type") {
      return publicError(
        422,
        "Smart Router Links are shared as a single link.",
        "unsupported_mode",
      );
    }

    const schedule = await loadPublicSchedule(
      access.organization.slug,
      asset.slug,
    );
    if (!schedule) {
      return publicError(
        409,
        "This meeting type is not ready to accept bookings.",
        "meeting_not_ready",
      );
    }
    const available = await availablePublicSlots(schedule);
    const fresh = createEmailTimeChoices({
      asset,
      available,
      timezone: parsed.data.timezone,
      locale: parsed.data.locale,
    });
    if (fresh.choices.length === 0) {
      return publicError(
        409,
        "No live times are open right now. Insert the booking link instead.",
        "no_available_times",
      );
    }
    if (parsed.data.mode === "choices") return publicJson(fresh);

    const revalidated = revalidateEmailTimeSelection({
      choices: fresh.choices,
      selectedStartsAt: parsed.data.selectedStartsAt,
    });
    if (!revalidated.ok) {
      if (revalidated.reason === "stale_selection") {
        return publicJson(
          {
            error:
              "Availability changed before insertion. Review the refreshed choices.",
            code: "stale_times",
            ...fresh,
          },
          409,
        );
      }
      return publicError(
        422,
        "Choose one to five distinct available times.",
        "invalid_selection",
      );
    }
    return publicJson({
      content: renderSuggestedTimes({
        asset,
        slots: revalidated.slots,
        timezone: fresh.timezone,
      }),
      slots: revalidated.slots,
      timezone: fresh.timezone,
      locale: fresh.locale,
    });
  } catch (error) {
    if (error instanceof PublicBodyError) return publicBodyError(error);
    if (
      error instanceof Error &&
      (error.message === "Choose a valid timezone." ||
        error.message === "Choose a valid locale.")
    ) {
      return publicError(
        422,
        error.message,
        error.message.includes("timezone")
          ? "invalid_timezone"
          : "invalid_locale",
      );
    }
    console.error(
      "Email tool rendering failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return publicError(
      503,
      "The scheduling options could not be prepared. Please try again.",
      "service_unavailable",
    );
  }
}
