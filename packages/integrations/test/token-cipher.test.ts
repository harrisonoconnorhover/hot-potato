import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  TokenCipher,
  createOAuthPkce,
  oauthStatesEqual,
  providerConfigured,
} from "../src/index.js";

describe("TokenCipher", () => {
  it("round-trips tokens without storing plaintext", () => {
    const cipher = TokenCipher.fromBase64(randomBytes(32).toString("base64"));
    const encrypted = cipher.encrypt("refresh-token-value");

    expect(encrypted).not.toContain("refresh-token-value");
    expect(cipher.decrypt(encrypted)).toBe("refresh-token-value");
  });

  it("rejects a key with the wrong length", () => {
    expect(() =>
      TokenCipher.fromBase64(Buffer.from("short").toString("base64")),
    ).toThrow("base64-encoded 32-byte key");
  });
});

describe("OAuth state comparison", () => {
  it("uses exact comparison", () => {
    expect(oauthStatesEqual("state-a", "state-a")).toBe(true);
    expect(oauthStatesEqual("state-a", "state-b")).toBe(false);
  });
});

describe("OAuth PKCE", () => {
  it("creates an S256 verifier and challenge pair", () => {
    const pkce = createOAuthPkce();
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pkce.challenge).toBe(
      createHash("sha256").update(pkce.verifier).digest("base64url"),
    );
  });
});

describe("connector configuration", () => {
  const validKey = randomBytes(32).toString("base64");
  const baseEnvironment = {
    OAUTH_ENCRYPTION_KEY: validKey,
    HUBSPOT_CLIENT_ID: "hubspot-client",
    HUBSPOT_CLIENT_SECRET: "hubspot-secret",
    MICROSOFT_CLIENT_ID: "microsoft-client",
    MICROSOFT_CLIENT_SECRET: "microsoft-secret",
  };

  it("accepts a complete provider configuration", () => {
    expect(providerConfigured("hubspot", baseEnvironment)).toBe(true);
    expect(providerConfigured("microsoft", baseEnvironment)).toBe(true);
  });

  it("rejects malformed encryption keys", () => {
    expect(
      providerConfigured("hubspot", {
        ...baseEnvironment,
        OAUTH_ENCRYPTION_KEY: "not-a-key",
      }),
    ).toBe(false);
  });
});
