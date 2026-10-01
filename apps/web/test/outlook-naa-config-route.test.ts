import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/email-tools/outlook-auth/config/route";

const clientId = "11111111-2222-4333-8444-555555555555";

describe("Outlook NAA public configuration route", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("stays disabled until an application ID is configured", async () => {
    vi.stubEnv("OUTLOOK_NAA_CLIENT_ID", "");
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ enabled: false });
  });

  it("returns only derived public client configuration", async () => {
    vi.stubEnv("OUTLOOK_NAA_CLIENT_ID", clientId);
    vi.stubEnv("APP_URL", "https://schedule.example.com");
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      enabled: true,
      clientId,
      audience: clientId,
      scope: `api://schedule.example.com/${clientId}/access_as_user`,
      brokerRedirectUri: "brk-multihub://schedule.example.com",
    });
  });

  it("fails closed on malformed deployment configuration", async () => {
    vi.stubEnv("OUTLOOK_NAA_CLIENT_ID", "not-a-guid");
    vi.stubEnv("APP_URL", "https://schedule.example.com");
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "outlook_auth_unavailable",
    });
  });
});
