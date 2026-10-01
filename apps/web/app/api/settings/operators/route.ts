import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createOperatorAccessToken,
  operatorAccessErrorResponse,
} from "../../../operator-access";
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

const invitationInput = z
  .object({
    login: z.email().max(254),
    displayName: z.string().trim().min(1).max(120),
    role: z.enum(["owner", "admin", "operator"]),
  })
  .strict();

export async function GET(request: Request) {
  const authorization = await operatorAdminForRequest(request);
  if (authorization.response) return authorization.response;
  try {
    const overview = await repository.operatorAccessOverview(
      authorization.identity.organizationSlug,
    );
    return NextResponse.json(
      { ...overview, currentOperatorId: authorization.identity.operatorId },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return operatorAccessErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const authorization = await operatorAdminForRequest(request);
  if (authorization.response) return authorization.response;
  if (!requestHasOperatorOrigin(request)) {
    return NextResponse.json(
      { error: "This invitation request was not accepted." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  let body: unknown;
  try {
    body = await readPublicJson(request, 4_096);
  } catch (error) {
    return publicBodyError(error as PublicBodyError);
  }
  const parsed = invitationInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the invitation." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const access = createOperatorAccessToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    const invitation = await repository.createOperatorInvitation({
      organizationId: authorization.identity.organizationId,
      createdBy: authorization.identity.operatorId,
      login: parsed.data.login.toLowerCase(),
      displayName: parsed.data.displayName,
      role: parsed.data.role,
      tokenHash: access.tokenHash,
      expiresAt,
    });
    return NextResponse.json(
      {
        invitation,
        accessUrl: new URL(`/join/${access.token}`, request.url).toString(),
      },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return operatorAccessErrorResponse(error);
  }
}
