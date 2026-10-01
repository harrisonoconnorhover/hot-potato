import { createHash, randomBytes } from "node:crypto";
import type { OperatorRole, OperatorSessionIdentity } from "@hot-potato/db";
import { NextResponse } from "next/server";
import { repository } from "./repository";

export const operatorSessionCookieName = "hp_operator_session";
export const operatorSessionLifetimeSeconds = 7 * 24 * 60 * 60;
const operatorSessionPattern = /^hp_session_[A-Za-z0-9_-]{43}$/;

function organizationSlug(): string {
  return process.env.HOT_POTATO_ORG ?? "acme";
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}

export function hashOperatorSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createOperatorSessionToken(): {
  token: string;
  tokenHash: string;
} {
  const token = `hp_session_${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashOperatorSessionToken(token) };
}

export function operatorSessionToken(request: Request): string | null {
  const token = cookieValue(request, operatorSessionCookieName);
  return token && operatorSessionPattern.test(token) ? token : null;
}

export async function operatorSessionForRequest(
  request: Request,
): Promise<OperatorSessionIdentity | null> {
  const token = operatorSessionToken(request);
  if (!token) return null;
  return repository.resolveOperatorSession(
    organizationSlug(),
    hashOperatorSessionToken(token),
  );
}

export function operatorRoleCanAdmin(role: OperatorRole): boolean {
  return role === "owner" || role === "admin";
}

export async function operatorAdminForRequest(
  request: Request,
): Promise<
  | { identity: OperatorSessionIdentity; response?: never }
  | { identity?: never; response: NextResponse }
> {
  const identity = await operatorSessionForRequest(request);
  if (!identity) {
    return {
      response: NextResponse.json(
        { error: "Authentication required." },
        { status: 401, headers: { "cache-control": "no-store" } },
      ),
    };
  }
  if (!operatorRoleCanAdmin(identity.role)) {
    return {
      response: NextResponse.json(
        { error: "Administrator access is required." },
        { status: 403, headers: { "cache-control": "no-store" } },
      ),
    };
  }
  return { identity };
}

export async function operatorAdminError(
  request: Request,
): Promise<NextResponse | null> {
  const authorization = await operatorAdminForRequest(request);
  return authorization.response ?? null;
}

export function operatorSessionCookieOptions(request?: Request) {
  const appUrl = new URL(
    process.env.APP_URL?.trim() || "http://localhost:3000",
  );
  const requestUsesHttps = request
    ? new URL(request.url).protocol === "https:"
    : false;
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: appUrl.protocol === "https:" || requestUsesHttps,
    path: "/",
    maxAge: operatorSessionLifetimeSeconds,
    priority: "high" as const,
  };
}

export function requestHasOperatorOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const actual = new URL(origin).origin;
    const expected = new URL(
      process.env.APP_URL?.trim() || "http://localhost:3000",
    ).origin;
    return actual === expected || actual === new URL(request.url).origin;
  } catch {
    return false;
  }
}
