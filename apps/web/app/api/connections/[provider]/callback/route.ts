import { oauthStatesEqual } from "@hot-potato/integrations";
import { type NextRequest, NextResponse } from "next/server";
import {
  callbackUrl,
  connectionManager,
  connectionResultUrl,
  parseProvider,
  stateCookieName,
} from "../../../../connections";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
) {
  const provider = parseProvider((await context.params).provider);
  if (!provider) {
    return NextResponse.json({ error: "Unknown provider." }, { status: 404 });
  }

  const state = request.nextUrl.searchParams.get("state") ?? "";
  const expectedState =
    request.cookies.get(stateCookieName(provider))?.value ?? "";
  const code = request.nextUrl.searchParams.get("code");
  const providerError = request.nextUrl.searchParams.get("error");
  let status = "connected";

  if (!state || !expectedState || !oauthStatesEqual(state, expectedState)) {
    status = "invalid-state";
  } else if (providerError || !code) {
    status = "denied";
  } else {
    try {
      await connectionManager().connect(
        process.env.HOT_POTATO_ORG ?? "acme",
        provider,
        { code, redirectUri: callbackUrl(request, provider) },
      );
    } catch (error) {
      console.error(
        `${provider} OAuth callback failed:`,
        error instanceof Error ? error.message : "Unknown error",
      );
      status = "failed";
    }
  }

  const response = NextResponse.redirect(
    connectionResultUrl(request, provider, status),
    { status: 303 },
  );
  response.cookies.delete(stateCookieName(provider));
  return response;
}
