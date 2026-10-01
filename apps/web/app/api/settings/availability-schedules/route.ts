import type { OperatorSessionIdentity } from "@hot-potato/db";
import { NextResponse } from "next/server";
import {
  operatorAdminForRequest,
  requestHasOperatorOrigin,
} from "../../../operator-session";
import {
  publicBodyError,
  readPublicJson,
  type PublicBodyError,
} from "../../../public-api";
import { repository } from "../../../repository";
import {
  availabilityScheduleDeleteSchema,
  availabilityScheduleInputSchema,
} from "../../../working-hours";

const noStoreHeaders = { "cache-control": "no-store" };

function json(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: noStoreHeaders });
}

async function authorizedBody(
  request: Request,
): Promise<
  | { identity: OperatorSessionIdentity; body: unknown }
  | { response: NextResponse }
> {
  const authorization = await operatorAdminForRequest(request);
  if (authorization.response) return { response: authorization.response };
  if (!requestHasOperatorOrigin(request)) {
    return {
      response: json(
        { error: "This availability-schedule update was not accepted." },
        403,
      ),
    };
  }
  try {
    return {
      identity: authorization.identity,
      body: await readPublicJson(request, 16 * 1_024),
    };
  } catch (error) {
    return { response: publicBodyError(error as PublicBodyError) };
  }
}

export async function PUT(request: Request) {
  const authorized = await authorizedBody(request);
  if ("response" in authorized) return authorized.response;
  const parsed = availabilityScheduleInputSchema.safeParse(authorized.body);
  if (!parsed.success) {
    return json(
      {
        error:
          parsed.error.issues[0]?.message ??
          "Check the reusable availability schedule.",
      },
      400,
    );
  }
  try {
    const id = await repository.saveAvailabilitySchedule({
      organizationId: authorized.identity.organizationId,
      operatorId: authorized.identity.operatorId,
      ...parsed.data,
    });
    if (!id) {
      return json(
        { error: "You no longer have access to manage reusable schedules." },
        403,
      );
    }
    return json({ id });
  } catch (error) {
    const conflict =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505";
    return json(
      {
        error: conflict
          ? "A reusable schedule already has that name."
          : "The reusable schedule could not be saved.",
      },
      conflict ? 409 : 500,
    );
  }
}

export async function DELETE(request: Request) {
  const authorized = await authorizedBody(request);
  if ("response" in authorized) return authorized.response;
  const parsed = availabilityScheduleDeleteSchema.safeParse(authorized.body);
  if (!parsed.success) {
    return json({ error: "Choose a reusable schedule to remove." }, 400);
  }
  try {
    const deleted = await repository.deleteAvailabilitySchedule({
      organizationId: authorized.identity.organizationId,
      operatorId: authorized.identity.operatorId,
      id: parsed.data.id,
    });
    if (!deleted) {
      return json(
        { error: "You no longer have access to remove that schedule." },
        403,
      );
    }
    return json({ deleted: true });
  } catch (error) {
    console.error(
      "Availability-schedule delete failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return json({ error: "The reusable schedule could not be removed." }, 500);
  }
}
