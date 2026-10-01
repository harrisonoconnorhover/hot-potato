import { hashOperatorPassword } from "@hot-potato/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  hashOperatorAccessToken,
  operatorAccessErrorResponse,
  operatorAccessTokenPattern,
} from "../../../operator-access";
import {
  createOperatorSessionToken,
  operatorSessionCookieName,
  operatorSessionCookieOptions,
  operatorSessionLifetimeSeconds,
  requestHasOperatorOrigin,
} from "../../../operator-session";
import {
  enforcePublicRateLimits,
  publicBodyError,
  publicClientAddress,
  publicError,
  readPublicJson,
  type PublicBodyError,
} from "../../../public-api";
import { repository } from "../../../repository";

const accessInput = z
  .object({
    token: z.string().regex(operatorAccessTokenPattern),
    password: z.string().min(12).max(1_024),
  })
  .strict();

export async function POST(request: Request) {
  if (!requestHasOperatorOrigin(request)) {
    return publicError(403, "This access request was not accepted.", "origin");
  }
  let body: unknown;
  try {
    body = await readPublicJson(request, 4_096);
  } catch (error) {
    return publicBodyError(error as PublicBodyError);
  }
  const parsed = accessInput.safeParse(body);
  if (!parsed.success) {
    return publicError(
      400,
      "Use the valid access link and a password of at least 12 characters.",
      "invalid_access",
    );
  }
  const organizationSlug = process.env.HOT_POTATO_ORG ?? "acme";
  const tokenHash = hashOperatorAccessToken(parsed.data.token);
  try {
    const limited = await enforcePublicRateLimits(
      repository,
      organizationSlug,
      [
        {
          scope: "operator.access.ip",
          identifier: publicClientAddress(request),
          limit: 20,
          windowSeconds: 900,
        },
        {
          scope: "operator.access.token",
          identifier: tokenHash,
          limit: 10,
          windowSeconds: 900,
        },
      ],
    );
    if (limited) return limited;
    const session = createOperatorSessionToken();
    const expiresAt = new Date(
      Date.now() + operatorSessionLifetimeSeconds * 1_000,
    );
    const passwordHash = await hashOperatorPassword(parsed.data.password);
    const credential = await repository.consumeOperatorAccessLink({
      organizationSlug,
      tokenHash,
      passwordHash,
      session: {
        tokenHash: session.tokenHash,
        expiresAt,
        userAgent: request.headers.get("user-agent"),
      },
    });
    const response = NextResponse.json(
      {
        operator: {
          displayName: credential.displayName,
          login: credential.login,
          role: credential.role,
        },
      },
      { headers: { "cache-control": "no-store" } },
    );
    response.cookies.set(
      operatorSessionCookieName,
      session.token,
      operatorSessionCookieOptions(request),
    );
    return response;
  } catch (error) {
    return operatorAccessErrorResponse(error);
  }
}
