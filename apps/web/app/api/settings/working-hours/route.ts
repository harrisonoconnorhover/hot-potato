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
import { workingHoursInputSchema } from "../../../working-hours";

const noStoreHeaders = { "cache-control": "no-store" };

function json(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: noStoreHeaders });
}

export async function PUT(request: Request) {
  const authorization = await operatorAdminForRequest(request);
  if (authorization.response) return authorization.response;
  if (!requestHasOperatorOrigin(request)) {
    return json({ error: "This working-hours update was not accepted." }, 403);
  }

  let body: unknown;
  try {
    body = await readPublicJson(request, 32 * 1_024);
  } catch (error) {
    return publicBodyError(error as PublicBodyError);
  }
  const parsed = workingHoursInputSchema.safeParse(body);
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
      "Working-hours update failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return json({ error: "Working hours could not be saved." }, 500);
  }
}
