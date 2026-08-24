import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  TokenCipher,
  oauthStatesEqual,
  providerConfigured,
  setupSecretMatches,
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

describe("connector configuration", () => {
  const validKey = randomBytes(32).toString("base64");
  const baseEnvironment = {
    OAUTH_ENCRYPTION_KEY: validKey,
    CONNECTOR_SETUP_SECRET: "a-long-local-setup-secret",
    HUBSPOT_CLIENT_ID: "hubspot-client",
    HUBSPOT_CLIENT_SECRET: "hubspot-secret",
  };

  it("accepts a complete provider configuration and its setup secret", () => {
    expect(providerConfigured("hubspot", baseEnvironment)).toBe(true);
    expect(
      setupSecretMatches("a-long-local-setup-secret", baseEnvironment),
    ).toBe(true);
  });

  it("rejects malformed encryption keys and short setup secrets", () => {
    expect(
      providerConfigured("hubspot", {
        ...baseEnvironment,
        OAUTH_ENCRYPTION_KEY: "not-a-key",
      }),
    ).toBe(false);
    expect(
      providerConfigured("hubspot", {
        ...baseEnvironment,
        CONNECTOR_SETUP_SECRET: "short",
      }),
    ).toBe(false);
  });
});
