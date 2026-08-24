import {
  createOAuthState,
  providerConfigured,
  setupSecretMatches,
} from "@hot-potato/integrations";
import { type NextRequest, NextResponse } from "next/server";
import {
  callbackUrl,
  connectionManager,
  connectionResultUrl,
  parseProvider,
  stateCookieName,
} from "../../../../connections";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
) {
  const provider = parseProvider((await context.params).provider);
  if (!provider) {
    return NextResponse.json({ error: "Unknown provider." }, { status: 404 });
  }

  const form = await request.formData();
  const setupSecret = String(form.get("setupSecret") ?? "");
  if (!providerConfigured(provider)) {
    return NextResponse.redirect(
      connectionResultUrl(request, provider, "missing-config"),
      { status: 303 },
    );
  }
  if (!setupSecretMatches(setupSecret)) {
    return NextResponse.redirect(
      connectionResultUrl(request, provider, "setup-denied"),
      { status: 303 },
    );
  }

  const state = createOAuthState();
  const redirectUri = callbackUrl(request, provider);
  const authorizationUrl = connectionManager().authorizationUrl(provider, {
    state,
    redirectUri,
  });
  const response = NextResponse.redirect(authorizationUrl, { status: 303 });
  response.cookies.set(stateCookieName(provider), state, {
    httpOnly: true,
    secure: redirectUri.startsWith("https://"),
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/",
  });
  return response;
}
