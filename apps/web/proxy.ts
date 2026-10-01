import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  operatorRoleCanAdmin,
  operatorSessionForRequest,
} from "./app/operator-session";

function isPublicOAuthCallback(pathname: string): boolean {
  return /^\/api\/connections\/(hubspot|google|microsoft)\/callback$/.test(
    pathname,
  );
}

function requiresAdmin(pathname: string): boolean {
  if (
    /^\/api\/reps\/[0-9a-f-]+\/connections\/(google|microsoft)\/start$/.test(
      pathname,
    ) ||
    /^\/api\/settings\/reps\/[0-9a-f-]+\/calendars\/(google|microsoft)$/.test(
      pathname,
    ) ||
    /^\/api\/settings\/reps\/[0-9a-f-]+\/working-hours$/.test(pathname)
  ) {
    return false;
  }
  return (
    pathname === "/api/settings" ||
    pathname.startsWith("/api/settings/") ||
    pathname === "/api/connections" ||
    pathname.startsWith("/api/connections/") ||
    pathname === "/api/reps" ||
    pathname.startsWith("/api/reps/")
  );
}

function apiError(status: 401 | 403 | 503, error: string) {
  return NextResponse.json(
    { error },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (isPublicOAuthCallback(pathname)) return NextResponse.next();

  try {
    const identity = await operatorSessionForRequest(request);
    if (!identity) {
      if (pathname.startsWith("/api/")) {
        return apiError(401, "Authentication required.");
      }
      const login = new URL("/login", request.url);
      login.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
      return NextResponse.redirect(login);
    }
    if (requiresAdmin(pathname) && !operatorRoleCanAdmin(identity.role)) {
      return apiError(403, "Administrator access is required.");
    }
    return NextResponse.next();
  } catch (error) {
    console.error(
      "Operator session validation failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return apiError(503, "Operator authentication is temporarily unavailable.");
  }
}

export const config = {
  matcher: [
    "/",
    "/api/auth/session",
    "/api/auth/password",
    "/api/auth/sessions/:path*",
    "/api/me/:path*",
    "/api/dashboard",
    "/api/connections/:path*",
    "/api/reps/:path*",
    "/api/settings/:path*",
    "/api/route",
    "/api/bookings/:path*",
    "/api/handoff/:path*",
    "/api/reporting/:path*",
  ],
};
