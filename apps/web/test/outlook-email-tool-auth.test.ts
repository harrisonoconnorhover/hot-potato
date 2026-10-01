import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  resolveKey: vi.fn(),
  resolveIdentity: vi.fn(),
}));

vi.mock("../app/outlook-naa", () => ({
  verifyOutlookNaaAccessToken: mocks.verify,
}));

vi.mock("../app/repository", () => ({
  repository: {
    resolveEmailToolAccessKey: mocks.resolveKey,
    resolveOutlookEmailIdentity: mocks.resolveIdentity,
  },
}));

import { emailToolAccess } from "../app/email-tools";

describe("Outlook email tool authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockResolvedValue(null);
    mocks.resolveKey.mockResolvedValue(null);
    mocks.resolveIdentity.mockResolvedValue(null);
  });

  it("preserves scoped pairing-key authorization", async () => {
    const access = { keyId: "key-1", clientType: "outlook" };
    mocks.resolveKey.mockResolvedValue(access);
    await expect(
      emailToolAccess(
        new Request("https://hot.example/api/email-tools/catalog", {
          headers: { authorization: `Bearer hp_email_${"a".repeat(32)}` },
        }),
      ),
    ).resolves.toBe(access);
    expect(mocks.resolveKey).toHaveBeenCalledOnce();
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("maps a verified Microsoft principal through its durable binding", async () => {
    const token = `${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(40)}`;
    mocks.verify.mockResolvedValue({
      email: "rep@example.com",
      subject: "subject-1",
      tenantId: "tenant-1",
      rateLimitIdentifier: "principal-hash",
    });
    const boundAccess = {
      keyId: "entra:binding-1",
      clientType: "outlook",
      label: "Microsoft Entra",
      organization: { id: "org-1", slug: "acme", name: "Acme" },
      rep: { id: "rep-1", name: "Ada", email: "rep@example.com" },
    };
    mocks.resolveIdentity.mockResolvedValue(boundAccess);

    const access = await emailToolAccess(
      new Request("https://hot.example/api/email-tools/catalog", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(access).toMatchObject({
      keyId: "entra:binding-1",
      clientType: "outlook",
      label: "Microsoft Entra",
      organization: { slug: "acme" },
      rep: { id: "rep-1" },
    });
    expect(mocks.resolveIdentity).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      subject: "subject-1",
    });
  });

  it("rejects malformed, unverified, and ambiguously mapped identities", async () => {
    const jwt = `${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(40)}`;
    await expect(
      emailToolAccess(
        new Request("https://hot.example/api/email-tools/catalog", {
          headers: { authorization: "Bearer malformed" },
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      emailToolAccess(
        new Request("https://hot.example/api/email-tools/catalog", {
          headers: { authorization: `Bearer ${jwt}` },
        }),
      ),
    ).resolves.toBeNull();
    mocks.verify.mockResolvedValue({
      email: "rep@example.com",
      subject: "subject-1",
      tenantId: "tenant-1",
      rateLimitIdentifier: "principal-hash",
    });
    await expect(
      emailToolAccess(
        new Request("https://hot.example/api/email-tools/catalog", {
          headers: { authorization: `Bearer ${jwt}` },
        }),
      ),
    ).resolves.toBeNull();
  });
});
