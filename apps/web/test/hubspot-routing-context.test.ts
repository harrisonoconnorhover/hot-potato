import {
  HUBSPOT_CONTACT_READ_SCOPE,
  HUBSPOT_OWNER_READ_SCOPE,
  ProviderHttpError,
} from "@hot-potato/integrations";
import { describe, expect, it, vi } from "vitest";
import {
  HubSpotOwnershipConfigurationError,
  HubSpotOwnershipLookupError,
  HubSpotReconnectRequiredError,
  HUBSPOT_OWNERSHIP_LOOKUP_TIMEOUT_MS,
  leadWithAuthoritativeHubSpotOwner,
  resolveHubSpotOwnership,
  type HubSpotOwnershipDependencies,
} from "../app/hubspot-routing-context";

const configuredEnvironment = {
  OAUTH_ENCRYPTION_KEY: "configured-encryption-key",
  HUBSPOT_CLIENT_ID: "hubspot-client",
  HUBSPOT_CLIENT_SECRET: "hubspot-secret",
};

function connection(
  overrides: Partial<{
    connected: boolean;
    scopes: string[];
  }> = {},
) {
  return {
    provider: "hubspot",
    connected: true,
    scopes: [HUBSPOT_CONTACT_READ_SCOPE, HUBSPOT_OWNER_READ_SCOPE],
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<HubSpotOwnershipDependencies> = {},
): HubSpotOwnershipDependencies {
  return {
    environment: configuredEnvironment,
    repository: {
      connectionStatuses: vi.fn().mockResolvedValue([connection()]),
    },
    createOwnerLookup: vi.fn().mockReturnValue({
      ownerEmailForContact: vi.fn().mockResolvedValue("owner@acme.example"),
    }),
    ...overrides,
  };
}

describe("HubSpot routing ownership context", () => {
  it("routes normally when HubSpot has never been connected", async () => {
    const createOwnerLookup = vi.fn();
    const resolution = await resolveHubSpotOwnership(
      { organizationSlug: "acme", contactEmail: "buyer@example.com" },
      dependencies({
        environment: {},
        repository: {
          connectionStatuses: vi.fn().mockResolvedValue([]),
        },
        createOwnerLookup,
      }),
    );

    expect(resolution).toEqual({ checked: false, ownerEmail: null });
    expect(createOwnerLookup).not.toHaveBeenCalled();
  });

  it("routes normally without calling HubSpot when the organization is disconnected", async () => {
    const createOwnerLookup = vi.fn();
    const resolution = await resolveHubSpotOwnership(
      { organizationSlug: "acme", contactEmail: "buyer@example.com" },
      dependencies({
        environment: {},
        repository: {
          connectionStatuses: vi
            .fn()
            .mockResolvedValue([connection({ connected: false, scopes: [] })]),
        },
        createOwnerLookup,
      }),
    );

    expect(resolution).toEqual({ checked: false, ownerEmail: null });
    expect(createOwnerLookup).not.toHaveBeenCalled();
  });

  it("fails closed when a stored connection loses its runtime configuration", async () => {
    const createOwnerLookup = vi.fn();

    await expect(
      resolveHubSpotOwnership(
        { organizationSlug: "acme", contactEmail: "buyer@example.com" },
        dependencies({ environment: {}, createOwnerLookup }),
      ),
    ).rejects.toBeInstanceOf(HubSpotOwnershipConfigurationError);
    expect(createOwnerLookup).not.toHaveBeenCalled();
  });

  it.each([
    ["contact", ["oauth", HUBSPOT_OWNER_READ_SCOPE]],
    ["owner", ["oauth", HUBSPOT_CONTACT_READ_SCOPE]],
  ])(
    "requires reauthorization before lookup when %s read access is absent",
    async (_missingScope, scopes) => {
      const createOwnerLookup = vi.fn();

      await expect(
        resolveHubSpotOwnership(
          { organizationSlug: "acme", contactEmail: "buyer@example.com" },
          dependencies({
            repository: {
              connectionStatuses: vi
                .fn()
                .mockResolvedValue([connection({ scopes })]),
            },
            createOwnerLookup,
          }),
        ),
      ).rejects.toMatchObject({
        name: HubSpotReconnectRequiredError.name,
        message: expect.stringContaining(HUBSPOT_CONTACT_READ_SCOPE),
      });
      expect(createOwnerLookup).not.toHaveBeenCalled();
    },
  );

  it("returns checked ownership, including an authoritative no-owner result", async () => {
    const ownerEmailForContact = vi
      .fn()
      .mockResolvedValueOnce("owner@acme.example")
      .mockResolvedValueOnce(null);
    const deps = dependencies({
      createOwnerLookup: () => ({ ownerEmailForContact }),
    });

    await expect(
      resolveHubSpotOwnership(
        { organizationSlug: "acme", contactEmail: "BUYER@EXAMPLE.COM" },
        deps,
      ),
    ).resolves.toEqual({
      checked: true,
      ownerEmail: "owner@acme.example",
    });
    await expect(
      resolveHubSpotOwnership(
        { organizationSlug: "acme", contactEmail: "new@example.com" },
        deps,
      ),
    ).resolves.toEqual({ checked: true, ownerEmail: null });
    expect(ownerEmailForContact).toHaveBeenNthCalledWith(
      1,
      "BUYER@EXAMPLE.COM",
      expect.any(AbortSignal),
    );
  });

  it("bounds a stalled lookup and preserves caller cancellation", async () => {
    const stalledLookup = vi.fn(
      (_contactEmail: string, _signal?: AbortSignal): Promise<string | null> =>
        new Promise(() => {}),
    );
    const timeoutFailure = await resolveHubSpotOwnership(
      { organizationSlug: "acme", contactEmail: "buyer@example.com" },
      dependencies({
        lookupTimeoutMs: 1,
        createOwnerLookup: () => ({ ownerEmailForContact: stalledLookup }),
      }),
    ).catch((failure: unknown) => failure);

    expect(timeoutFailure).toBeInstanceOf(HubSpotOwnershipLookupError);
    expect(timeoutFailure).toMatchObject({
      message: "HubSpot contact ownership could not be verified.",
      cause: { name: "TimeoutError" },
    });
    expect(stalledLookup.mock.calls[0]?.[1]?.aborted).toBe(true);

    const controller = new AbortController();
    const callerAbort = new Error("caller stopped waiting");
    const callerFailure = resolveHubSpotOwnership(
      {
        organizationSlug: "acme",
        contactEmail: "buyer@example.com",
        signal: controller.signal,
      },
      dependencies({
        lookupTimeoutMs: HUBSPOT_OWNERSHIP_LOOKUP_TIMEOUT_MS,
        createOwnerLookup: () => ({ ownerEmailForContact: stalledLookup }),
      }),
    ).catch((failure: unknown) => failure);
    controller.abort(callerAbort);

    await expect(callerFailure).resolves.toMatchObject({
      name: "HubSpotOwnershipLookupError",
      cause: callerAbort,
    });
  });

  it.each([
    ["authentication", 401],
    ["rate limit", 429],
    ["service", 503],
  ])("fails closed on a HubSpot %s error", async (_kind, status) => {
    const providerError = new ProviderHttpError(
      "hubspot",
      "contact owner lookup",
      status,
      "access_token=must-not-leak",
    );
    const deps = dependencies({
      createOwnerLookup: () => ({
        ownerEmailForContact: vi.fn().mockRejectedValue(providerError),
      }),
    });

    const error = await resolveHubSpotOwnership(
      { organizationSlug: "acme", contactEmail: "buyer@example.com" },
      deps,
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(HubSpotOwnershipLookupError);
    expect(error).toMatchObject({
      name: "HubSpotOwnershipLookupError",
      message: "HubSpot contact ownership could not be verified.",
      cause: providerError,
    });
    expect(String(error)).not.toContain("access_token");
  });

  it("overrides or removes untrusted public owner fields", () => {
    expect(
      leadWithAuthoritativeHubSpotOwner(
        {
          email: "buyer@example.com",
          current_owner_email: "attacker@example.com",
        },
        { checked: true, ownerEmail: "owner@acme.example" },
      ),
    ).toEqual({
      email: "buyer@example.com",
      current_owner_email: "owner@acme.example",
    });
    expect(
      leadWithAuthoritativeHubSpotOwner(
        {
          email: "buyer@example.com",
          current_owner_email: "attacker@example.com",
        },
        { checked: true, ownerEmail: null },
      ),
    ).toEqual({ email: "buyer@example.com" });
    expect(
      leadWithAuthoritativeHubSpotOwner(
        {
          email: "buyer@example.com",
          current_owner_email: "attacker@example.com",
        },
        { checked: false, ownerEmail: null },
      ),
    ).toEqual({ email: "buyer@example.com" });
  });
});
