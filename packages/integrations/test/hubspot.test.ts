import { describe, expect, it, vi } from "vitest";
import { HubSpotCrmAdapter, HubSpotOAuthClient } from "../src/index.js";

describe("HubSpot OAuth", () => {
  it("builds the install URL and exchanges the authorization code", async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      const form = init?.body as URLSearchParams;
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code")).toBe("oauth-code");
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 1800,
        scopes: ["oauth", "crm.objects.contacts.write"],
        hub_id: 12345,
      });
    });
    const client = new HubSpotOAuthClient(
      { clientId: "client", clientSecret: "secret" },
      request,
    );
    const authorization = new URL(
      client.authorizationUrl({
        state: "state-value",
        redirectUri: "http://localhost:3000/callback",
      }),
    );
    expect(authorization.searchParams.get("state")).toBe("state-value");
    expect(authorization.searchParams.get("scope")).toContain(
      "crm.objects.owners.read",
    );

    const tokens = await client.exchangeCode({
      code: "oauth-code",
      redirectUri: "http://localhost:3000/callback",
    });
    expect(tokens.externalAccountId).toBe("12345");
    expect(tokens.refreshToken).toBe("refresh");
  });
});

describe("HubSpot owner writeback", () => {
  it("resolves the active owner ID and updates the contact by email", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/crm/v3/owners") {
        return Response.json({
          results: [{ id: "77", email: "ada@acme.example", archived: false }],
        });
      }
      expect(url.pathname).toContain("/contacts/buyer%40example.com");
      expect(url.searchParams.get("idProperty")).toBe("email");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({
        properties: { hubspot_owner_id: "77" },
      });
      return Response.json({ id: "contact-1" });
    });
    const adapter = new HubSpotCrmAdapter(async () => "access-token", request);

    const result = await adapter.writeOwner({
      decisionId: "decision-1",
      leadEmail: "buyer@example.com",
      ownerEmail: "ada@acme.example",
    });

    expect(result.externalReference).toContain("owner:77");
    expect(request).toHaveBeenCalledTimes(2);
  });
});
