import { oauthStatesEqual } from "@hot-potato/integrations";
import { type NextRequest, NextResponse } from "next/server";
import {
  parseCalendarProvider,
  hashRepCalendarOAuthState,
  repCalendarCallbackUrl,
  repCalendarManager,
  repCalendarStateCookie,
  repCalendarVerifierCookie,
  repConnectionResultUrl,
} from "../../../../connections";
import { operatorSessionForRequest } from "../../../../operator-session";
import { syncRepCalendarCatalog } from "../../../../rep-calendar-catalog";
import { repository } from "../../../../repository";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider: rawProvider } = await context.params;
  const provider = parseCalendarProvider(rawProvider);
  if (!provider) {
    return NextResponse.json(
      { error: "Calendar provider not found." },
      { status: 404 },
    );
  }

  const state = request.nextUrl.searchParams.get("state") ?? "";
  const expectedState =
    request.cookies.get(repCalendarStateCookie(provider))?.value ?? "";
  const code = request.nextUrl.searchParams.get("code");
  const codeVerifier = request.cookies.get(
    repCalendarVerifierCookie(provider),
  )?.value;
  const providerError = request.nextUrl.searchParams.get("error");
  let status = "connected";
  let returnTo: "calendar-readiness" | "my-calendar" = "my-calendar";

  if (
    !state ||
    !expectedState ||
    !oauthStatesEqual(state, expectedState) ||
    !codeVerifier
  ) {
    status = "invalid-state";
  } else {
    try {
      const identity = await operatorSessionForRequest(request);
      if (!identity) {
        status = "invalid-state";
      } else {
        const attempt = await repository.consumeRepCalendarOAuthAttempt({
          organizationId: identity.organizationId,
          operatorId: identity.operatorId,
          provider,
          stateHash: hashRepCalendarOAuthState(state),
        });
        if (!attempt) {
          status = "invalid-state";
        } else {
          returnTo = attempt.returnTo;
          if (providerError || !code) {
            status = "denied";
          } else {
            await repCalendarManager().connect(
              identity.organizationSlug,
              attempt.repId,
              provider,
              {
                code,
                redirectUri: repCalendarCallbackUrl(request, provider),
                codeVerifier,
              },
            );
            try {
              await syncRepCalendarCatalog({
                organizationSlug: identity.organizationSlug,
                repId: attempt.repId,
                provider,
              });
            } catch {
              console.error(
                `Representative ${provider} calendar catalog refresh failed after OAuth.`,
              );
              status = "connected-needs-refresh";
            }
          }
        }
      }
    } catch {
      console.error(`Representative ${provider} OAuth callback failed.`);
      status = "failed";
    }
  }

  const response = NextResponse.redirect(
    repConnectionResultUrl(request, provider, status, returnTo),
    { status: 303 },
  );
  response.headers.set("cache-control", "no-store");
  response.headers.set("referrer-policy", "no-referrer");
  response.cookies.delete(repCalendarStateCookie(provider));
  response.cookies.delete(repCalendarVerifierCookie(provider));
  return response;
}
