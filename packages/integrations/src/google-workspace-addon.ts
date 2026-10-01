import { OAuth2Client } from "google-auth-library";

const GOOGLE_ID_TOKEN_ISSUERS = new Set([
  "accounts.google.com",
  "https://accounts.google.com",
]);
const MAX_TOKEN_LENGTH = 20_000;
const MAX_MAP_ENTRIES = 64;
const MAX_KEY_LENGTH = 128;
const MAX_VALUE_LENGTH = 4_096;

export const googleWorkspaceAddonRequiredScopes = Object.freeze([
  "https://www.googleapis.com/auth/gmail.addons.execute",
  "https://www.googleapis.com/auth/gmail.addons.current.action.compose",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/script.locale",
] as const);

export type GoogleWorkspaceAddonPlatform = "WEB" | "IOS" | "ANDROID";

export type GoogleWorkspaceAddonFormInput =
  | { kind: "strings"; values: readonly string[] }
  | {
      kind: "date-time";
      millisecondsSinceEpoch: number;
      hasDate: boolean;
      hasTime: boolean;
    }
  | { kind: "date"; millisecondsSinceEpoch: number }
  | { kind: "time"; hours: number; minutes: number };

/**
 * The event fields an add-on handler can safely use. Google authorization and
 * Gmail access tokens are deliberately excluded from this type.
 */
export type GoogleWorkspaceAddonEvent = Readonly<{
  hostApp: "GMAIL";
  platform: GoogleWorkspaceAddonPlatform | null;
  userLocale: string | null;
  timeZone: Readonly<{ id: string; offsetMilliseconds: number }> | null;
  parameters: Readonly<Record<string, string>>;
  formInputs: Readonly<Record<string, GoogleWorkspaceAddonFormInput>>;
}>;

export type GoogleWorkspaceAddonTokenPayload = Readonly<{
  audience: string | readonly string[];
  issuer: string;
  subject?: string;
  email?: string;
  emailVerified?: boolean;
}>;

export type GoogleWorkspaceAddonIdTokenVerifier = (input: {
  idToken: string;
  audience: string;
}) => Promise<GoogleWorkspaceAddonTokenPayload>;

export type GoogleWorkspaceAddonVerifierConfig = Readonly<{
  /** The exact, public HTTPS endpoint used by every manifest runFunction. */
  endpointAudience: string;
  /** OAuth client ID from the add-on deployment's Authorization Resource. */
  oauthClientId: string;
  /** Service account email from the add-on deployment's Authorization Resource. */
  systemServiceAccountEmail: string;
}>;

export type VerifiedGoogleWorkspaceAddonRequest = Readonly<{
  kind: "verified";
  identity: Readonly<{ subject: string; email: string }>;
  event: GoogleWorkspaceAddonEvent;
}>;

export type GoogleWorkspaceAddonScopeRequest = Readonly<{
  kind: "requesting_google_scopes";
  allScopes: true;
}>;

export type GoogleWorkspaceAddonVerificationResult =
  | VerifiedGoogleWorkspaceAddonRequest
  | GoogleWorkspaceAddonScopeRequest;

export type GoogleWorkspaceAddonVerificationErrorCode =
  | "invalid_event"
  | "unauthorized";

export class GoogleWorkspaceAddonVerificationError extends Error {
  readonly statusCode: 400 | 401;

  constructor(
    readonly code: GoogleWorkspaceAddonVerificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GoogleWorkspaceAddonVerificationError";
    this.statusCode = code === "unauthorized" ? 401 : 400;
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidEvent(): never {
  throw new GoogleWorkspaceAddonVerificationError(
    "invalid_event",
    "Invalid Google Workspace add-on event.",
  );
}

function unauthorized(): never {
  throw new GoogleWorkspaceAddonVerificationError(
    "unauthorized",
    "Google Workspace add-on authentication failed.",
  );
}

function boundedString(
  value: unknown,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return invalidEvent();
  }
  return value;
}

function parseStringMap(value: unknown): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) return invalidEvent();

  const entries = Object.entries(value);
  if (entries.length > MAX_MAP_ENTRIES) return invalidEvent();
  const parsed = entries.map(([key, item]) => [
    boundedString(key, MAX_KEY_LENGTH),
    boundedString(item, MAX_VALUE_LENGTH, true),
  ]);
  return Object.freeze(Object.fromEntries(parsed));
}

function safeInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalidEvent();
  }
  return value;
}

function parseFormInput(value: unknown): GoogleWorkspaceAddonFormInput {
  if (!isRecord(value)) return invalidEvent();
  const wrapper = isRecord(value[""]) ? value[""] : value;

  const kinds = [
    "stringInputs",
    "dateTimeInput",
    "dateInput",
    "timeInput",
  ].filter((key) => wrapper[key] !== undefined);
  if (kinds.length !== 1) return invalidEvent();

  if (kinds[0] === "stringInputs") {
    const input = wrapper.stringInputs;
    if (!isRecord(input) || !Array.isArray(input.value)) return invalidEvent();
    if (input.value.length > MAX_MAP_ENTRIES) return invalidEvent();
    const values = input.value.map((item) =>
      boundedString(item, MAX_VALUE_LENGTH, true),
    );
    return Object.freeze({ kind: "strings", values: Object.freeze(values) });
  }

  if (kinds[0] === "dateTimeInput") {
    const input = wrapper.dateTimeInput;
    if (
      !isRecord(input) ||
      typeof input.hasDate !== "boolean" ||
      typeof input.hasTime !== "boolean"
    ) {
      return invalidEvent();
    }
    return Object.freeze({
      kind: "date-time",
      millisecondsSinceEpoch: safeInteger(
        input.msSinceEpoch,
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      ),
      hasDate: input.hasDate,
      hasTime: input.hasTime,
    });
  }

  if (kinds[0] === "dateInput") {
    const input = wrapper.dateInput;
    if (!isRecord(input)) return invalidEvent();
    return Object.freeze({
      kind: "date",
      millisecondsSinceEpoch: safeInteger(
        input.msSinceEpoch,
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
      ),
    });
  }

  const input = wrapper.timeInput;
  if (!isRecord(input)) return invalidEvent();
  return Object.freeze({
    kind: "time",
    hours: safeInteger(input.hours, 0, 23),
    minutes: safeInteger(input.minutes, 0, 59),
  });
}

function parseFormInputs(
  value: unknown,
): Readonly<Record<string, GoogleWorkspaceAddonFormInput>> {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) return invalidEvent();

  const entries = Object.entries(value);
  if (entries.length > MAX_MAP_ENTRIES) return invalidEvent();
  const parsed = entries.map(([key, item]) => [
    boundedString(key, MAX_KEY_LENGTH),
    parseFormInput(item),
  ]);
  return Object.freeze(Object.fromEntries(parsed));
}

/**
 * Parses only non-credential event fields. Never return or log the original
 * event object: it can contain user OAuth, user ID, system ID, and Gmail tokens.
 */
export function parseGoogleWorkspaceAddonEvent(
  event: unknown,
): GoogleWorkspaceAddonEvent {
  if (!isRecord(event) || !isRecord(event.commonEventObject)) {
    return invalidEvent();
  }
  const common = event.commonEventObject;
  if (common.hostApp !== "GMAIL") return invalidEvent();

  let platform: GoogleWorkspaceAddonPlatform | null = null;
  if (common.platform !== undefined) {
    if (common.platform === "ANDRIOD") {
      // Google's published HTTP event schema has historically used this typo.
      platform = "ANDROID";
    } else if (
      common.platform === "WEB" ||
      common.platform === "IOS" ||
      common.platform === "ANDROID"
    ) {
      platform = common.platform;
    } else {
      return invalidEvent();
    }
  }

  const userLocale =
    common.userLocale === undefined
      ? null
      : boundedString(common.userLocale, 64);

  let timeZone: GoogleWorkspaceAddonEvent["timeZone"] = null;
  if (common.timeZone !== undefined) {
    if (!isRecord(common.timeZone)) return invalidEvent();
    timeZone = Object.freeze({
      id: boundedString(common.timeZone.id, 128),
      offsetMilliseconds: safeInteger(
        common.timeZone.offset,
        -86_400_000,
        86_400_000,
      ),
    });
  }

  return Object.freeze({
    hostApp: "GMAIL",
    platform,
    userLocale,
    timeZone,
    parameters: parseStringMap(common.parameters),
    formInputs: parseFormInputs(common.formInputs),
  });
}

function readBearerToken(
  authorizationHeader: string | null | undefined,
): string {
  if (typeof authorizationHeader !== "string") return unauthorized();
  const match = /^Bearer ([^\s]+)$/u.exec(authorizationHeader);
  if (!match?.[1] || match[1].length > MAX_TOKEN_LENGTH) return unauthorized();
  return match[1];
}

function readUserIdToken(event: unknown): string {
  if (!isRecord(event) || !isRecord(event.authorizationEventObject)) {
    return unauthorized();
  }
  const token = event.authorizationEventObject.userIdToken;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    /\s/u.test(token)
  ) {
    return unauthorized();
  }
  return token;
}

function readAuthorizedScopes(event: unknown): ReadonlySet<string> {
  if (!isRecord(event) || !isRecord(event.authorizationEventObject)) {
    return new Set();
  }
  const scopes = event.authorizationEventObject.authorizedScopes;
  if (scopes === undefined) return new Set();
  if (!Array.isArray(scopes) || scopes.length > MAX_MAP_ENTRIES) {
    return invalidEvent();
  }
  return new Set(scopes.map((scope) => boundedString(scope, MAX_VALUE_LENGTH)));
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function exactAudience(
  audience: string | readonly string[],
  expected: string,
): boolean {
  return (
    audience === expected ||
    (Array.isArray(audience) &&
      audience.length === 1 &&
      audience[0] === expected)
  );
}

function validateConfig(
  config: GoogleWorkspaceAddonVerifierConfig,
): Readonly<
  GoogleWorkspaceAddonVerifierConfig & { normalizedSystemEmail: string }
> {
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpointAudience);
  } catch {
    throw new Error("Google Workspace add-on endpointAudience must be a URL.");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search ||
    endpoint.toString() !== config.endpointAudience
  ) {
    throw new Error(
      "Google Workspace add-on endpointAudience must be one exact public HTTPS endpoint without credentials, query, or fragment.",
    );
  }
  if (!config.oauthClientId.trim() || /\s/u.test(config.oauthClientId)) {
    throw new Error("Google Workspace add-on oauthClientId is required.");
  }
  const normalizedSystemEmail = normalizeEmail(
    config.systemServiceAccountEmail,
  );
  if (!normalizedSystemEmail) {
    throw new Error(
      "Google Workspace add-on systemServiceAccountEmail must be a valid email.",
    );
  }
  return Object.freeze({ ...config, normalizedSystemEmail });
}

function createGoogleIdTokenVerifier(): GoogleWorkspaceAddonIdTokenVerifier {
  const client = new OAuth2Client();
  return async ({ idToken, audience }) => {
    const ticket = await client.verifyIdToken({ idToken, audience });
    const payload = ticket.getPayload();
    if (!payload) throw new Error("Google did not return an ID token payload.");
    return {
      audience: payload.aud,
      issuer: payload.iss,
      subject: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified,
    };
  };
}

export function createGoogleWorkspaceAddonVerifier(
  inputConfig: GoogleWorkspaceAddonVerifierConfig,
  dependencies: Readonly<{
    verifyIdToken?: GoogleWorkspaceAddonIdTokenVerifier;
  }> = {},
): Readonly<{
  verify(input: {
    authorizationHeader: string | null | undefined;
    event: unknown;
  }): Promise<GoogleWorkspaceAddonVerificationResult>;
}> {
  const config = validateConfig(inputConfig);
  const verifyIdToken =
    dependencies.verifyIdToken ?? createGoogleIdTokenVerifier();

  return Object.freeze({
    async verify({ authorizationHeader, event }) {
      const systemIdToken = readBearerToken(authorizationHeader);
      let systemPayload: GoogleWorkspaceAddonTokenPayload;
      try {
        systemPayload = await verifyIdToken({
          idToken: systemIdToken,
          audience: config.endpointAudience,
        });
      } catch {
        return unauthorized();
      }

      if (
        !exactAudience(systemPayload.audience, config.endpointAudience) ||
        !GOOGLE_ID_TOKEN_ISSUERS.has(systemPayload.issuer) ||
        systemPayload.emailVerified !== true ||
        normalizeEmail(systemPayload.email) !== config.normalizedSystemEmail
      ) {
        return unauthorized();
      }

      const safeEvent = parseGoogleWorkspaceAddonEvent(event);
      const authorizedScopes = readAuthorizedScopes(event);
      if (
        googleWorkspaceAddonRequiredScopes.some(
          (scope) => !authorizedScopes.has(scope),
        )
      ) {
        return Object.freeze({
          kind: "requesting_google_scopes",
          allScopes: true,
        });
      }

      const userIdToken = readUserIdToken(event);
      let userPayload: GoogleWorkspaceAddonTokenPayload;
      try {
        userPayload = await verifyIdToken({
          idToken: userIdToken,
          audience: config.oauthClientId,
        });
      } catch {
        return unauthorized();
      }

      const userEmail = normalizeEmail(userPayload.email);
      if (
        !exactAudience(userPayload.audience, config.oauthClientId) ||
        !GOOGLE_ID_TOKEN_ISSUERS.has(userPayload.issuer) ||
        userPayload.emailVerified !== true ||
        typeof userPayload.subject !== "string" ||
        userPayload.subject.length === 0 ||
        userPayload.subject.length > 255 ||
        !userEmail
      ) {
        return unauthorized();
      }

      return Object.freeze({
        kind: "verified",
        identity: Object.freeze({
          subject: userPayload.subject,
          email: userEmail,
        }),
        event: safeEvent,
      });
    },
  });
}
