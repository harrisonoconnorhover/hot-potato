import { NextResponse } from "next/server";
import { z } from "zod";
import { operatorRepCalendarForRequest } from "../../../../../operator-rep-calendar";
import {
  publicBodyError,
  readPublicJson,
  type PublicBodyError,
} from "../../../../../public-api";
import { repository } from "../../../../../repository";
import { workingHoursSettingsSchema } from "../../../../../working-hours";

const noStoreHeaders = { "cache-control": "no-store" };

function json(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: noStoreHeaders });
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ repId: string }> },
) {
  const repId = z.uuid().safeParse((await context.params).repId);
  if (!repId.success) {
    return json({ error: "Representative not found." }, 404);
  }
  const authorization = await operatorRepCalendarForRequest(
    request,
    repId.data,
    true,
  );
  if (authorization.response) return authorization.response;

  let body: unknown;
  try {
    body = await readPublicJson(request, 32 * 1_024);
  } catch (error) {
    return publicBodyError(error as PublicBodyError);
  }
  const parsed = workingHoursSettingsSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      {
        error:
          parsed.error.issues[0]?.message ??
          "Check the working-hours settings.",
      },
      400,
    );
  }

  try {
    const updated = await repository.updateOperatorRepWorkingHours({
      organizationId: authorization.identity.organizationId,
      operatorId: authorization.identity.operatorId,
      repId: repId.data,
      ...parsed.data,
    });
    if (!updated) {
      return json(
        { error: "You no longer have access to update these working hours." },
        403,
      );
    }
    return json({ saved: true });
  } catch (error) {
    console.error(
      "Personal working-hours update failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return json({ error: "Working hours could not be saved." }, 500);
  }
}
