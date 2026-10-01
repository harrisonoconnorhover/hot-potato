import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const organizationId = "0a4e20d8-9692-4bf9-afd1-b0a017c02b17";
const operatorId = "d5cfd223-b78f-4497-b108-6bcdf93b8af4";
const repId = "8a90b1e8-f323-4f24-a19c-41b4a7766545";

const mocks = vi.hoisted(() => ({
  authRep: vi.fn(),
  session: vi.fn(),
  providerConfigured: vi.fn(),
  createAttempt: vi.fn(),
  consumeAttempt: vi.fn(),
  profile: vi.fn(),
  updateSettings: vi.fn(),
  catalogSettings: vi.fn(),
  syncCatalog: vi.fn(),
  connect: vi.fn(),
  authorizationUrl: vi.fn(),
}));

vi.mock("@hot-potato/integrations", () => ({
  createOAuthState: () => "raw-oauth-state",
  createOAuthPkce: () => ({
    verifier: "pkce-verifier",
    challenge: "pkce-challenge",
  }),
  oauthStatesEqual: (left: string, right: string) => left === right,
  providerConfigured: mocks.providerConfigured,
}));

vi.mock("../app/connections", () => ({
  parseCalendarProvider: (value: string) =>
    value === "google" || value === "microsoft" ? value : null,
  hashRepCalendarOAuthState: (state: string) => `hash:${state}`,
  repCalendarCallbackUrl: (_request: Request, provider: string) =>
    `https://schedule.example/api/rep-connections/${provider}/callback`,
  repCalendarManager: () => ({
    authorizationUrl: mocks.authorizationUrl,
    connect: mocks.connect,
  }),
  repCalendarStateCookie: (provider: string) => `state-${provider}`,
  repCalendarVerifierCookie: (provider: string) => `verifier-${provider}`,
  repConnectionResultUrl: (
    _request: Request,
    provider: string,
    status: string,
    returnTo = "calendar-readiness",
  ) =>
    new URL(
      `https://schedule.example/?repConnection=${provider}&status=${status}#${returnTo}`,
    ),
}));

vi.mock("../app/operator-rep-calendar", () => ({
  operatorRepCalendarForRequest: mocks.authRep,
}));

vi.mock("../app/operator-session", () => ({
  operatorSessionForRequest: mocks.session,
}));

vi.mock("../app/rep-calendar-catalog", () => ({
  repCalendarCatalogFailure: () => null,
  repCalendarCatalogSettings: mocks.catalogSettings,
  syncRepCalendarCatalog: mocks.syncCatalog,
}));

vi.mock("../app/repository", () => ({
  repository: {
    createRepCalendarOAuthAttempt: mocks.createAttempt,
    consumeRepCalendarOAuthAttempt: mocks.consumeAttempt,
    operatorRepCalendarProfile: mocks.profile,
    updateRepCalendarSettings: mocks.updateSettings,
  },
}));

import { GET as calendarCallback } from "../app/api/rep-connections/[provider]/callback/route";
import { POST as startCalendarConnection } from "../app/api/reps/[repId]/connections/[provider]/start/route";
import { GET as myCalendar } from "../app/api/me/calendar/route";
import {
  GET as calendarSettings,
  POST as refreshCalendars,
  PUT as updateCalendars,
} from "../app/api/settings/reps/[repId]/calendars/[provider]/route";

function identity(role: "owner" | "admin" | "operator" = "operator") {
  return {
    sessionId: "session-1",
    operatorId,
    organizationId,
    organizationSlug: "acme",
    login: "rep@example.com",
    displayName: "Routing Rep",
    role,
    expiresAt: new Date("2026-09-07T12:00:00.000Z"),
  };
}

const context = {
  params: Promise.resolve({ repId, provider: "google" }),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.providerConfigured.mockReturnValue(true);
  mocks.authorizationUrl.mockReturnValue(
    "https://accounts.example/authorize?state=raw-oauth-state",
  );
  mocks.authRep.mockResolvedValue({ identity: identity() });
  mocks.session.mockResolvedValue(identity());
  mocks.createAttempt.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue(undefined);
  mocks.syncCatalog.mockResolvedValue({ connected: true });
  mocks.catalogSettings.mockResolvedValue({ connected: true });
  mocks.updateSettings.mockResolvedValue(undefined);
});

describe("representative calendar OAuth routes", () => {
  it("binds a start attempt to operator, rep, provider, return surface, and a state hash", async () => {
    const response = await startCalendarConnection(
      new NextRequest(
        `https://schedule.example/api/reps/${repId}/connections/google/start?returnTo=my-calendar`,
        { method: "POST", headers: { origin: "https://schedule.example" } },
      ),
      context,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://accounts.example/authorize?state=raw-oauth-state",
    );
    expect(mocks.authRep).toHaveBeenCalledWith(
      expect.any(Request),
      repId,
      true,
    );
    expect(mocks.createAttempt).toHaveBeenCalledWith({
      organizationId,
      operatorId,
      repId,
      provider: "google",
      stateHash: "hash:raw-oauth-state",
      returnTo: "my-calendar",
      expiresAt: expect.any(Date),
    });
    const cookieHeader = response.headers.get("set-cookie") ?? "";
    expect(cookieHeader).toContain("state-google=raw-oauth-state");
    expect(cookieHeader).toContain("verifier-google=pkce-verifier");
    expect(cookieHeader).not.toContain(repId);
  });

  it("does not start OAuth when representative scope is denied", async () => {
    mocks.authRep.mockResolvedValue({
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    const response = await startCalendarConnection(
      new NextRequest(
        `https://schedule.example/api/reps/${repId}/connections/google/start`,
        { method: "POST" },
      ),
      context,
    );

    expect(response.status).toBe(403);
    expect(mocks.createAttempt).not.toHaveBeenCalled();
    expect(mocks.authorizationUrl).not.toHaveBeenCalled();
  });

  it("consumes the bound attempt once and ignores browser-supplied rep identity", async () => {
    mocks.consumeAttempt.mockResolvedValue({
      repId,
      provider: "google",
      returnTo: "my-calendar",
    });
    const request = new NextRequest(
      "https://schedule.example/api/rep-connections/google/callback?state=raw-oauth-state&code=provider-code",
      {
        headers: {
          cookie: `state-google=raw-oauth-state; verifier-google=pkce-verifier; hp_rep_oauth_rep_google=attacker-rep`,
        },
      },
    );
    const response = await calendarCallback(request, {
      params: Promise.resolve({ provider: "google" }),
    });

    expect(mocks.consumeAttempt).toHaveBeenCalledWith({
      organizationId,
      operatorId,
      provider: "google",
      stateHash: "hash:raw-oauth-state",
    });
    expect(mocks.connect).toHaveBeenCalledWith("acme", repId, "google", {
      code: "provider-code",
      redirectUri:
        "https://schedule.example/api/rep-connections/google/callback",
      codeVerifier: "pkce-verifier",
    });
    expect(mocks.syncCatalog).toHaveBeenCalledWith({
      organizationSlug: "acme",
      repId,
      provider: "google",
    });
    expect(response.headers.get("location")).toBe(
      "https://schedule.example/?repConnection=google&status=connected#my-calendar",
    );
  });

  it("fails closed on a replayed or tampered durable attempt", async () => {
    mocks.consumeAttempt.mockResolvedValue(null);
    const response = await calendarCallback(
      new NextRequest(
        "https://schedule.example/api/rep-connections/google/callback?state=raw-oauth-state&code=provider-code",
        {
          headers: {
            cookie:
              "state-google=raw-oauth-state; verifier-google=pkce-verifier",
          },
        },
      ),
      { params: Promise.resolve({ provider: "google" }) },
    );

    expect(response.headers.get("location")).toContain("status=invalid-state");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.syncCatalog).not.toHaveBeenCalled();
  });

  it("consumes a denied provider attempt without exchanging a token", async () => {
    mocks.consumeAttempt.mockResolvedValue({
      repId,
      provider: "google",
      returnTo: "calendar-readiness",
    });
    const response = await calendarCallback(
      new NextRequest(
        "https://schedule.example/api/rep-connections/google/callback?state=raw-oauth-state&error=access_denied",
        {
          headers: {
            cookie:
              "state-google=raw-oauth-state; verifier-google=pkce-verifier",
          },
        },
      ),
      { params: Promise.resolve({ provider: "google" }) },
    );

    expect(mocks.consumeAttempt).toHaveBeenCalledOnce();
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toContain("status=denied");
    expect(response.headers.get("location")).toContain("#calendar-readiness");
  });
});

describe("scoped representative calendar APIs", () => {
  it("returns only the signed-in operator's linked calendar profile", async () => {
    const profile = {
      organization: { id: organizationId, name: "Acme", slug: "acme" },
      rep: { id: repId, email: "rep@example.com" },
    };
    mocks.profile.mockResolvedValue(profile);

    const response = await myCalendar(
      new Request("https://schedule.example/api/me/calendar", {
        headers: { cookie: "hp_operator_session=session" },
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.profile).toHaveBeenCalledWith("acme", operatorId);
    expect(body).toMatchObject({ linked: true, profile });
    expect(JSON.stringify(body)).not.toContain("accessToken");
    expect(JSON.stringify(body)).not.toContain("refreshToken");
  });

  it("authorizes reads and same-origin writes at the route handler", async () => {
    const getRequest = new Request(
      `https://schedule.example/api/settings/reps/${repId}/calendars/google`,
    );
    const getResponse = await calendarSettings(getRequest, context);
    expect(getResponse.status).toBe(200);
    expect(mocks.authRep).toHaveBeenCalledWith(getRequest, repId, false);

    const putRequest = new Request(
      `https://schedule.example/api/settings/reps/${repId}/calendars/google`,
      {
        method: "PUT",
        headers: {
          origin: "https://schedule.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          selectedCalendarIds: ["primary", "sales"],
          makeActive: true,
        }),
      },
    );
    const putResponse = await updateCalendars(putRequest, context);

    expect(putResponse.status).toBe(200);
    expect(mocks.authRep).toHaveBeenCalledWith(putRequest, repId, true);
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      organizationSlug: "acme",
      repId,
      provider: "google",
      selectedCalendarIds: ["primary", "sales"],
      makeActive: true,
    });
  });

  it("rejects unauthorized writes before provider or repository access", async () => {
    mocks.authRep.mockResolvedValue({
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    const request = new Request(
      `https://schedule.example/api/settings/reps/${repId}/calendars/google`,
      { method: "POST", headers: { origin: "https://schedule.example" } },
    );
    const response = await refreshCalendars(request, context);

    expect(response.status).toBe(403);
    expect(mocks.syncCatalog).not.toHaveBeenCalled();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("bounds calendar settings request bodies", async () => {
    const response = await updateCalendars(
      new Request(
        `https://schedule.example/api/settings/reps/${repId}/calendars/google`,
        {
          method: "PUT",
          headers: {
            origin: "https://schedule.example",
            "content-type": "application/json",
          },
          body: JSON.stringify({ selectedCalendarIds: ["x".repeat(9_000)] }),
        },
      ),
      context,
    );

    expect(response.status).toBe(413);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });
});
