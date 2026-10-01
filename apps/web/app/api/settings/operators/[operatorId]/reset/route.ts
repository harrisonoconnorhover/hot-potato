import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createOperatorAccessToken,
  operatorAccessErrorResponse,
} from "../../../../../operator-access";
import {
  operatorAdminForRequest,
  requestHasOperatorOrigin,
} from "../../../../../operator-session";
import { repository } from "../../../../../repository";

export async function POST(
  request: Request,
  context: { params: Promise<{ operatorId: string }> },
) {
  const authorization = await operatorAdminForRequest(request);
  if (authorization.response) return authorization.response;
  if (!requestHasOperatorOrigin(request)) {
    return NextResponse.json(
      { error: "This password-reset request was not accepted." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  const operatorId = z.uuid().safeParse((await context.params).operatorId);
  if (!operatorId.success) {
    return NextResponse.json(
      { error: "Member not found." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const access = createOperatorAccessToken();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1_000);
    const reset = await repository.createOperatorPasswordReset({
      organizationId: authorization.identity.organizationId,
      createdBy: authorization.identity.operatorId,
      operatorId: operatorId.data,
      tokenHash: access.tokenHash,
      expiresAt,
    });
    return NextResponse.json(
      {
        reset,
        accessUrl: new URL(`/join/${access.token}`, request.url).toString(),
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return operatorAccessErrorResponse(error);
  }
}
