import { beforeEach, describe, expect, it, vi } from "vitest";

const repId = "8a90b1e8-f323-4f24-a19c-41b4a7766545";
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  canManage: vi.fn(),
}));

vi.mock("../app/repository", () => ({
  repository: {
    operatorCanManageRepCalendar: mocks.canManage,
  },
}));

vi.mock("../app/operator-session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/operator-session")>()),
  operatorSessionForRequest: mocks.session,
}));

import { operatorRepCalendarForRequest } from "../app/operator-rep-calendar";

const identity = {
  sessionId: "session-1",
  operatorId: "d5cfd223-b78f-4497-b108-6bcdf93b8af4",
  organizationId: "0a4e20d8-9692-4bf9-afd1-b0a017c02b17",
  organizationSlug: "acme",
  login: "rep@example.com",
  displayName: "Routing Rep",
  role: "operator" as const,
  expiresAt: new Date("2026-09-07T12:00:00.000Z"),
};

beforeEach(() => {
  vi.clearAllMocks();
  process.env.APP_URL = "https://schedule.example";
  mocks.session.mockResolvedValue(identity);
  mocks.canManage.mockResolvedValue(true);
});

describe("representative calendar authorization", () => {
  it("rejects unauthenticated requests before repository access", async () => {
    mocks.session.mockResolvedValue(null);
    const result = await operatorRepCalendarForRequest(
      new Request("https://schedule.example/api/me/calendar"),
      repId,
    );

    expect(result.response?.status).toBe(401);
    expect(mocks.canManage).not.toHaveBeenCalled();
  });

  it("requires the configured application origin for mutations", async () => {
    const result = await operatorRepCalendarForRequest(
      new Request("https://schedule.example/api/settings/calendar", {
        method: "PUT",
        headers: { origin: "https://attacker.example" },
      }),
      repId,
      true,
    );

    expect(result.response?.status).toBe(403);
    expect(mocks.canManage).not.toHaveBeenCalled();
  });

  it("checks the signed-in operator and organization against the exact rep", async () => {
    const request = new Request(
      "https://schedule.example/api/settings/calendar",
      { method: "PUT", headers: { origin: "https://schedule.example" } },
    );
    const allowed = await operatorRepCalendarForRequest(request, repId, true);

    expect(allowed.identity).toEqual(identity);
    expect(mocks.canManage).toHaveBeenCalledWith({
      organizationId: identity.organizationId,
      operatorId: identity.operatorId,
      repId,
    });
  });

  it("fails closed when the operator-to-rep match is absent or ambiguous", async () => {
    mocks.canManage.mockResolvedValue(false);
    const result = await operatorRepCalendarForRequest(
      new Request("https://schedule.example/api/settings/calendar"),
      repId,
    );

    expect(result.response?.status).toBe(403);
    expect(await result.response?.json()).toMatchObject({
      error: expect.stringContaining("only the representative calendar"),
    });
  });
});
