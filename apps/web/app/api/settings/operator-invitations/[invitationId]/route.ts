import { NextResponse } from "next/server";
import { z } from "zod";
import { operatorAccessErrorResponse } from "../../../../operator-access";
import {
  operatorAdminForRequest,
  requestHasOperatorOrigin,
} from "../../../../operator-session";
import { repository } from "../../../../repository";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ invitationId: string }> },
) {
  const authorization = await operatorAdminForRequest(request);
  if (authorization.response) return authorization.response;
  if (!requestHasOperatorOrigin(request)) {
    return NextResponse.json(
      { error: "This invitation update was not accepted." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  const invitationId = z.uuid().safeParse((await context.params).invitationId);
  if (!invitationId.success) {
    return NextResponse.json(
      { error: "Invitation not found." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    await repository.revokeOperatorInvitation({
      organizationId: authorization.identity.organizationId,
      revokedBy: authorization.identity.operatorId,
      invitationId: invitationId.data,
    });
    return NextResponse.json(
      { revoked: true },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return operatorAccessErrorResponse(error);
  }
}
