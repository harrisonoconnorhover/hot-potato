import { hashOperatorPassword, verifyOperatorPassword } from "@hot-potato/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  enforcePublicRateLimits,
  publicBodyError,
  publicClientAddress,
  publicError,
  readPublicJson,
  type PublicBodyError,
} from "../../../public-api";
import {
  createOperatorSessionToken,
  operatorSessionCookieName,
  operatorSessionCookieOptions,
  operatorSessionLifetimeSeconds,
  requestHasOperatorOrigin,
} from "../../../operator-session";
import { repository } from "../../../repository";

const loginInput = z
  .object({
    login: z.string().trim().min(3).max(254),
    password: z.string().min(1).max(1_024),
  })
  .strict();

export async function POST(request: Request) {
  if (!requestHasOperatorOrigin(request)) {
    return publicError(403, "This login request was not accepted.", "origin");
  }
  let input: unknown;
  try {
    input = await readPublicJson(request, 4_096);
  } catch (error) {
    return publicBodyError(error as PublicBodyError);
  }
  const parsed = loginInput.safeParse(input);
  if (!parsed.success) {
    return publicError(
      400,
      "Enter your login and password.",
      "invalid_credentials",
    );
  }

  const organizationSlug = process.env.HOT_POTATO_ORG ?? "acme";
  const normalizedLogin = parsed.data.login.toLowerCase();
  try {
    const limited = await enforcePublicRateLimits(
      repository,
      organizationSlug,
      [
        {
          scope: "operator.login.ip",
          identifier: publicClientAddress(request),
          limit: 20,
          windowSeconds: 900,
        },
        {
          scope: "operator.login.account",
          identifier: normalizedLogin,
          limit: 10,
          windowSeconds: 900,
        },
      ],
    );
    if (limited) return limited;

    const credential = await repository.operatorCredential(
      organizationSlug,
      normalizedLogin,
    );
    const matches = credential
      ? await verifyOperatorPassword(
          parsed.data.password,
          credential.passwordHash,
        )
      : (await hashOperatorPassword("hot-potato-dummy-credential"), false);
    if (!credential || !matches) {
      return publicError(
        401,
        "The login or password was not recognized.",
        "invalid_credentials",
      );
    }

    const session = createOperatorSessionToken();
    const expiresAt = new Date(
      Date.now() + operatorSessionLifetimeSeconds * 1_000,
    );
    const created = await repository.createOperatorSession({
      organizationId: credential.organizationId,
      operatorId: credential.operatorId,
      tokenHash: session.tokenHash,
      expiresAt,
      userAgent: request.headers.get("user-agent"),
    });
    if (!created) throw new Error("Operator session was not created.");

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
    console.error(
      "Operator login failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return publicError(
      503,
      "Operator login is temporarily unavailable.",
      "unavailable",
    );
  }
}
