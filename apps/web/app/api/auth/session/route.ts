import { NextResponse } from "next/server";
import { operatorSessionForRequest } from "../../../operator-session";

export async function GET(request: Request) {
  const identity = await operatorSessionForRequest(request);
  if (!identity) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  return NextResponse.json(
    {
      operator: {
        displayName: identity.displayName,
        login: identity.login,
        role: identity.role,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
