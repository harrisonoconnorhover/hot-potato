import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  consumeRateLimit: vi.fn(),
  rememberRecent: vi.fn(),
}));

vi.mock("../app/email-tools", () => ({
  emailToolAccess: mocks.access,
}));

vi.mock("../app/repository", () => ({
  repository: {
    consumePublicRateLimit: mocks.consumeRateLimit,
    rememberEmailToolRecentAsset: mocks.rememberRecent,
  },
}));

import { POST } from "../app/api/email-tools/preferences/route";

const assetId = "11111111-1111-4111-8111-111111111111";

function request(body: unknown) {
  return new Request("https://hot.example/api/email-tools/preferences", {
    method: "POST",
    headers: {
      authorization: "Bearer hp_email_test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("Outlook recent scheduling preference API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue({
      keyId: "key-1",
      clientType: "outlook",
      organization: { slug: "acme" },
      rep: { id: "rep-1" },
    });
    mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
    mocks.rememberRecent.mockResolvedValue(true);
  });

  it("stores only the authenticated rep's active purpose-specific asset", async () => {
    const response = await POST(request({ purpose: "times", assetId }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ remembered: true });
    expect(mocks.rememberRecent).toHaveBeenCalledWith({
      organizationSlug: "acme",
      repId: "rep-1",
      purpose: "times",
      assetId,
    });
  });

  it("rejects invalid payloads and inaccessible assets", async () => {
    const invalid = await POST(request({ purpose: "times", assetId: "bad" }));
    expect(invalid.status).toBe(422);
    expect(mocks.rememberRecent).not.toHaveBeenCalled();

    mocks.rememberRecent.mockResolvedValue(false);
    const inactive = await POST(request({ purpose: "link", assetId }));
    expect(inactive.status).toBe(404);
  });

  it("rejects non-Outlook access", async () => {
    mocks.access.mockResolvedValue({
      keyId: "key-1",
      clientType: "gmail",
      organization: { slug: "acme" },
      rep: { id: "rep-1" },
    });
    expect(await POST(request({ purpose: "link", assetId }))).toMatchObject({
      status: 403,
    });
    expect(mocks.rememberRecent).not.toHaveBeenCalled();
  });
});
