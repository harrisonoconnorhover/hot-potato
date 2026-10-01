import { NextResponse } from "next/server";
import { z } from "zod";
import { operatorAccessErrorResponse } from "../../../../operator-access";
import {
  operatorAdminForRequest,
  requestHasOperatorOrigin,
} from "../../../../operator-session";
import {
  publicBodyError,
  readPublicJson,
  type PublicBodyError,
} from "../../../../public-api";
import { repository } from "../../../../repository";

const updateInput = z
  .object({
    role: z.enum(["owner", "admin", "operator"]).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.role !== undefined || value.active !== undefined, {
    message: "Choose a role or account-status change.",
  });

export async function PATCH(
  request: Request,
  context: { params: Promise<{ operatorId: string }> },
) {
  const authorization = await operatorAdminForRequest(request);
  if (authorization.response) return authorization.response;
  if (!requestHasOperatorOrigin(request)) {
    return NextResponse.json(
      { error: "This member update was not accepted." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  let body: unknown;
  try {
    body = await readPublicJson(request, 4_096);
  } catch (error) {
    return publicBodyError(error as PublicBodyError);
  }
  const parsed = updateInput.safeParse(body);
  const operatorId = z.uuid().safeParse((await context.params).operatorId);
  if (!parsed.success || !operatorId.success) {
    return NextResponse.json(
      {
        error: parsed.success
          ? "Member not found."
          : (parsed.error.issues[0]?.message ?? "Check the member update."),
      },
      {
        status: operatorId.success ? 400 : 404,
        headers: { "cache-control": "no-store" },
      },
    );
  }
  try {
    await repository.updateOperatorMembership({
      organizationId: authorization.identity.organizationId,
      updatedBy: authorization.identity.operatorId,
      operatorId: operatorId.data,
      ...parsed.data,
    });
    return NextResponse.json(
      { updated: true },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return operatorAccessErrorResponse(error);
  }
}
