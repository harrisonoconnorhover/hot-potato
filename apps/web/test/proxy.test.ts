import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
}));

vi.mock("../app/operator-session", () => ({
  operatorSessionForRequest: mocks.session,
  operatorRoleCanAdmin: (role: string) => role === "owner" || role === "admin",
}));

import { config, proxy } from "../proxy";

function identity(role: "owner" | "admin" | "operator" = "owner") {
  return {
    sessionId: "session-1",
    operatorId: "operator-1",
    organizationId: "organization-1",
    organizationSlug: "acme",
    login: "owner@example.com",
    displayName: "Workspace Owner",
    role,
    expiresAt: new Date("2026-09-07T12:00:00.000Z"),
  };
}

beforeEach(() => {
  mocks.session.mockReset();
});

describe("operator proxy", () => {
  it("keeps handoff, reporting, and session identity inside the operator matcher", () => {
    expect(config.matcher).toContain("/api/handoff/:path*");
    expect(config.matcher).toContain("/api/reporting/:path*");
    expect(config.matcher).toContain("/api/auth/session");
    expect(config.matcher).toContain("/api/auth/password");
    expect(config.matcher).toContain("/api/auth/sessions/:path*");
    expect(config.matcher).toContain("/api/me/:path*");
  });

  it("returns JSON for an unauthenticated API and redirects a page to login", async () => {
    mocks.session.mockResolvedValue(null);

    const api = await proxy(
      new NextRequest("https://schedule.example/api/reporting?days=7"),
    );
    const page = await proxy(
      new NextRequest("https://schedule.example/?section=reporting"),
    );

    expect(api.status).toBe(401);
    expect(api.headers.get("cache-control")).toBe("no-store");
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe(
      "https://schedule.example/login?next=%2F%3Fsection%3Dreporting",
    );
  });

  it("lets operators run handoffs but reserves settings for admins", async () => {
    mocks.session.mockResolvedValue(identity("operator"));

    const handoff = await proxy(
      new NextRequest("https://schedule.example/api/handoff/qualify"),
    );
    const settings = await proxy(
      new NextRequest("https://schedule.example/api/settings/email-tools/keys"),
    );

    expect(handoff.status).toBe(200);
    expect(handoff.headers.get("x-middleware-next")).toBe("1");
    expect(settings.status).toBe(403);
  });

  it("lets the handler enforce exact self-calendar scope without opening other rep APIs", async () => {
    mocks.session.mockResolvedValue(identity("operator"));
    const repId = "8a90b1e8-f323-4f24-a19c-41b4a7766545";

    const selfCalendar = await proxy(
      new NextRequest(
        `https://schedule.example/api/settings/reps/${repId}/calendars/google`,
      ),
    );
    const selfWorkingHours = await proxy(
      new NextRequest(
        `https://schedule.example/api/settings/reps/${repId}/working-hours`,
      ),
    );
    const oauthStart = await proxy(
      new NextRequest(
        `https://schedule.example/api/reps/${repId}/connections/microsoft/start`,
      ),
    );
    const arbitraryRepApi = await proxy(
      new NextRequest(`https://schedule.example/api/reps/${repId}`),
    );

    expect(selfCalendar.headers.get("x-middleware-next")).toBe("1");
    expect(selfWorkingHours.headers.get("x-middleware-next")).toBe("1");
    expect(oauthStart.headers.get("x-middleware-next")).toBe("1");
    expect(arbitraryRepApi.status).toBe(403);
  });

  it("allows an authenticated owner to manage Outlook access keys", async () => {
    mocks.session.mockResolvedValue(identity("owner"));

    const response = await proxy(
      new NextRequest("https://schedule.example/api/settings/email-tools/keys"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("keeps signed provider callbacks public", async () => {
    const response = await proxy(
      new NextRequest(
        "https://schedule.example/api/connections/google/callback?code=signed",
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.session).not.toHaveBeenCalled();
  });
});
