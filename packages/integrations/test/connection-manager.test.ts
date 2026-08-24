import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ConnectionTokenManager,
  TokenCipher,
  type OAuthConnectionStore,
  type OAuthProviderClient,
  type SaveStoredOAuthConnection,
  type StoredOAuthConnection,
} from "../src/index.js";

class MemoryStore implements OAuthConnectionStore {
  value: StoredOAuthConnection | null = null;

  async getOAuthConnection(): Promise<StoredOAuthConnection | null> {
    return this.value;
  }

  async saveOAuthConnection(value: SaveStoredOAuthConnection): Promise<void> {
    this.value = { ...value, updatedAt: new Date() };
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
});
