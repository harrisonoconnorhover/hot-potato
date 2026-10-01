import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  dashboard: vi.fn(),
}));

vi.mock("../app/operator-session", () => ({
  operatorSessionForRequest: mocks.session,
  operatorRoleCanAdmin: (role: string) => role === "owner" || role === "admin",
}));

vi.mock("../app/repository", () => ({
  repository: { dashboard: mocks.dashboard },
}));

import { GET } from "../app/api/dashboard/route";

const fullDashboard = {
  organization: { name: "Acme", slug: "acme" },
  stats: { routesToday: 1, activeReps: 2, activeRules: 1, pendingJobs: 0 },
  reps: [{ id: "rep-1", email: "private@example.com" }],
  availabilitySchedules: [{ id: "schedule-1", name: "Private team week" }],
  pools: [{ id: "pool-1", members: [{ email: "private@example.com" }] }],
  rules: [{ id: "rule-1", name: "Inbound" }],
  meetingTypes: [{ id: "meeting-1" }],
  routerLinks: [{ id: "router-1", slug: "inbound" }],
  routerFormBridges: [
    { id: "bridge-1", allowedOrigins: ["https://private.example"] },
  ],
  decisions: [{ id: "decision-1" }],
};

function identity(role: "owner" | "operator") {
  return {
    sessionId: "session-1",
    operatorId: "operator-1",
    organizationId: "organization-1",
    organizationSlug: "acme",
    login: "operator@example.com",
    displayName: "Operator",
    role,
    expiresAt: new Date("2026-09-07T12:00:00.000Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dashboard.mockResolvedValue(fullDashboard);
});

describe("operator dashboard scope", () => {
  it("requires handler-level authentication", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await GET(
      new Request("https://schedule.example/api/dashboard"),
    );

    expect(response.status).toBe(401);
    expect(mocks.dashboard).not.toHaveBeenCalled();
  });

  it("keeps workflow data but removes admin-only rep and configuration records", async () => {
    mocks.session.mockResolvedValue(identity("operator"));
    const response = await GET(
      new Request("https://schedule.example/api/dashboard"),
    );
    const body = await response.json();

    expect(body.reps).toEqual([]);
    expect(body.availabilitySchedules).toEqual([]);
    expect(body.pools).toEqual([]);
    expect(body.meetingTypes).toEqual([]);
    expect(body.routerFormBridges).toEqual([]);
    expect(body.routerLinks).toEqual(fullDashboard.routerLinks);
    expect(body.rules).toEqual(fullDashboard.rules);
    expect(body.decisions).toEqual(fullDashboard.decisions);
    expect(JSON.stringify(body)).not.toContain("private@example.com");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("preserves the complete dashboard for an owner", async () => {
    mocks.session.mockResolvedValue(identity("owner"));
    const response = await GET(
      new Request("https://schedule.example/api/dashboard"),
    );

    expect(await response.json()).toEqual(fullDashboard);
  });
});
