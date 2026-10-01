import { describe, expect, it, vi } from "vitest";
import {
  HUBSPOT_CONTACT_READ_SCOPE,
  HUBSPOT_OWNER_READ_SCOPE,
  HubSpotCrmAdapter,
  HubSpotOAuthClient,
  ProviderHttpError,
} from "../src/index.js";

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
      HUBSPOT_OWNER_READ_SCOPE,
    );
    expect(authorization.searchParams.get("scope")).toContain(
      HUBSPOT_CONTACT_READ_SCOPE,
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
      if (url.pathname === "/crm/owners/2026-03") {
        return Response.json({
          results: [
            { id: "queue-1", type: "QUEUE", archived: false },
            {
              id: "77",
              type: "PERSON",
              email: "ada@acme.example",
              archived: false,
            },
          ],
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

  it("does not start owner lookup or writeback after its deadline aborts", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>();
    const adapter = new HubSpotCrmAdapter(async () => {
      controller.abort();
      return "access-token";
    }, request);

    await expect(
      adapter.writeOwner({
        decisionId: "decision-aborted",
        leadEmail: "buyer@example.com",
        ownerEmail: "ada@acme.example",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled();
  });

  it("writes every booked co-host role in one contact update", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/crm/properties/2026-03/contacts/")) {
        const propertyName = decodeURIComponent(
          url.pathname.split("/").at(-1)!,
        );
        return Response.json({
          name: propertyName,
          archived: false,
          externalOptions: true,
          referencedObjectType: "OWNER",
          modificationMetadata: { readOnlyValue: false },
        });
      }
      if (url.pathname === "/crm/owners/2026-03") {
        return Response.json({
          results: [
            {
              id: "77",
              type: "PERSON",
              email: "engineer@acme.example",
              archived: false,
            },
            {
              id: "88",
              type: "PERSON",
              email: "executive@acme.example",
              archived: false,
            },
          ],
        });
      }
      expect(url.pathname).toContain("/contacts/buyer%40example.com");
      expect(url.searchParams.get("idProperty")).toBe("email");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({
        properties: {
          technical_owner: "77",
          executive_sponsor: "88",
        },
      });
      return Response.json({ id: "contact-1" });
    });
    const adapter = new HubSpotCrmAdapter(async () => "access-token", request);

    const result = await adapter.writeRoles({
      bookingId: "booking-1",
      leadEmail: " Buyer@Example.COM ",
      roleOwners: [
        {
          propertyName: "technical_owner",
          ownerEmail: "Engineer@Acme.Example",
        },
        {
          propertyName: "executive_sponsor",
          ownerEmail: "executive@acme.example",
        },
      ],
    });

    expect(result.externalReference).toBe(
      "hubspot:contact:buyer@example.com:roles:2",
    );
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("rejects duplicate role properties before requesting HubSpot", async () => {
    const request = vi.fn<typeof fetch>();
    const adapter = new HubSpotCrmAdapter(async () => "access-token", request);

    await expect(
      adapter.writeRoles({
        bookingId: "booking-duplicate",
        leadEmail: "buyer@example.com",
        roleOwners: [
          { propertyName: "technical_owner", ownerEmail: "one@example.com" },
          { propertyName: "technical_owner", ownerEmail: "two@example.com" },
        ],
      }),
    ).rejects.toThrow("duplicate owner property");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a role mapping that is not a writable HubSpot user property", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(
        "/crm/properties/2026-03/contacts/technical_owner",
      );
      return Response.json({
        name: "technical_owner",
        archived: false,
        externalOptions: false,
        referencedObjectType: null,
        modificationMetadata: { readOnlyValue: false },
      });
    });
    const adapter = new HubSpotCrmAdapter(async () => "access-token", request);

    await expect(
      adapter.writeRoles({
        bookingId: "booking-text-property",
        leadEmail: "buyer@example.com",
        roleOwners: [
          {
            propertyName: "technical_owner",
            ownerEmail: "engineer@example.com",
          },
        ],
      }),
    ).rejects.toThrow("not a writable contact user property");
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("HubSpot contact ownership lookup", () => {
  it("normalizes the contact and resolved owner emails on current API endpoints", async () => {
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(init?.headers).toEqual({
        authorization: "Bearer access-token",
      });
      if (
        url.pathname === "/crm/objects/2026-03/contacts/buyer%40example.com"
      ) {
        expect(url.searchParams.get("idProperty")).toBe("email");
        expect(url.searchParams.get("properties")).toBe("hubspot_owner_id");
        expect(url.searchParams.get("archived")).toBe("false");
        return Response.json({
          id: "contact-1",
          properties: { hubspot_owner_id: "77" },
        });
      }
      expect(url.pathname).toBe("/crm/owners/2026-03/77");
      expect(url.searchParams.get("idProperty")).toBe("id");
      expect(url.searchParams.get("archived")).toBe("false");
      return Response.json({
        id: "77",
        email: " Owner@Acme.Example ",
        archived: false,
      });
    });
    const adapter = new HubSpotCrmAdapter(async () => "access-token", request);

    await expect(
      adapter.ownerEmailForContact(" Buyer@Example.COM "),
    ).resolves.toBe("owner@acme.example");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("routes normally when the contact or its owner is absent", async () => {
    const missingContactRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));
    const missingContact = new HubSpotCrmAdapter(
      async () => "access-token",
      missingContactRequest,
    );
    await expect(
      missingContact.ownerEmailForContact("buyer@example.com"),
    ).resolves.toBeNull();
    expect(missingContactRequest).toHaveBeenCalledTimes(1);

    const missingOwnerRequest = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/contacts/")) {
        return Response.json({
          id: "contact-1",
          properties: { hubspot_owner_id: "77" },
        });
      }
      return new Response(null, { status: 404 });
    });
    const missingOwner = new HubSpotCrmAdapter(
      async () => "access-token",
      missingOwnerRequest,
    );
    await expect(
      missingOwner.ownerEmailForContact("buyer@example.com"),
    ).resolves.toBeNull();
    expect(missingOwnerRequest).toHaveBeenCalledTimes(2);

    const unassignedRequest = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: "contact-1",
        properties: { hubspot_owner_id: "" },
      }),
    );
    const unassigned = new HubSpotCrmAdapter(
      async () => "access-token",
      unassignedRequest,
    );
    await expect(
      unassigned.ownerEmailForContact("buyer@example.com"),
    ).resolves.toBeNull();
    expect(unassignedRequest).toHaveBeenCalledTimes(1);

    const queueOwnerRequest = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/contacts/")) {
        return Response.json({
          id: "contact-1",
          properties: { hubspot_owner_id: "queue-1" },
        });
      }
      return Response.json({
        id: "queue-1",
        type: "QUEUE",
        archived: false,
      });
    });
    const queueOwned = new HubSpotCrmAdapter(
      async () => "access-token",
      queueOwnerRequest,
    );
    await expect(
      queueOwned.ownerEmailForContact("buyer@example.com"),
    ).resolves.toBeNull();
    expect(queueOwnerRequest).toHaveBeenCalledTimes(2);
  });

  it.each([401, 429, 503])(
    "surfaces HTTP %i instead of treating the lookup as unowned",
    async (status) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(`provider failure ${status}`, { status }),
        );
      const adapter = new HubSpotCrmAdapter(
        async () => "access-token",
        request,
      );

      const error = await adapter
        .ownerEmailForContact("buyer@example.com")
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(ProviderHttpError);
      expect(error).toMatchObject({
        provider: "hubspot",
        operation: "contact owner lookup",
        status,
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
});
