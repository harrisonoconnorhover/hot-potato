import { hashOperatorPassword, verifyOperatorPassword } from "@hot-potato/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  operatorSessionForRequest,
  requestHasOperatorOrigin,
} from "../../../operator-session";
import {
  enforcePublicRateLimits,
  publicBodyError,
  readPublicJson,
  type PublicBodyError,
} from "../../../public-api";
import { repository } from "../../../repository";

const passwordInput = z
  .object({
    currentPassword: z.string().min(1).max(1_024),
    newPassword: z.string().min(12).max(1_024),
  })
  .strict();

export async function POST(request: Request) {
  const identity = await operatorSessionForRequest(request);
  if (!identity) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  if (!requestHasOperatorOrigin(request)) {
    return NextResponse.json(
      { error: "This password change was not accepted." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  let body: unknown;
  try {
    body = await readPublicJson(request, 4_096);
  } catch (error) {
    return publicBodyError(error as PublicBodyError);
  }
  const parsed = passwordInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Use a new password of at least 12 characters." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const limited = await enforcePublicRateLimits(
      repository,
      identity.organizationSlug,
      [
        {
          scope: "operator.password.operator",
          identifier: identity.operatorId,
          limit: 8,
          windowSeconds: 900,
        },
      ],
    );
    if (limited) return limited;
    const credential = await repository.operatorCredential(
      identity.organizationSlug,
      identity.login,
    );
    const currentMatches = credential
      ? await verifyOperatorPassword(
          parsed.data.currentPassword,
          credential.passwordHash,
        )
      : false;
    if (!credential || !currentMatches) {
      return NextResponse.json(
        { error: "The current password was not recognized." },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    if (
      await verifyOperatorPassword(
        parsed.data.newPassword,
        credential.passwordHash,
      )
    ) {
      return NextResponse.json(
        { error: "Choose a password you are not already using." },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    const passwordHash = await hashOperatorPassword(parsed.data.newPassword);
    const updated = await repository.updateOperatorPassword({
      organizationId: identity.organizationId,
      operatorId: identity.operatorId,
      currentSessionId: identity.sessionId,
      expectedPasswordHash: credential.passwordHash,
      passwordHash,
    });
    if (!updated) {
      return NextResponse.json(
        {
          error:
            "Your account changed in another session. Reload and try again.",
        },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }
    return NextResponse.json(
      { updated: true, otherSessionsRevoked: true },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error(
      "Operator password change failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return NextResponse.json(
      { error: "The password could not be changed right now." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
