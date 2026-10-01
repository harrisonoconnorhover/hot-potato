import {
  createOAuthPkce,
  createOAuthState,
  providerConfigured,
} from "@hot-potato/integrations";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  parseCalendarProvider,
  hashRepCalendarOAuthState,
  repCalendarCallbackUrl,
  repCalendarManager,
  repCalendarStateCookie,
  repCalendarVerifierCookie,
  repConnectionResultUrl,
} from "../../../../../../connections";
import { operatorRepCalendarForRequest } from "../../../../../../operator-rep-calendar";
import { repository } from "../../../../../../repository";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ repId: string; provider: string }> },
) {
  const { repId, provider: rawProvider } = await context.params;
  const provider = parseCalendarProvider(rawProvider);
  if (!provider) {
    return NextResponse.json(
      { error: "Calendar provider not found." },
      { status: 404 },
    );
  }
  if (!z.uuid().safeParse(repId).success) {
    return NextResponse.json(
      { error: "Check the representative identifier." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const authorization = await operatorRepCalendarForRequest(
    request,
    repId,
    true,
  );
  if (authorization.response) return authorization.response;
  const returnTo =
    request.nextUrl.searchParams.get("returnTo") === "my-calendar"
      ? "my-calendar"
      : "calendar-readiness";

  if (!providerConfigured(provider)) {
    return NextResponse.redirect(
      repConnectionResultUrl(request, provider, "missing-config", returnTo),
      { status: 303 },
    );
  }
  const state = createOAuthState();
  const pkce = createOAuthPkce();
  const redirectUri = repCalendarCallbackUrl(request, provider);
  const authorizationUrl = repCalendarManager().authorizationUrl(provider, {
    state,
    redirectUri,
    codeChallenge: pkce.challenge,
  });
  try {
    await repository.createRepCalendarOAuthAttempt({
      organizationId: authorization.identity.organizationId,
      operatorId: authorization.identity.operatorId,
      repId,
      provider,
      stateHash: hashRepCalendarOAuthState(state),
      returnTo,
      expiresAt: new Date(Date.now() + 10 * 60 * 1_000),
    });
  } catch (error) {
    console.error(
      "Representative calendar OAuth start failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return NextResponse.json(
      { error: "The calendar connection could not be started." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const response = NextResponse.redirect(authorizationUrl, { status: 303 });
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  const cookie = {
    httpOnly: true,
    secure: redirectUri.startsWith("https://"),
    sameSite: "lax" as const,
    maxAge: 10 * 60,
    path: "/",
  };
  response.cookies.set(repCalendarStateCookie(provider), state, cookie);
  response.cookies.set(
    repCalendarVerifierCookie(provider),
    pkce.verifier,
    cookie,
  );
  return response;
}
