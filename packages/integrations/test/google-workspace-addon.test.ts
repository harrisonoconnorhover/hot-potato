import { describe, expect, it, vi } from "vitest";
import {
  createGoogleWorkspaceAddonVerifier,
  googleWorkspaceAddonRequiredScopes,
  GoogleWorkspaceAddonVerificationError,
  parseGoogleWorkspaceAddonEvent,
  type GoogleWorkspaceAddonIdTokenVerifier,
  type GoogleWorkspaceAddonTokenPayload,
} from "../src/index.js";

const config = {
  endpointAudience:
    "https://app.hotpotato.example/api/integrations/google-workspace-addon",
  oauthClientId: "workspace-addon.apps.googleusercontent.com",
  systemServiceAccountEmail:
    "service-account@workspace-addon.example.iam.gserviceaccount.com",
} as const;

function event(overrides: Record<string, unknown> = {}) {
  return {
    authorizationEventObject: {
      authorizedScopes: [...googleWorkspaceAddonRequiredScopes],
      userIdToken: "user.id.token",
      userOAuthToken: "user-oauth-secret",
      systemIdToken: "body-system-secret",
    },
    commonEventObject: {
      hostApp: "GMAIL",
      platform: "WEB",
      userLocale: "en-US",
      timeZone: { id: "America/New_York", offset: -14_400_000 },
      parameters: { action: "compose" },
      formInputs: {
        meetingType: {
          stringInputs: { value: ["discovery"] },
        },
      },
    },
    gmail: { accessToken: "gmail-access-secret" },
    ...overrides,
  };
}

const systemPayload: GoogleWorkspaceAddonTokenPayload = {
  audience: config.endpointAudience,
  issuer: "https://accounts.google.com",
  subject: "workspace-addon-service-account",
  email: config.systemServiceAccountEmail,
  emailVerified: true,
};

const userPayload: GoogleWorkspaceAddonTokenPayload = {
  audience: config.oauthClientId,
  issuer: "accounts.google.com",
  subject: "google-user-123",
  email: "  Scheduler@Example.COM  ",
  emailVerified: true,
};

function fakeVerifier(
  system: GoogleWorkspaceAddonTokenPayload = systemPayload,
  user: GoogleWorkspaceAddonTokenPayload = userPayload,
) {
  return vi.fn<GoogleWorkspaceAddonIdTokenVerifier>(async ({ idToken }) => {
    if (idToken === "system.id.token") return system;
    if (idToken === "user.id.token") return user;
    throw new Error("unexpected token");
  });
}

describe("Google Workspace add-on request verification", () => {
  it("verifies both exact audiences and returns only safe normalized data", async () => {
    const verifyIdToken = fakeVerifier();
    const verifier = createGoogleWorkspaceAddonVerifier(config, {
      verifyIdToken,
    });

    const result = await verifier.verify({
      authorizationHeader: "Bearer system.id.token",
      event: event(),
    });

    expect(verifyIdToken.mock.calls).toEqual([
      [
        {
          idToken: "system.id.token",
          audience: config.endpointAudience,
        },
      ],
      [
        {
          idToken: "user.id.token",
          audience: config.oauthClientId,
        },
      ],
    ]);
    expect(result).toEqual({
      kind: "verified",
      identity: {
        subject: "google-user-123",
        email: "scheduler@example.com",
      },
      event: {
        hostApp: "GMAIL",
        platform: "WEB",
        userLocale: "en-US",
        timeZone: {
          id: "America/New_York",
          offsetMilliseconds: -14_400_000,
        },
        parameters: { action: "compose" },
        formInputs: {
          meetingType: { kind: "strings", values: ["discovery"] },
        },
      },
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("system.id.token");
    expect(serialized).not.toContain("user.id.token");
    expect(serialized).not.toContain("user-oauth-secret");
    expect(serialized).not.toContain("body-system-secret");
    expect(serialized).not.toContain("gmail-access-secret");
  });

  it.each([
    {
      name: "wrong audience",
      payload: {
        ...systemPayload,
        audience: `${config.endpointAudience}/wrong`,
      },
    },
    {
      name: "non-Google issuer",
      payload: { ...systemPayload, issuer: "https://issuer.example" },
    },
    {
      name: "wrong service account",
      payload: { ...systemPayload, email: "attacker@example.com" },
    },
    {
      name: "unverified service account email",
      payload: { ...systemPayload, emailVerified: false },
    },
  ])("rejects a system token with $name", async ({ payload }) => {
    const verifyIdToken = fakeVerifier(payload);
    const verifier = createGoogleWorkspaceAddonVerifier(config, {
      verifyIdToken,
    });

    await expect(
      verifier.verify({
        authorizationHeader: "Bearer system.id.token",
        event: event(),
      }),
    ).rejects.toMatchObject({ code: "unauthorized", statusCode: 401 });
    expect(verifyIdToken).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "wrong audience",
      payload: { ...userPayload, audience: `${config.oauthClientId}-other` },
    },
    {
      name: "non-Google issuer",
      payload: { ...userPayload, issuer: "https://issuer.example" },
    },
    {
      name: "missing subject",
      payload: { ...userPayload, subject: undefined },
    },
    {
      name: "unverified email",
      payload: { ...userPayload, emailVerified: false },
    },
    {
      name: "invalid email",
      payload: { ...userPayload, email: "not-an-email" },
    },
  ])("rejects a user token with $name", async ({ payload }) => {
    const verifier = createGoogleWorkspaceAddonVerifier(config, {
      verifyIdToken: fakeVerifier(systemPayload, payload),
    });

    await expect(
      verifier.verify({
        authorizationHeader: "Bearer system.id.token",
        event: event(),
      }),
    ).rejects.toMatchObject({ code: "unauthorized", statusCode: 401 });
  });

  it("rejects malformed bearer headers before token verification", async () => {
    const verifyIdToken = fakeVerifier();
    const verifier = createGoogleWorkspaceAddonVerifier(config, {
      verifyIdToken,
    });

    for (const authorizationHeader of [
      undefined,
      "",
      "Basic system.id.token",
      "Bearer ",
      "Bearer system.id.token extra",
    ]) {
      await expect(
        verifier.verify({ authorizationHeader, event: event() }),
      ).rejects.toBeInstanceOf(GoogleWorkspaceAddonVerificationError);
    }
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("redacts verifier failures instead of exposing token or library details", async () => {
    const verifyIdToken = vi.fn<GoogleWorkspaceAddonIdTokenVerifier>(
      async ({ idToken }) => {
        throw new Error(`certificate failure for ${idToken}`);
      },
    );
    const verifier = createGoogleWorkspaceAddonVerifier(config, {
      verifyIdToken,
    });

    let failure: unknown;
    try {
      await verifier.verify({
        authorizationHeader: "Bearer system.id.token",
        event: event(),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GoogleWorkspaceAddonVerificationError);
    expect(String(failure)).toBe(
      "GoogleWorkspaceAddonVerificationError: Google Workspace add-on authentication failed.",
    );
    expect(String(failure)).not.toContain("system.id.token");
    expect(String(failure)).not.toContain("certificate");
  });

  it("requires a user ID token but never requires draft or Gmail tokens", async () => {
    const verifier = createGoogleWorkspaceAddonVerifier(config, {
      verifyIdToken: fakeVerifier(),
    });
    const requestEvent = event({
      authorizationEventObject: {
        authorizedScopes: [...googleWorkspaceAddonRequiredScopes],
      },
      gmail: undefined,
    });

    await expect(
      verifier.verify({
        authorizationHeader: "Bearer system.id.token",
        event: requestEvent,
      }),
    ).rejects.toMatchObject({ code: "unauthorized", statusCode: 401 });
  });

  it("requests all manifest scopes after system verification when consent is partial", async () => {
    const verifyIdToken = fakeVerifier();
    const verifier = createGoogleWorkspaceAddonVerifier(config, {
      verifyIdToken,
    });
    const requestEvent = event({
      authorizationEventObject: {
        authorizedScopes: [
          "https://www.googleapis.com/auth/gmail.addons.execute",
        ],
      },
    });

    await expect(
      verifier.verify({
        authorizationHeader: "Bearer system.id.token",
        event: requestEvent,
      }),
    ).resolves.toEqual({
      kind: "requesting_google_scopes",
      allScopes: true,
    });
    expect(verifyIdToken).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-HTTPS or non-canonical audience at configuration time", () => {
    expect(() =>
      createGoogleWorkspaceAddonVerifier({
        ...config,
        endpointAudience: "http://app.hotpotato.example/addon",
      }),
    ).toThrow("exact public HTTPS endpoint");
    expect(() =>
      createGoogleWorkspaceAddonVerifier({
        ...config,
        endpointAudience: `${config.endpointAudience}?source=gmail`,
      }),
    ).toThrow("exact public HTTPS endpoint");
  });
});

describe("safe Google Workspace add-on event parsing", () => {
  it("parses supported form inputs and normalizes Google's Android typo", () => {
    expect(
      parseGoogleWorkspaceAddonEvent({
        authorizationEventObject: {
          userIdToken: "must-not-be-returned",
          userOAuthToken: "must-not-be-returned-either",
        },
        commonEventObject: {
          hostApp: "GMAIL",
          platform: "ANDRIOD",
          parameters: { optionalNote: "" },
          formInputs: {
            strings: {
              "": { stringInputs: { value: ["one", ""] } },
            },
            dateTime: {
              dateTimeInput: {
                msSinceEpoch: 1_787_765_400_000,
                hasDate: true,
                hasTime: true,
              },
            },
            date: { dateInput: { msSinceEpoch: 1_787_702_400_000 } },
            time: { timeInput: { hours: 14, minutes: 30 } },
          },
        },
      }),
    ).toEqual({
      hostApp: "GMAIL",
      platform: "ANDROID",
      userLocale: null,
      timeZone: null,
      parameters: { optionalNote: "" },
      formInputs: {
        strings: { kind: "strings", values: ["one", ""] },
        dateTime: {
          kind: "date-time",
          millisecondsSinceEpoch: 1_787_765_400_000,
          hasDate: true,
          hasTime: true,
        },
        date: {
          kind: "date",
          millisecondsSinceEpoch: 1_787_702_400_000,
        },
        time: { kind: "time", hours: 14, minutes: 30 },
      },
    });
  });

  it.each([
    {},
    { commonEventObject: { hostApp: "DRIVE" } },
    { commonEventObject: { hostApp: "GMAIL", platform: "DESKTOP" } },
    {
      commonEventObject: {
        hostApp: "GMAIL",
        formInputs: { time: { timeInput: { hours: 25, minutes: 0 } } },
      },
    },
  ])("rejects malformed or non-Gmail event %#", (input) => {
    expect(() => parseGoogleWorkspaceAddonEvent(input)).toThrow(
      "Invalid Google Workspace add-on event.",
    );
  });
});
