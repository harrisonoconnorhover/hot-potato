import type { CalendarOAuthProvider } from "@hot-potato/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { parseCalendarProvider } from "../../../../../../connections";
import { operatorRepCalendarForRequest } from "../../../../../../operator-rep-calendar";
import { PublicBodyError, readPublicJson } from "../../../../../../public-api";
import {
  repCalendarCatalogFailure,
  repCalendarCatalogSettings,
  syncRepCalendarCatalog,
} from "../../../../../../rep-calendar-catalog";
import { repository } from "../../../../../../repository";

const noStoreHeaders = { "cache-control": "no-store" };
const calendarIdentifier = z
  .string()
  .min(1, "Calendar identifiers cannot be empty.")
  .max(1_024, "Calendar identifiers cannot exceed 1,024 characters.")
  .regex(
    /^[^\u0000-\u001f\u007f]+$/u,
    "Calendar identifiers must contain printable characters.",
  );
const calendarSettings = z
  .object({
    selectedCalendarIds: z
      .array(calendarIdentifier)
      .max(50, "Select no more than 50 calendars.")
      .optional(),
    checkConflicts: z.boolean().optional(),
    makeActive: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.selectedCalendarIds === undefined &&
      value.checkConflicts === undefined &&
      value.makeActive !== true
    ) {
      context.addIssue({
        code: "custom",
        message: "Choose a calendar setting to update.",
      });
    }
    if (
      value.selectedCalendarIds !== undefined &&
      value.checkConflicts !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Use selectedCalendarIds instead of the provider-level conflict setting.",
      });
    }
    if (
      value.selectedCalendarIds &&
      new Set(value.selectedCalendarIds).size !==
        value.selectedCalendarIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedCalendarIds"],
        message: "Select each calendar only once.",
      });
    }
  });

type RouteContext = {
  params: Promise<{ repId: string; provider: string }>;
};

type CalendarRouteParameters =
  | {
      ok: true;
      organizationSlug: string;
      repId: string;
      provider: CalendarOAuthProvider;
    }
  | { ok: false; response: NextResponse };

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: noStoreHeaders,
  });
}

async function calendarRouteParameters(
  request: Request,
  context: RouteContext,
  requireOrigin = false,
): Promise<CalendarRouteParameters> {
  const { repId, provider: providerValue } = await context.params;
  const provider = parseCalendarProvider(providerValue);
  if (!provider) {
    return {
      ok: false,
      response: json({ error: "Calendar provider not found." }, 404),
    };
  }
  const parsedId = z.uuid().safeParse(repId);
  if (!parsedId.success) {
    return {
      ok: false,
      response: json({ error: "Check the representative identifier." }, 400),
    };
  }
  const authorization = await operatorRepCalendarForRequest(
    request,
    parsedId.data,
    requireOrigin,
  );
  if (authorization.response) {
    return { ok: false, response: authorization.response };
  }
  return {
    ok: true,
    organizationSlug: authorization.identity.organizationSlug,
    repId: parsedId.data,
    provider,
  };
}

function catalogErrorResponse(error: unknown): NextResponse {
  const failure = repCalendarCatalogFailure(error);
  if (failure) return json(failure.body, failure.status);
  console.error("Calendar catalog request failed.");
  return json({ error: "The calendar settings could not be loaded." }, 500);
}

function settingsUpdateErrorResponse(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : "";
  const normalized = message.toLowerCase();
  if (normalized.includes("not found")) {
    return json({ error: "Calendar connection not found." }, 404);
  }

  const conflict =
    message === "The active calendar must be checked for conflicts." ||
    message === "The calendar connection has no default calendar." ||
    message ===
      "Refresh or reconnect this provider before using it for bookings.";
  if (conflict) return json({ error: message }, 409);

  const validation =
    message ===
      "Use selectedCalendarIds instead of the provider-level conflict setting." ||
    message.startsWith("Select no more than ") ||
    message === "One or more selected calendars are not available." ||
    message === "A missing calendar cannot be newly selected." ||
    message === "Calendar identifiers must be 1–1024 printable characters.";
  if (validation) return json({ error: message }, 400);

  console.error("Calendar settings update failed.");
  return json({ error: "The calendar settings could not be saved." }, 500);
}

export async function GET(request: Request, context: RouteContext) {
  const parameters = await calendarRouteParameters(request, context);
  if (!parameters.ok) return parameters.response;
  const input = {
    organizationSlug: parameters.organizationSlug,
    repId: parameters.repId,
    provider: parameters.provider,
  };
  try {
    return json(await repCalendarCatalogSettings(input));
  } catch (error) {
    return catalogErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const parameters = await calendarRouteParameters(request, context, true);
  if (!parameters.ok) return parameters.response;
  const input = {
    organizationSlug: parameters.organizationSlug,
    repId: parameters.repId,
    provider: parameters.provider,
  };
  try {
    return json(await syncRepCalendarCatalog(input));
  } catch (error) {
    return catalogErrorResponse(error);
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const parameters = await calendarRouteParameters(request, context, true);
  if (!parameters.ok) return parameters.response;
  const input = {
    organizationSlug: parameters.organizationSlug,
    repId: parameters.repId,
    provider: parameters.provider,
  };
  let body: unknown;
  try {
    body = await readPublicJson(request, 8 * 1_024);
  } catch (error) {
    if (error instanceof PublicBodyError) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: "Check the calendar settings." }, 400);
  }
  const parsed = calendarSettings.safeParse(body);
  if (!parsed.success) {
    return json(
      {
        error:
          parsed.error.issues[0]?.message ??
          "Check the representative and calendar settings.",
      },
      400,
    );
  }

  try {
    await repository.updateRepCalendarSettings({
      ...input,
      ...parsed.data,
    });
    return json(await repCalendarCatalogSettings(input));
  } catch (error) {
    const catalogFailure = repCalendarCatalogFailure(error);
    if (catalogFailure) return json(catalogFailure.body, catalogFailure.status);
    return settingsUpdateErrorResponse(error);
  }
}
