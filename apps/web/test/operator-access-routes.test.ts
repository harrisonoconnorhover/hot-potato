import { createHash } from "node:crypto";
import { hashOperatorPassword, OperatorAccessError } from "@hot-potato/db";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  consumeRateLimit: vi.fn(),
  overview: vi.fn(),
  createInvitation: vi.fn(),
  updateMembership: vi.fn(),
  resetPassword: vi.fn(),
  revokeInvitation: vi.fn(),
  consumeAccess: vi.fn(),
  createSession: vi.fn(),
  credential: vi.fn(),
  updatePassword: vi.fn(),
  listSessions: vi.fn(),
  revokeSessionById: vi.fn(),
}));

vi.mock("../app/repository", () => ({
  repository: {
    resolveOperatorSession: mocks.resolveSession,
    consumePublicRateLimit: mocks.consumeRateLimit,
    operatorAccessOverview: mocks.overview,
    createOperatorInvitation: mocks.createInvitation,
    updateOperatorMembership: mocks.updateMembership,
    createOperatorPasswordReset: mocks.resetPassword,
    revokeOperatorInvitation: mocks.revokeInvitation,
    consumeOperatorAccessLink: mocks.consumeAccess,
    createOperatorSession: mocks.createSession,
    operatorCredential: mocks.credential,
    updateOperatorPassword: mocks.updatePassword,
    listOperatorSessions: mocks.listSessions,
    revokeOperatorSessionById: mocks.revokeSessionById,
  },
}));

import { POST as acceptAccess } from "../app/api/auth/access/route";
import { POST as changePassword } from "../app/api/auth/password/route";
import { GET as listSessions } from "../app/api/auth/sessions/route";
import { DELETE as revokeSession } from "../app/api/auth/sessions/[sessionId]/route";
import { DELETE as revokeInvitation } from "../app/api/settings/operator-invitations/[invitationId]/route";
import {
  GET as listOperators,
  POST as inviteOperator,
} from "../app/api/settings/operators/route";
import { PATCH as updateOperator } from "../app/api/settings/operators/[operatorId]/route";
import { POST as resetOperator } from "../app/api/settings/operators/[operatorId]/reset/route";

const organizationId = "b8a735ca-bd0b-4dbf-85d8-537e38113e97";
const ownerId = "37cae501-4a79-438f-9842-f56eef618020";
const memberId = "c9805955-d288-4d7f-8848-84d1bb1e7b68";
const sessionId = "7b41e7c5-f855-4a82-a167-63aa18b25015";
const otherSessionId = "f51d7a4f-fd07-46a5-b402-c87cac756974";
const invitationId = "f099f354-54ef-412b-b671-452c413de5f9";
const rawSession = `hp_session_${"s".repeat(43)}`;
const rawAccess = `hp_access_${"a".repeat(43)}`;
const rawAccessHash = createHash("sha256")
  .update(rawAccess, "utf8")
  .digest("hex");
let ownerPasswordHash = "";

function identity(role: "owner" | "admin" | "operator" = "owner") {
  return {
    sessionId,
    operatorId: ownerId,
    organizationId,
    organizationSlug: "acme",
    login: "owner@example.com",
    displayName: "Workspace Owner",
    role,
    expiresAt: new Date("2026-09-07T12:00:00.000Z"),
  };
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost:3000${path}`, {
    ...init,
    headers: {
      origin: "http://localhost:3000",
      cookie: `hp_operator_session=${rawSession}`,
      ...init.headers,
    },
  });
}

beforeAll(async () => {
  ownerPasswordHash = await hashOperatorPassword(
    "a correctly long owner password",
  );
  process.env.APP_URL = "http://localhost:3000";
  process.env.HOT_POTATO_ORG = "acme";
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveSession.mockResolvedValue(identity());
  mocks.consumeRateLimit.mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: "2026-09-01T12:15:00.000Z",
  });
  mocks.createSession.mockResolvedValue(true);
  mocks.updatePassword.mockResolvedValue(true);
  mocks.revokeSessionById.mockResolvedValue(true);
});

describe("people and access routes", () => {
  it("lists members and creates an owner-scoped one-time invitation", async () => {
    mocks.overview.mockResolvedValue({ members: [], invitations: [] });
    mocks.createInvitation.mockImplementation(async (input) => ({
      id: invitationId,
      login: input.login,
      displayName: input.displayName,
      role: input.role,
      createdAt: new Date("2026-08-31T12:00:00.000Z"),
      expiresAt: input.expiresAt,
    }));

    const listed = await listOperators(request("/api/settings/operators"));
    const invited = await inviteOperator(
      request("/api/settings/operators", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          login: "teammate@example.com",
          displayName: "Team Mate",
          role: "operator",
        }),
      }),
    );

    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      members: [],
      currentOperatorId: ownerId,
    });
    expect(invited.status).toBe(201);
    const invitation = await invited.json();
    expect(invitation.accessUrl).toMatch(
      /^http:\/\/localhost:3000\/join\/hp_access_[A-Za-z0-9_-]{43}$/,
    );
    expect(mocks.createInvitation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        createdBy: ownerId,
        login: "teammate@example.com",
        displayName: "Team Mate",
        role: "operator",
        tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(JSON.stringify(mocks.createInvitation.mock.calls)).not.toContain(
      "hp_access_",
    );
  });

  it("keeps owner management out of an admin's scope", async () => {
    mocks.resolveSession.mockResolvedValue(identity("admin"));
    mocks.createInvitation.mockRejectedValue(
      new OperatorAccessError(
        "forbidden",
        "Only an owner can manage another owner.",
      ),
    );

    const response = await inviteOperator(
      request("/api/settings/operators", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          login: "owner-two@example.com",
          displayName: "Second Owner",
          role: "owner",
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
  });

  it("denies People and Access to an operator before repository work", async () => {
    mocks.resolveSession.mockResolvedValue(identity("operator"));

    const response = await listOperators(request("/api/settings/operators"));

    expect(response.status).toBe(403);
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it("updates members, creates reset links, and revokes pending invitations", async () => {
    mocks.resetPassword.mockResolvedValue({
      id: invitationId,
      expiresAt: new Date("2026-08-31T12:30:00.000Z"),
    });
    const updated = await updateOperator(
      request(`/api/settings/operators/${memberId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "admin" }),
      }),
      { params: Promise.resolve({ operatorId: memberId }) },
    );
    const reset = await resetOperator(
      request(`/api/settings/operators/${memberId}/reset`, { method: "POST" }),
      { params: Promise.resolve({ operatorId: memberId }) },
    );
    const revoked = await revokeInvitation(
      request(`/api/settings/operator-invitations/${invitationId}`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ invitationId }) },
    );

    expect(updated.status).toBe(200);
    expect(mocks.updateMembership).toHaveBeenCalledWith({
      organizationId,
      updatedBy: ownerId,
      operatorId: memberId,
      role: "admin",
    });
    expect(reset.status).toBe(201);
    expect((await reset.json()).accessUrl).toContain("/join/hp_access_");
    expect(revoked.status).toBe(200);
    expect(mocks.revokeInvitation).toHaveBeenCalledWith({
      organizationId,
      revokedBy: ownerId,
      invitationId,
    });
  });

  it("consumes an access token once and creates a named server session", async () => {
    mocks.resolveSession.mockResolvedValue(null);
    mocks.consumeAccess.mockResolvedValue({
      ...identity("operator"),
      operatorId: memberId,
      login: "teammate@example.com",
      displayName: "Team Mate",
      passwordHash: ownerPasswordHash,
    });

    const response = await acceptAccess(
      request("/api/auth/access", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token: rawAccess,
          password: "a correctly long teammate password",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.consumeAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationSlug: "acme",
        tokenHash: rawAccessHash,
        passwordHash: expect.stringMatching(/^scrypt\$/),
        session: expect.objectContaining({
          tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          userAgent: null,
        }),
      }),
    );
    expect(mocks.createSession).not.toHaveBeenCalled();
    const sessionToken = response.headers
      .get("set-cookie")
      ?.match(/hp_operator_session=(hp_session_[A-Za-z0-9_-]{43})/)?.[1];
    expect(sessionToken).toBeTruthy();
    expect(mocks.consumeAccess.mock.calls[0]?.[0].session.tokenHash).toBe(
      createHash("sha256").update(sessionToken!, "utf8").digest("hex"),
    );
    expect(response.headers.get("set-cookie")).toContain(
      "hp_operator_session=hp_session_",
    );
  });

  it("changes the current password and revokes only other sessions", async () => {
    mocks.credential.mockResolvedValue({
      ...identity(),
      passwordHash: ownerPasswordHash,
    });

    const response = await changePassword(
      request("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword: "a correctly long owner password",
          newPassword: "a different secure owner password",
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.updatePassword).toHaveBeenCalledWith({
      organizationId,
      operatorId: ownerId,
      currentSessionId: sessionId,
      expectedPasswordHash: ownerPasswordHash,
      passwordHash: expect.stringMatching(/^scrypt\$/),
    });
  });

  it("rate-limits repeated current-password attempts", async () => {
    mocks.consumeRateLimit.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: new Date(Date.now() + 60_000),
    });

    const response = await changePassword(
      request("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword: "a guessed current password",
          newPassword: "a different secure owner password",
        }),
      }),
    );

    expect(response.status).toBe(429);
    expect(mocks.credential).not.toHaveBeenCalled();
  });

  it("lists active sessions and lets a member end a different one", async () => {
    mocks.listSessions.mockResolvedValue([
      {
        sessionId,
        createdAt: new Date("2026-08-31T10:00:00.000Z"),
        lastSeenAt: new Date("2026-08-31T12:00:00.000Z"),
        expiresAt: new Date("2026-09-07T10:00:00.000Z"),
        userAgent: "Browser",
      },
    ]);
    const listed = await listSessions(request("/api/auth/sessions"));
    const revoked = await revokeSession(
      request(`/api/auth/sessions/${otherSessionId}`, { method: "DELETE" }),
      { params: Promise.resolve({ sessionId: otherSessionId }) },
    );

    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ currentSessionId: sessionId });
    expect(revoked.status).toBe(200);
    expect(mocks.revokeSessionById).toHaveBeenCalledWith({
      organizationId,
      operatorId: ownerId,
      sessionId: otherSessionId,
      currentSessionId: sessionId,
    });
  });
});
