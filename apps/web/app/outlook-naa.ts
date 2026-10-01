import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const clientIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tenantIdPattern = clientIdPattern;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const microsoftKeys = createRemoteJWKSet(
  new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys"),
  {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 60 * 60 * 1_000,
  },
);

export type OutlookNaaPublicConfig = {
  clientId: string;
  authority: string;
  audience: string;
  scope: string;
  redirectUri: string;
  dialogUrl: string;
  brokerRedirectUri: string;
};

export type VerifiedOutlookNaaIdentity = {
  email: string | null;
  subject: string;
  tenantId: string;
};

type TokenVerifier = (token: string, audience: string) => Promise<JWTPayload>;

function appOrigin(environment: NodeJS.ProcessEnv): URL {
  const value = environment.APP_URL?.trim() || "http://localhost:3000";
  const parsed = new URL(value);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("APP_URL must be a bare HTTP(S) origin.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (
    environment.NODE_ENV === "production" &&
    parsed.protocol !== "https:" &&
    !local
  ) {
    throw new Error("APP_URL must use HTTPS outside local development.");
  }
  return parsed;
}

export function configuredOutlookNaa(
  environment: NodeJS.ProcessEnv = process.env,
): OutlookNaaPublicConfig | null {
  const rawClientId = environment.OUTLOOK_NAA_CLIENT_ID?.trim();
  if (!rawClientId) return null;
  if (!clientIdPattern.test(rawClientId)) {
    throw new Error(
      "OUTLOOK_NAA_CLIENT_ID must be a Microsoft application GUID.",
    );
  }
  const clientId = rawClientId.toLowerCase();
  const origin = appOrigin(environment);
  const applicationIdUri = `api://${origin.host}/${clientId}`;
  return {
    clientId,
    authority: "https://login.microsoftonline.com/common",
    audience: clientId,
    scope: `${applicationIdUri}/access_as_user`,
    redirectUri: new URL("/email/outlook/auth", origin).toString(),
    dialogUrl: new URL("/email/outlook/auth-dialog", origin).toString(),
    brokerRedirectUri: `brk-multihub://${origin.host}`,
  };
}

function stringClaim(payload: JWTPayload, name: string): string | null {
  const value = payload[name];
  return typeof value === "string" ? value : null;
}

function hasAudience(payload: JWTPayload, audience: string): boolean {
  return Array.isArray(payload.aud)
    ? payload.aud.length === 1 && payload.aud[0] === audience
    : payload.aud === audience;
}

export function outlookNaaIdentityFromClaims(
  payload: JWTPayload,
  config: OutlookNaaPublicConfig,
): VerifiedOutlookNaaIdentity | null {
  const tenantId = stringClaim(payload, "tid")?.toLowerCase() ?? "";
  const subject = payload.sub?.trim() ?? "";
  const issuer = payload.iss ?? "";
  const scopes = new Set((stringClaim(payload, "scp") ?? "").split(/\s+/));
  const authorizedParty = stringClaim(payload, "azp")?.toLowerCase();
  const version = stringClaim(payload, "ver");
  const email = [
    stringClaim(payload, "preferred_username"),
    stringClaim(payload, "email"),
    stringClaim(payload, "upn"),
  ]
    .map((value) => value?.trim().toLowerCase() ?? "")
    .find((value) => value.length <= 320 && emailPattern.test(value));

  if (
    version !== "2.0" ||
    !tenantIdPattern.test(tenantId) ||
    subject.length < 1 ||
    subject.length > 255 ||
    issuer !== `https://login.microsoftonline.com/${tenantId}/v2.0` ||
    !hasAudience(payload, config.audience) ||
    authorizedParty !== config.clientId ||
    !scopes.has("access_as_user")
  ) {
    return null;
  }

  return {
    email: email ?? null,
    subject,
    tenantId,
  };
}

async function verifyMicrosoftToken(
  token: string,
  audience: string,
): Promise<JWTPayload> {
  const result = await jwtVerify(token, microsoftKeys, {
    algorithms: ["RS256"],
    audience,
    clockTolerance: 5,
  });
  return result.payload;
}

export async function verifyOutlookNaaAccessToken(
  token: string,
  environment: NodeJS.ProcessEnv = process.env,
  verifier: TokenVerifier = verifyMicrosoftToken,
): Promise<VerifiedOutlookNaaIdentity | null> {
  const config = configuredOutlookNaa(environment);
  if (!config || token.length < 80 || token.length > 16_384) return null;
  try {
    const payload = await verifier(token, config.audience);
    return outlookNaaIdentityFromClaims(payload, config);
  } catch {
    return null;
  }
}
