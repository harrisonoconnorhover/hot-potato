import { NextResponse } from "next/server";
import { z } from "zod";
import {
  operatorSessionForRequest,
  requestHasOperatorOrigin,
} from "../../../../operator-session";
import { repository } from "../../../../repository";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ sessionId: string }> },
) {
  const identity = await operatorSessionForRequest(request);
  if (!identity) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  if (!requestHasOperatorOrigin(request)) {
    return NextResponse.json(
      { error: "This session update was not accepted." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  const sessionId = z.uuid().safeParse((await context.params).sessionId);
  if (!sessionId.success || sessionId.data === identity.sessionId) {
    return NextResponse.json(
      {
        error: sessionId.success
          ? "Use Sign out to end this session."
          : "Session not found.",
      },
      {
        status: sessionId.success ? 400 : 404,
        headers: { "cache-control": "no-store" },
      },
    );
  }
  try {
    const revoked = await repository.revokeOperatorSessionById({
      organizationId: identity.organizationId,
      operatorId: identity.operatorId,
      sessionId: sessionId.data,
      currentSessionId: identity.sessionId,
    });
    return NextResponse.json(
      { revoked },
      {
        status: revoked ? 200 : 404,
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (error) {
    console.error(
      "Operator session could not be revoked:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return NextResponse.json(
      { error: "The session could not be revoked right now." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
