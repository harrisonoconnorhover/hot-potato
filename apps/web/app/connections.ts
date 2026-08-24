import {
  createConnectionTokenManager,
  type ConnectionTokenManager,
  type OAuthProvider,
} from "@hot-potato/integrations";
import type { NextRequest } from "next/server";
import { repository } from "./repository";

let manager: ConnectionTokenManager | undefined;

export function connectionManager(): ConnectionTokenManager {
  return (manager ??= createConnectionTokenManager(repository));
}

export function parseProvider(value: string): OAuthProvider | null {
  return value === "hubspot" || value === "google" ? value : null;
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

export function stateCookieName(provider: OAuthProvider): string {
  return `hp_oauth_state_${provider}`;
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
