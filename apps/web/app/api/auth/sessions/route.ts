import { NextResponse } from "next/server";
import { operatorSessionForRequest } from "../../../operator-session";
import { repository } from "../../../repository";

export async function GET(request: Request) {
  const identity = await operatorSessionForRequest(request);
  if (!identity) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const sessions = await repository.listOperatorSessions({
      organizationId: identity.organizationId,
      operatorId: identity.operatorId,
    });
    return NextResponse.json(
      { sessions, currentSessionId: identity.sessionId },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error(
      "Operator sessions could not be listed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return NextResponse.json(
      { error: "Active sessions are temporarily unavailable." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
