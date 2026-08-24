import { GoogleOAuthClient } from "./google.js";
import { HubSpotOAuthClient } from "./hubspot.js";
import {
  ConnectionTokenManager,
  type OAuthConnectionStore,
  type OAuthProvider,
  type OAuthProviderClient,
} from "./oauth.js";
import { TokenCipher, oauthStatesEqual } from "./token-cipher.js";

type ConnectorEnvironment = Partial<
  Record<
    | "OAUTH_ENCRYPTION_KEY"
    | "CONNECTOR_SETUP_SECRET"
    | "HUBSPOT_CLIENT_ID"
    | "HUBSPOT_CLIENT_SECRET"
    | "GOOGLE_CLIENT_ID"
    | "GOOGLE_CLIENT_SECRET",
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
  const common = Boolean(
    encryptionKeyValid &&
      environment.CONNECTOR_SETUP_SECRET &&
      environment.CONNECTOR_SETUP_SECRET.length >= 16,
  );
  if (provider === "hubspot") {
    return Boolean(
      common &&
        environment.HUBSPOT_CLIENT_ID &&
        environment.HUBSPOT_CLIENT_SECRET,
    );
  }
  return Boolean(
    common && environment.GOOGLE_CLIENT_ID && environment.GOOGLE_CLIENT_SECRET,
  );
}

export function setupSecretMatches(
  candidate: string,
  environment: ConnectorEnvironment = process.env,
): boolean {
  const expected = environment.CONNECTOR_SETUP_SECRET;
  return Boolean(expected && oauthStatesEqual(candidate, expected));
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
  return new ConnectionTokenManager(
    store,
    TokenCipher.fromBase64(environment.OAUTH_ENCRYPTION_KEY),
    clients,
  );
}
