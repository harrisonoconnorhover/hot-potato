import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ConnectionTokenManager,
  RepCalendarTokenManager,
  TokenCipher,
  type OAuthConnectionStore,
  type OAuthProviderClient,
  type SaveStoredOAuthConnection,
  type SaveStoredRepCalendarConnection,
  type StoredOAuthConnection,
  type StoredRepCalendarConnection,
} from "../src/index.js";

class MemoryStore implements OAuthConnectionStore {
  value: StoredOAuthConnection | null = null;

  async getOAuthConnection(): Promise<StoredOAuthConnection | null> {
    return this.value;
  }

  async saveOAuthConnection(
    value: SaveStoredOAuthConnection,
    options?: {
      expectedExternalAccountId?: string | null;
      expectedEncryptedRefreshToken?: string;
    },
  ): Promise<void> {
    if (
      options &&
      Object.hasOwn(options, "expectedExternalAccountId") &&
      this.value?.externalAccountId !== options.expectedExternalAccountId
    ) {
      throw new Error("OAuth account changed during refresh.");
    }
    if (
      options?.expectedEncryptedRefreshToken &&
      this.value?.encryptedRefreshToken !==
        options.expectedEncryptedRefreshToken
    ) {
      throw new Error("OAuth connection changed during refresh.");
    }
    this.value = { ...value, updatedAt: new Date() };
  }
}

class MemoryRepStore {
  values = new Map<"google" | "microsoft", StoredRepCalendarConnection>();
  activeProvider: "google" | "microsoft" | null = null;
  lastPreserveCalendarSources: boolean | undefined;

  get value(): StoredRepCalendarConnection | null {
    return [...this.values.values()].at(-1) ?? null;
  }

  set value(value: StoredRepCalendarConnection | null) {
    this.values.clear();
    if (value) this.values.set(value.provider, value);
  }

  async getRepCalendarConnection(
    _organizationSlug: string,
    _repId: string,
    provider: "google" | "microsoft",
  ): Promise<StoredRepCalendarConnection | null> {
    return this.values.get(provider) ?? null;
  }

  async getActiveRepCalendarProvider(): Promise<"google" | "microsoft" | null> {
    return this.activeProvider;
  }

  async saveRepCalendarConnection(
    value: SaveStoredRepCalendarConnection,
    options?: {
      preserveCalendarSources?: boolean;
      expectedExternalAccountId?: string | null;
      expectedEncryptedRefreshToken?: string;
    },
  ): Promise<void> {
    const current = this.values.get(value.provider);
    if (
      options &&
      Object.hasOwn(options, "expectedExternalAccountId") &&
      current?.externalAccountId !== options.expectedExternalAccountId
    ) {
      throw new Error("Calendar account changed during refresh.");
    }
    if (
      options?.expectedEncryptedRefreshToken &&
      current?.encryptedRefreshToken !== options.expectedEncryptedRefreshToken
    ) {
      throw new Error("Calendar connection changed during refresh.");
    }
    this.values.set(value.provider, { ...value, updatedAt: new Date() });
    this.lastPreserveCalendarSources = options?.preserveCalendarSources;
  }

  async setActiveRepCalendarProvider(
    _organizationSlug: string,
    _repId: string,
    provider: "google" | "microsoft",
  ): Promise<void> {
    this.activeProvider = provider;
  }
}

describe("ConnectionTokenManager", () => {
  it("encrypts connections and refreshes an expired access token", async () => {
    const store = new MemoryStore();
    const cipher = TokenCipher.fromBase64(randomBytes(32).toString("base64"));
    const client: OAuthProviderClient = {
      provider: "hubspot",
      authorizationUrl: () => "https://example.com",
      exchangeCode: async () => ({
        accessToken: "expired-access",
        refreshToken: "saved-refresh",
        expiresAt: new Date(Date.now() - 1_000),
        scopes: ["oauth"],
      }),
      refresh: async (refreshToken) => {
        expect(refreshToken).toBe("saved-refresh");
        return {
          accessToken: "fresh-access",
          expiresAt: new Date(Date.now() + 3_600_000),
          scopes: ["oauth"],
        };
      },
    };
    const manager = new ConnectionTokenManager(
      store,
      cipher,
      new Map([["hubspot", client]]),
    );

    await manager.connect("acme", "hubspot", {
      code: "code",
      redirectUri: "http://localhost/callback",
    });
    expect(store.value?.encryptedAccessToken).not.toContain("expired-access");
    expect(await manager.accessToken("acme", "hubspot")).toBe("fresh-access");
    expect(cipher.decrypt(store.value!.encryptedRefreshToken)).toBe(
      "saved-refresh",
    );
  });

  it("rejects an expired portal refresh that races a reconnect", async () => {
    const store = new MemoryStore();
    const cipher = TokenCipher.fromBase64(randomBytes(32).toString("base64"));
    store.value = {
      organizationSlug: "acme",
      provider: "hubspot",
      encryptedAccessToken: cipher.encrypt("expired-a-access"),
      encryptedRefreshToken: cipher.encrypt("portal-a-refresh"),
      expiresAt: new Date(Date.now() - 1_000),
      scopes: ["oauth"],
      externalAccountId: "portal-a",
      externalAccountName: "Portal A",
      metadata: {},
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    let markPortalAStarted!: () => void;
    const portalAStarted = new Promise<void>((resolve) => {
      markPortalAStarted = resolve;
    });
    let releasePortalA!: () => void;
    const portalARefreshMayFinish = new Promise<void>((resolve) => {
      releasePortalA = resolve;
    });
    const client: OAuthProviderClient = {
      provider: "hubspot",
      authorizationUrl: () => "https://example.com",
      exchangeCode: async () => ({
        accessToken: "portal-b-access",
        refreshToken: "portal-b-refresh",
        expiresAt: new Date(Date.now() + 3_600_000),
        scopes: ["oauth"],
        externalAccountId: "portal-b",
        externalAccountName: "Portal B",
      }),
      refresh: async (refreshToken) => {
        expect(refreshToken).toBe("portal-a-refresh");
        markPortalAStarted();
        await portalARefreshMayFinish;
        return {
          accessToken: "fresh-a-access",
          expiresAt: new Date(Date.now() + 3_600_000),
          scopes: ["oauth"],
          externalAccountId: "portal-a",
        };
      },
    };
    const manager = new ConnectionTokenManager(
      store,
      cipher,
      new Map([["hubspot", client]]),
    );

    const stalePortalARefresh = manager.accessToken("acme", "hubspot");
    await portalAStarted;
    await manager.connect("acme", "hubspot", {
      code: "portal-b-code",
      redirectUri: "http://localhost/callback",
    });
    releasePortalA();

    await expect(stalePortalARefresh).rejects.toThrow(
      "OAuth account changed during refresh.",
    );
    expect(store.value?.externalAccountId).toBe("portal-b");
    expect(cipher.decrypt(store.value!.encryptedAccessToken)).toBe(
      "portal-b-access",
    );
  });
});

describe("RepCalendarTokenManager", () => {
  it("refuses a token from a different calendar account than the booking", async () => {
    const store = new MemoryRepStore();
    const cipher = TokenCipher.fromBase64(randomBytes(32).toString("base64"));
    store.value = {
      organizationSlug: "acme",
      repId: "rep-1",
      provider: "google",
      encryptedAccessToken: cipher.encrypt("wrong-account-access"),
      encryptedRefreshToken: cipher.encrypt("wrong-account-refresh"),
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["calendar.events"],
      externalAccountId: "new-calendar-account",
      externalAccountName: "new@example.com",
      metadata: {},
      updatedAt: new Date(),
    };
    const manager = new RepCalendarTokenManager(store, cipher, new Map());

    await expect(
      manager.accessToken(
        "acme",
        "rep-1",
        "google",
        "booking-calendar-account",
      ),
    ).rejects.toMatchObject({
      name: "OAuthConnectionAccountMismatchError",
    });
  });

  it("activates the first connected calendar provider", async () => {
    const store = new MemoryRepStore();
    const cipher = TokenCipher.fromBase64(randomBytes(32).toString("base64"));
    const client: OAuthProviderClient = {
      provider: "microsoft",
      authorizationUrl: () => "https://example.com",
      exchangeCode: async () => ({
        accessToken: "rep-access",
        refreshToken: "rep-refresh",
        expiresAt: new Date(Date.now() + 3_600_000),
        scopes: ["Calendars.ReadWrite"],
      }),
      refresh: async () => {
        throw new Error("Unexpected refresh");
      },
    };
    const manager = new RepCalendarTokenManager(
      store,
      cipher,
      new Map([["microsoft", client]]),
    );

    await manager.connect("acme", "rep-1", "microsoft", {
      code: "code",
      redirectUri: "http://localhost/rep-callback",
    });
    expect(store.value).toMatchObject({
      organizationSlug: "acme",
      repId: "rep-1",
      provider: "microsoft",
    });
    expect(store.value?.encryptedAccessToken).not.toContain("rep-access");
    expect(await manager.accessToken("acme", "rep-1", "microsoft")).toBe(
      "rep-access",
    );
    expect(store.activeProvider).toBe("microsoft");
  });

  it("keeps the existing booking provider when a second provider connects", async () => {
    const store = new MemoryRepStore();
    const cipher = TokenCipher.fromBase64(randomBytes(32).toString("base64"));
    store.values.set("google", {
      organizationSlug: "acme",
      repId: "rep-1",
      provider: "google",
      encryptedAccessToken: cipher.encrypt("google-access"),
      encryptedRefreshToken: cipher.encrypt("google-refresh"),
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["https://www.googleapis.com/auth/calendar.events"],
      externalAccountId: "google-account",
      externalAccountName: "rep@example.com",
      metadata: {},
      updatedAt: new Date(),
    });
    store.activeProvider = "google";
    const client: OAuthProviderClient = {
      provider: "microsoft",
      authorizationUrl: () => "https://example.com",
      exchangeCode: async () => ({
        accessToken: "microsoft-access",
        refreshToken: "microsoft-refresh",
        expiresAt: new Date(Date.now() + 3_600_000),
        scopes: ["Calendars.ReadWrite"],
      }),
      refresh: async () => {
        throw new Error("Unexpected refresh");
      },
    };
    const manager = new RepCalendarTokenManager(
      store,
      cipher,
      new Map([["microsoft", client]]),
    );

    await manager.connect("acme", "rep-1", "microsoft", {
      code: "second-provider-code",
      redirectUri: "http://localhost/rep-callback",
    });

    expect(store.activeProvider).toBe("google");
    expect(store.values.has("google")).toBe(true);
    expect(store.values.get("microsoft")).toMatchObject({
      organizationSlug: "acme",
      repId: "rep-1",
      provider: "microsoft",
    });
  });

  it("refreshes a reconnected calendar without changing the active provider", async () => {
    const store = new MemoryRepStore();
    const cipher = TokenCipher.fromBase64(randomBytes(32).toString("base64"));
    store.value = {
      organizationSlug: "acme",
      repId: "rep-1",
      provider: "microsoft",
      encryptedAccessToken: cipher.encrypt("old-access"),
      encryptedRefreshToken: cipher.encrypt("old-refresh"),
      expiresAt: new Date(Date.now() + 3_600_000),
      scopes: ["Calendars.ReadWrite"],
      externalAccountId: "old-account",
      externalAccountName: "old@example.com",
      metadata: {},
      updatedAt: new Date(),
    };
    store.activeProvider = "google";
    const client: OAuthProviderClient = {
      provider: "microsoft",
      authorizationUrl: () => "https://example.com",
      exchangeCode: async () => ({
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: new Date(Date.now() + 3_600_000),
        scopes: ["Calendars.ReadWrite"],
      }),
      refresh: async () => {
        throw new Error("Unexpected refresh");
      },
    };
    const manager = new RepCalendarTokenManager(
      store,
      cipher,
      new Map([["microsoft", client]]),
    );

    await manager.connect("acme", "rep-1", "microsoft", {
      code: "reconnect-code",
      redirectUri: "http://localhost/rep-callback",
    });

    expect(store.activeProvider).toBe("google");
    expect(cipher.decrypt(store.value!.encryptedAccessToken)).toBe(
      "new-access",
    );
    expect(store.lastPreserveCalendarSources).toBe(false);
  });

  it("preserves calendar selections during an access-token refresh", async () => {
    const store = new MemoryRepStore();
    const cipher = TokenCipher.fromBase64(randomBytes(32).toString("base64"));
    store.value = {
      organizationSlug: "acme",
      repId: "rep-1",
      provider: "microsoft",
      encryptedAccessToken: cipher.encrypt("expired-access"),
      encryptedRefreshToken: cipher.encrypt("saved-refresh"),
      expiresAt: new Date(Date.now() - 1_000),
      scopes: ["Calendars.ReadWrite"],
      externalAccountId: null,
      externalAccountName: null,
      metadata: {},
      updatedAt: new Date(),
    };
    const client: OAuthProviderClient = {
      provider: "microsoft",
      authorizationUrl: () => "https://example.com",
      exchangeCode: async () => {
        throw new Error("Unexpected connection");
      },
      refresh: async (refreshToken) => {
        expect(refreshToken).toBe("saved-refresh");
        return {
          accessToken: "fresh-access",
          expiresAt: new Date(Date.now() + 3_600_000),
          scopes: ["Calendars.ReadWrite"],
        };
      },
    };
    const manager = new RepCalendarTokenManager(
      store,
      cipher,
      new Map([["microsoft", client]]),
    );

    expect(await manager.accessToken("acme", "rep-1", "microsoft")).toBe(
      "fresh-access",
    );
    expect(store.lastPreserveCalendarSources).toBe(true);
  });

  it("isolates in-flight refreshes by exact account and rejects a stale save", async () => {
    const store = new MemoryRepStore();
    const cipher = TokenCipher.fromBase64(randomBytes(32).toString("base64"));
    store.value = {
      organizationSlug: "acme",
      repId: "rep-1",
      provider: "google",
      encryptedAccessToken: cipher.encrypt("expired-a-access"),
      encryptedRefreshToken: cipher.encrypt("account-a-refresh"),
      expiresAt: new Date(Date.now() - 1_000),
      scopes: ["calendar.events"],
      externalAccountId: "account-a",
      externalAccountName: "a@example.com",
      metadata: {},
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    let markAccountAStarted!: () => void;
    const accountAStarted = new Promise<void>((resolve) => {
      markAccountAStarted = resolve;
    });
    let releaseAccountA!: () => void;
    const accountARefreshMayFinish = new Promise<void>((resolve) => {
      releaseAccountA = resolve;
    });
    const client: OAuthProviderClient = {
      provider: "google",
      authorizationUrl: () => "https://example.com",
      exchangeCode: async () => {
        throw new Error("Unexpected connection");
      },
      refresh: async (refreshToken) => {
        if (refreshToken === "account-a-refresh") {
          markAccountAStarted();
          await accountARefreshMayFinish;
          return {
            accessToken: "fresh-a-access",
            expiresAt: new Date(Date.now() + 3_600_000),
            scopes: ["calendar.events"],
            externalAccountId: "account-a",
          };
        }
        expect(refreshToken).toBe("account-b-refresh");
        return {
          accessToken: "fresh-b-access",
          expiresAt: new Date(Date.now() + 3_600_000),
          scopes: ["calendar.events"],
          externalAccountId: "account-b",
        };
      },
    };
    const manager = new RepCalendarTokenManager(
      store,
      cipher,
      new Map([["google", client]]),
    );

    const staleAccountARefresh = manager.accessToken(
      "acme",
      "rep-1",
      "google",
      "account-a",
    );
    await accountAStarted;
    store.value = {
      organizationSlug: "acme",
      repId: "rep-1",
      provider: "google",
      encryptedAccessToken: cipher.encrypt("expired-b-access"),
      encryptedRefreshToken: cipher.encrypt("account-b-refresh"),
      expiresAt: new Date(Date.now() - 1_000),
      scopes: ["calendar.events"],
      externalAccountId: "account-b",
      externalAccountName: "b@example.com",
      metadata: {},
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    };

    await expect(
      manager.accessToken("acme", "rep-1", "google", "account-b"),
    ).resolves.toBe("fresh-b-access");
    releaseAccountA();
    await expect(staleAccountARefresh).rejects.toThrow(
      "Calendar account changed during refresh.",
    );
    expect(store.value?.externalAccountId).toBe("account-b");
    expect(cipher.decrypt(store.value!.encryptedAccessToken)).toBe(
      "fresh-b-access",
    );
  });
});
