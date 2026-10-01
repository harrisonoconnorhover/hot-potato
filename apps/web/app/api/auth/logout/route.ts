import { NextResponse } from "next/server";
import {
  hashOperatorSessionToken,
  operatorSessionCookieName,
  operatorSessionCookieOptions,
  operatorSessionToken,
  requestHasOperatorOrigin,
} from "../../../operator-session";
import { repository } from "../../../repository";

export async function POST(request: Request) {
  if (!requestHasOperatorOrigin(request)) {
    return NextResponse.json(
      { error: "This logout request was not accepted." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  const token = operatorSessionToken(request);
  if (token) {
    try {
      await repository.revokeOperatorSession(hashOperatorSessionToken(token));
    } catch (error) {
      console.error(
        "Operator session revocation failed:",
        error instanceof Error ? error.name : "Unknown error",
      );
    }
  }
  const response = NextResponse.json(
    { signedOut: true },
    { headers: { "cache-control": "no-store" } },
  );
  response.cookies.set(operatorSessionCookieName, "", {
    ...operatorSessionCookieOptions(request),
    maxAge: 0,
  });
  return response;
}
