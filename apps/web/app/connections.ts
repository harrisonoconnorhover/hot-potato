import {
  createConnectionTokenManager,
  createRepCalendarTokenManager,
  type ConnectionTokenManager,
  type CalendarOAuthProvider,
  type OAuthProvider,
  type RepCalendarTokenManager,
} from "@hot-potato/integrations";
import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";
import { repository } from "./repository";

let manager: ConnectionTokenManager | undefined;
let repManager: RepCalendarTokenManager | undefined;

export function connectionManager(): ConnectionTokenManager {
  return (manager ??= createConnectionTokenManager(repository));
}

export function repCalendarManager(): RepCalendarTokenManager {
  return (repManager ??= createRepCalendarTokenManager(repository));
}

export function parseProvider(value: string): OAuthProvider | null {
  return value === "hubspot" || value === "google" || value === "microsoft"
    ? value
    : null;
}

export function parseCalendarProvider(
  value: string,
): CalendarOAuthProvider | null {
  return value === "google" || value === "microsoft" ? value : null;
}

export function appBaseUrl(request: NextRequest): URL {
  const configured = process.env.APP_URL;
  return new URL(configured ?? request.nextUrl.origin);
}

export function callbackUrl(
  request: NextRequest,
  provider: OAuthProvider,
): string {
  return new URL(
    `/api/connections/${provider}/callback`,
    appBaseUrl(request),
  ).toString();
}

export function repCalendarCallbackUrl(
  request: NextRequest,
  provider: CalendarOAuthProvider,
): string {
  return new URL(
    `/api/rep-connections/${provider}/callback`,
    appBaseUrl(request),
  ).toString();
}

export function stateCookieName(provider: OAuthProvider): string {
  return `hp_oauth_state_${provider}`;
}

export function codeVerifierCookieName(provider: OAuthProvider): string {
  return `hp_oauth_verifier_${provider}`;
}

export function repCalendarStateCookie(provider: CalendarOAuthProvider) {
  return `hp_rep_oauth_state_${provider}`;
}

export function repCalendarVerifierCookie(provider: CalendarOAuthProvider) {
  return `hp_rep_oauth_verifier_${provider}`;
}

export function hashRepCalendarOAuthState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

export function connectionResultUrl(
  request: NextRequest,
  provider: OAuthProvider,
  status: string,
): URL {
  const url = new URL("/", appBaseUrl(request));
  url.searchParams.set("connection", provider);
  url.searchParams.set("status", status);
  url.hash = "connections";
  return url;
}

export function repConnectionResultUrl(
  request: NextRequest,
  provider: CalendarOAuthProvider,
  status: string,
  returnTo: "calendar-readiness" | "my-calendar" = "calendar-readiness",
): URL {
  const url = new URL("/", appBaseUrl(request));
  url.searchParams.set("repConnection", provider);
  url.searchParams.set("status", status);
  url.hash = returnTo;
  return url;
}
