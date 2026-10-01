import {
  createOAuthPkce,
  createOAuthState,
  providerConfigured,
} from "@hot-potato/integrations";
import { type NextRequest, NextResponse } from "next/server";
import {
  callbackUrl,
  codeVerifierCookieName,
  connectionManager,
  connectionResultUrl,
  parseProvider,
  stateCookieName,
} from "../../../../connections";
import { operatorAdminError } from "../../../../operator-session";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
) {
  const denied = await operatorAdminError(request);
  if (denied) return denied;
  const provider = parseProvider((await context.params).provider);
  if (!provider) {
    return NextResponse.json({ error: "Unknown provider." }, { status: 404 });
  }

  if (!providerConfigured(provider)) {
    return NextResponse.redirect(
      connectionResultUrl(request, provider, "missing-config"),
      { status: 303 },
    );
  }
  const state = createOAuthState();
  const pkce = provider === "microsoft" ? createOAuthPkce() : null;
  const redirectUri = callbackUrl(request, provider);
  const authorizationUrl = connectionManager().authorizationUrl(provider, {
    state,
    redirectUri,
    codeChallenge: pkce?.challenge,
  });
  const response = NextResponse.redirect(authorizationUrl, { status: 303 });
  response.cookies.set(stateCookieName(provider), state, {
    httpOnly: true,
    secure: redirectUri.startsWith("https://"),
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/",
  });
  if (pkce) {
    response.cookies.set(codeVerifierCookieName(provider), pkce.verifier, {
      httpOnly: true,
      secure: redirectUri.startsWith("https://"),
      sameSite: "lax",
      maxAge: 10 * 60,
      path: "/",
    });
  }
  return response;
}
