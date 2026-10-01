import { createHash } from "node:crypto";
import { hashOperatorPassword } from "@hot-potato/db";
import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  consumeRateLimit: vi.fn(),
  credential: vi.fn(),
  createSession: vi.fn(),
  resolveSession: vi.fn(),
  revokeSession: vi.fn(),
  listKeys: vi.fn(),
  createKey: vi.fn(),
  revokeKey: vi.fn(),
}));

vi.mock("../app/repository", () => ({
  repository: {
    consumePublicRateLimit: mocks.consumeRateLimit,
    operatorCredential: mocks.credential,
    createOperatorSession: mocks.createSession,
    resolveOperatorSession: mocks.resolveSession,
    revokeOperatorSession: mocks.revokeSession,
    listEmailToolAccessKeys: mocks.listKeys,
    createEmailToolAccessKey: mocks.createKey,
    revokeEmailToolAccessKey: mocks.revokeKey,
  },
}));

import { POST as login } from "../app/api/auth/login/route";
import { POST as logout } from "../app/api/auth/logout/route";
import { GET as session } from "../app/api/auth/session/route";
import { GET as listEmailKeys } from "../app/api/settings/email-tools/keys/route";
import { POST as startOrganizationConnection } from "../app/api/connections/[provider]/start/route";
import { POST as startRepConnection } from "../app/api/reps/[repId]/connections/[provider]/start/route";

const previousAppUrl = process.env.APP_URL;
const previousOrganization = process.env.HOT_POTATO_ORG;
const rawSession = `hp_session_${"a".repeat(43)}`;
const sessionHash = createHash("sha256").update(rawSession).digest("hex");
let passwordHash = "";

function request(path: string, init: RequestInit = {}, includeOrigin = true) {
  return new Request(`http://localhost:3000${path}`, {
    ...init,
    headers: {
      ...(includeOrigin ? { origin: "http://localhost:3000" } : {}),
      ...init.headers,
    },
  });
}

function identity(role: "owner" | "admin" | "operator" = "owner") {
  return {
    sessionId: "7b41e7c5-f855-4a82-a167-63aa18b25015",
    operatorId: "37cae501-4a79-438f-9842-f56eef618020",
    organizationId: "b8a735ca-bd0b-4dbf-85d8-537e38113e97",
    organizationSlug: "acme",
    login: "owner@example.com",
    displayName: "Workspace Owner",
    role,
    expiresAt: new Date("2026-09-07T12:00:00.000Z"),
  };
}

beforeAll(async () => {
  passwordHash = await hashOperatorPassword("a correctly long owner password");
  process.env.APP_URL = "http://localhost:3000";
  process.env.HOT_POTATO_ORG = "acme";
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.consumeRateLimit.mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: "2026-09-01T12:15:00.000Z",
  });
  mocks.createSession.mockResolvedValue(true);
});

afterAll(() => {
  if (previousAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = previousAppUrl;
  if (previousOrganization === undefined) delete process.env.HOT_POTATO_ORG;
  else process.env.HOT_POTATO_ORG = previousOrganization;
});

describe("operator authentication routes", () => {
  it("creates a revocable, HTTP-only session for a valid named owner", async () => {
    mocks.credential.mockResolvedValue({
      ...identity(),
      passwordHash,
    });

    const response = await login(
      request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          login: "OWNER@example.com",
          password: "a correctly long owner password",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      operator: {
        displayName: "Workspace Owner",
        login: "owner@example.com",
        role: "owner",
      },
    });
    expect(mocks.credential).toHaveBeenCalledWith("acme", "owner@example.com");
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: identity().organizationId,
        operatorId: identity().operatorId,
        tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        expiresAt: expect.any(Date),
      }),
    );
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("hp_operator_session=hp_session_");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).toContain("Max-Age=604800");
    expect(cookie).not.toContain("a correctly long owner password");

    const tunnelResponse = await login(
      new Request("https://temporary-tunnel.example/api/auth/login", {
        method: "POST",
        headers: {
          origin: "https://temporary-tunnel.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          login: "owner@example.com",
          password: "a correctly long owner password",
        }),
      }),
    );
    expect(tunnelResponse.status).toBe(200);
    expect(tunnelResponse.headers.get("set-cookie")).toContain("Secure");
  });

  it("uses one generic failure for bad credentials and rejects cross-origin login", async () => {
    mocks.credential.mockResolvedValue({
      ...identity(),
      passwordHash,
    });
    const wrong = await login(
      request("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          login: "owner@example.com",
          password: "a different long owner password",
        }),
      }),
    );
    const crossOrigin = await login(
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          login: "owner@example.com",
          password: "a correctly long owner password",
        }),
      }),
    );

    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ code: "invalid_credentials" });
    expect(crossOrigin.status).toBe(403);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("returns the current identity and revokes the exact session on sign-out", async () => {
    mocks.resolveSession.mockResolvedValue(identity());
    mocks.revokeSession.mockResolvedValue(true);
    const cookie = { cookie: `hp_operator_session=${rawSession}` };

    const current = await session(
      request("/api/auth/session", { headers: cookie }),
    );
    const signedOut = await logout(
      request("/api/auth/logout", { method: "POST", headers: cookie }),
    );

    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      operator: { displayName: "Workspace Owner", role: "owner" },
    });
    expect(mocks.resolveSession).toHaveBeenCalledWith("acme", sessionHash);
    expect(mocks.revokeSession).toHaveBeenCalledWith(sessionHash);
    expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("clears the browser cookie when session revocation is temporarily unavailable", async () => {
    mocks.revokeSession.mockRejectedValue(new Error("database unavailable"));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const signedOut = await logout(
      request("/api/auth/logout", {
        method: "POST",
        headers: { cookie: `hp_operator_session=${rawSession}` },
      }),
    );

    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(consoleError).toHaveBeenCalledWith(
      "Operator session revocation failed:",
      "Error",
    );
    consoleError.mockRestore();
  });

  it("enforces the admin role again inside Outlook key management", async () => {
    mocks.resolveSession.mockResolvedValue(identity("operator"));
    const cookie = { cookie: `hp_operator_session=${rawSession}` };

    const denied = await listEmailKeys(
      request(
        "/api/settings/email-tools/keys?repId=37cae501-4a79-438f-9842-f56eef618020",
        { headers: cookie },
      ),
    );

    expect(denied.status).toBe(403);
    expect(mocks.listKeys).not.toHaveBeenCalled();
  });

  it("enforces the admin role inside organization and rep OAuth starts", async () => {
    mocks.resolveSession.mockResolvedValue(identity("operator"));
    const cookie = { cookie: `hp_operator_session=${rawSession}` };

    const organization = await startOrganizationConnection(
      new NextRequest("http://localhost:3000/api/connections/google/start", {
        method: "POST",
        headers: cookie,
      }),
      { params: Promise.resolve({ provider: "google" }) },
    );
    const rep = await startRepConnection(
      new NextRequest(
        `http://localhost:3000/api/reps/${identity().operatorId}/connections/microsoft/start`,
        { method: "POST", headers: cookie },
      ),
      {
        params: Promise.resolve({
          repId: identity().operatorId,
          provider: "microsoft",
        }),
      },
    );

    expect(organization.status).toBe(403);
    expect(rep.status).toBe(403);
  });
});
