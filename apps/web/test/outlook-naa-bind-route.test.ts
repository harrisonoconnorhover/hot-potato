import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  bind: vi.fn(),
}));

vi.mock("../app/outlook-naa", () => ({
  verifyOutlookNaaAccessToken: mocks.verify,
}));

vi.mock("../app/repository", () => ({
  repository: { bindOutlookEmailIdentity: mocks.bind },
}));

import { POST } from "../app/api/email-tools/outlook-auth/bind/route";

const jwt = `${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(40)}`;
const pairingKey = `hp_email_${"d".repeat(40)}`;

function request(body: unknown, token = jwt) {
  return new Request(
    "https://schedule.example.com/api/email-tools/outlook-auth/bind",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

describe("Outlook identity binding route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verify.mockResolvedValue({
      email: "rep@example.com",
      tenantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      subject: "microsoft-subject",
      rateLimitIdentifier: "principal-hash",
    });
    mocks.bind.mockResolvedValue({
      organization: { name: "Acme" },
      rep: { name: "Ada" },
    });
  });

  it("binds one signed Microsoft principal through one active fallback key", async () => {
    const response = await POST(request({ pairingKey }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      linked: true,
      organizationName: "Acme",
      repName: "Ada",
    });
    expect(mocks.bind).toHaveBeenCalledWith({
      tenantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      subject: "microsoft-subject",
      assertedEmail: "rep@example.com",
      bootstrapTokenHash: createHash("sha256")
        .update(pairingKey, "utf8")
        .digest("hex"),
    });
  });

  it("rejects unsigned requests and conflicting bindings", async () => {
    mocks.verify.mockResolvedValueOnce(null);
    expect((await POST(request({ pairingKey }))).status).toBe(401);
    mocks.bind.mockResolvedValueOnce(null);
    expect((await POST(request({ pairingKey }))).status).toBe(409);
    expect((await POST(request({ pairingKey: "short" }))).status).toBe(422);
  });
});
