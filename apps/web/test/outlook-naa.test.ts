import { describe, expect, it, vi } from "vitest";
import {
  configuredOutlookNaa,
  outlookNaaIdentityFromClaims,
  verifyOutlookNaaAccessToken,
} from "../app/outlook-naa";

const clientId = "11111111-2222-4333-8444-555555555555";
const tenantId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const subject = "stable-microsoft-subject";
const environment = {
  APP_URL: "https://schedule.example.com",
  OUTLOOK_NAA_CLIENT_ID: clientId,
  NODE_ENV: "production",
} as NodeJS.ProcessEnv;

function validClaims() {
  const config = configuredOutlookNaa(environment)!;
  return {
    aud: config.audience,
    iss: `https://login.microsoftonline.com/${tenantId}/v2.0`,
    sub: subject,
    tid: tenantId,
    ver: "2.0",
    azp: clientId,
    scp: "openid access_as_user profile",
    preferred_username: "Rep@Example.com",
  };
}

describe("Outlook nested app authentication", () => {
  it("derives one least-privilege scope and exact redirect set", () => {
    expect(configuredOutlookNaa({} as NodeJS.ProcessEnv)).toBeNull();
    expect(configuredOutlookNaa(environment)).toEqual({
      clientId,
      authority: "https://login.microsoftonline.com/common",
      audience: clientId,
      scope: `api://schedule.example.com/${clientId}/access_as_user`,
      redirectUri: "https://schedule.example.com/email/outlook/auth",
      dialogUrl: "https://schedule.example.com/email/outlook/auth-dialog",
      brokerRedirectUri: "brk-multihub://schedule.example.com",
    });
    expect(() =>
      configuredOutlookNaa({
        ...environment,
        OUTLOOK_NAA_CLIENT_ID: "not-a-guid",
      }),
    ).toThrow("Microsoft application GUID");
  });

  it("accepts only an exact v2 audience, issuer, client, and scope", () => {
    const config = configuredOutlookNaa(environment)!;
    expect(outlookNaaIdentityFromClaims(validClaims(), config)).toMatchObject({
      email: "rep@example.com",
      subject,
      tenantId,
    });

    for (const mutation of [
      { aud: "api://different/resource" },
      { iss: "https://login.microsoftonline.com/common/v2.0" },
      { azp: "99999999-2222-4333-8444-555555555555" },
      { scp: "openid profile" },
      { ver: "1.0" },
    ]) {
      expect(
        outlookNaaIdentityFromClaims({ ...validClaims(), ...mutation }, config),
      ).toBeNull();
    }
    expect(
      outlookNaaIdentityFromClaims(
        { ...validClaims(), preferred_username: "not-an-email" },
        config,
      ),
    ).toMatchObject({ email: null, subject, tenantId });
  });

  it("fails closed around signature verification without exposing the token", async () => {
    const token = "x".repeat(100);
    const verifier = vi.fn(async (_token: string, audience: string) => {
      expect(audience).toBe(clientId);
      return validClaims();
    });
    await expect(
      verifyOutlookNaaAccessToken(token, environment, verifier),
    ).resolves.toMatchObject({ email: "rep@example.com" });
    expect(verifier).toHaveBeenCalledWith(token, clientId);

    await expect(
      verifyOutlookNaaAccessToken(token, environment, async () =>
        Promise.reject(new Error(`invalid ${token}`)),
      ),
    ).resolves.toBeNull();
    await expect(
      verifyOutlookNaaAccessToken("short", environment, verifier),
    ).resolves.toBeNull();
  });
});
