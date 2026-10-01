import { GoogleOAuthClient } from "./google.js";
import { HubSpotOAuthClient } from "./hubspot.js";
import { MicrosoftOAuthClient } from "./microsoft.js";
import {
  ConnectionTokenManager,
  RepCalendarTokenManager,
  type CalendarOAuthProvider,
  type OAuthConnectionStore,
  type OAuthProvider,
  type OAuthProviderClient,
  type RepCalendarConnectionStore,
} from "./oauth.js";
import { TokenCipher } from "./token-cipher.js";

type ConnectorEnvironment = Partial<
  Record<
    | "OAUTH_ENCRYPTION_KEY"
    | "HUBSPOT_CLIENT_ID"
    | "HUBSPOT_CLIENT_SECRET"
    | "GOOGLE_CLIENT_ID"
    | "GOOGLE_CLIENT_SECRET"
    | "MICROSOFT_CLIENT_ID"
    | "MICROSOFT_CLIENT_SECRET",
    string
  >
>;

export function providerConfigured(
  provider: OAuthProvider,
  environment: ConnectorEnvironment = process.env,
): boolean {
  let encryptionKeyValid = false;
  if (environment.OAUTH_ENCRYPTION_KEY) {
    try {
      TokenCipher.fromBase64(environment.OAUTH_ENCRYPTION_KEY);
      encryptionKeyValid = true;
    } catch {
      encryptionKeyValid = false;
    }
  }
  const common = encryptionKeyValid;
  if (provider === "hubspot") {
    return Boolean(
      common &&
        environment.HUBSPOT_CLIENT_ID &&
        environment.HUBSPOT_CLIENT_SECRET,
    );
  }
  if (provider === "microsoft") {
    return Boolean(
      common &&
        environment.MICROSOFT_CLIENT_ID &&
        environment.MICROSOFT_CLIENT_SECRET,
    );
  }
  return Boolean(
    common && environment.GOOGLE_CLIENT_ID && environment.GOOGLE_CLIENT_SECRET,
  );
}

export function createConnectionTokenManager(
  store: OAuthConnectionStore,
  environment: ConnectorEnvironment = process.env,
): ConnectionTokenManager {
  if (!environment.OAUTH_ENCRYPTION_KEY) {
    throw new Error("OAUTH_ENCRYPTION_KEY is not configured.");
  }
  const clients = new Map<OAuthProvider, OAuthProviderClient>();
  if (environment.HUBSPOT_CLIENT_ID && environment.HUBSPOT_CLIENT_SECRET) {
    clients.set(
      "hubspot",
      new HubSpotOAuthClient({
        clientId: environment.HUBSPOT_CLIENT_ID,
        clientSecret: environment.HUBSPOT_CLIENT_SECRET,
      }),
    );
  }
  if (environment.GOOGLE_CLIENT_ID && environment.GOOGLE_CLIENT_SECRET) {
    clients.set(
      "google",
      new GoogleOAuthClient({
        clientId: environment.GOOGLE_CLIENT_ID,
        clientSecret: environment.GOOGLE_CLIENT_SECRET,
      }),
    );
  }
  if (environment.MICROSOFT_CLIENT_ID && environment.MICROSOFT_CLIENT_SECRET) {
    clients.set(
      "microsoft",
      new MicrosoftOAuthClient({
        clientId: environment.MICROSOFT_CLIENT_ID,
        clientSecret: environment.MICROSOFT_CLIENT_SECRET,
      }),
    );
  }
  return new ConnectionTokenManager(
    store,
    TokenCipher.fromBase64(environment.OAUTH_ENCRYPTION_KEY),
    clients,
  );
}

export function createRepCalendarTokenManager(
  store: RepCalendarConnectionStore,
  environment: ConnectorEnvironment = process.env,
): RepCalendarTokenManager {
  if (!environment.OAUTH_ENCRYPTION_KEY) {
    throw new Error("OAUTH_ENCRYPTION_KEY is not configured.");
  }
  const clients = new Map<CalendarOAuthProvider, OAuthProviderClient>();
  if (environment.GOOGLE_CLIENT_ID && environment.GOOGLE_CLIENT_SECRET) {
    clients.set(
      "google",
      new GoogleOAuthClient({
        clientId: environment.GOOGLE_CLIENT_ID,
        clientSecret: environment.GOOGLE_CLIENT_SECRET,
        calendarAccess: "readwrite",
      }),
    );
  }
  if (environment.MICROSOFT_CLIENT_ID && environment.MICROSOFT_CLIENT_SECRET) {
    clients.set(
      "microsoft",
      new MicrosoftOAuthClient({
        clientId: environment.MICROSOFT_CLIENT_ID,
        clientSecret: environment.MICROSOFT_CLIENT_SECRET,
        calendarScope: "Calendars.ReadWrite",
      }),
    );
  }
  return new RepCalendarTokenManager(
    store,
    TokenCipher.fromBase64(environment.OAUTH_ENCRYPTION_KEY),
    clients,
  );
}
