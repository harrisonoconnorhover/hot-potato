import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  catalog: vi.fn(),
  assets: vi.fn(),
  loadSchedule: vi.fn(),
  available: vi.fn(),
  consumeRateLimit: vi.fn(),
}));

vi.mock("../app/email-tools", () => ({
  emailToolAccess: mocks.access,
  emailToolCatalogForAccess: mocks.catalog,
  emailComposerAssets: mocks.assets,
}));

vi.mock("../app/public-scheduling", () => ({
  loadPublicSchedule: mocks.loadSchedule,
  availablePublicSlots: mocks.available,
}));

vi.mock("../app/repository", () => ({
  repository: { consumePublicRateLimit: mocks.consumeRateLimit },
}));

import { POST } from "../app/api/email-tools/render/route";

const asset = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "meeting_type" as const,
  slug: "intro",
  title: "Intro",
  description: "",
  bookingUrl: "https://hot.example/schedule/acme/intro",
  hostName: "Ada",
  durationMinutes: 30,
};

function slots(dayOffset = 0) {
  return Array.from({ length: 12 }, (_, index) => {
    const startsAt = new Date(
      Date.UTC(
        2026,
        8,
        1 + dayOffset + Math.floor(index / 3),
        13 + (index % 3),
      ),
    );
    return {
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
    };
  });
}

function request(body: unknown) {
  return new Request("https://hot.example/api/email-tools/render", {
    method: "POST",
    headers: {
      authorization: "Bearer hp_email_test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("Outlook email render API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue({
      keyId: "key-1",
      clientType: "outlook",
      organization: { slug: "acme" },
      rep: { id: "rep-1" },
    });
    mocks.catalog.mockResolvedValue({});
    mocks.assets.mockReturnValue([asset]);
    mocks.loadSchedule.mockResolvedValue({ id: "schedule-1" });
    mocks.available.mockResolvedValue(slots());
    mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
  });

  it("returns twelve locale-aware choices with three diverse-day defaults", async () => {
    const response = await POST(
      request({
        assetId: asset.id,
        mode: "choices",
        timezone: "America/New_York",
        locale: "en-US",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.choices).toHaveLength(12);
    expect(body.selectedStartsAt).toEqual([
      slots()[0]!.startsAt,
      slots()[3]!.startsAt,
      slots()[6]!.startsAt,
    ]);
    expect(body.choices[0].label).toContain("EDT");
  });

  it("rechecks selected times with a fresh availability read before rendering", async () => {
    const selectedStartsAt = [slots()[0]!.startsAt, slots()[3]!.startsAt];
    const response = await POST(
      request({
        assetId: asset.id,
        mode: "times",
        timezone: "America/New_York",
        locale: "en-US",
        selectedStartsAt,
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.slots.map((slot: { startsAt: string }) => slot.startsAt),
    ).toEqual(selectedStartsAt);
    expect(body.content.html).toContain("Would any of these times work?");
    expect(mocks.available).toHaveBeenCalledOnce();
  });

  it("returns fresh alternatives without rendered content when a choice went stale", async () => {
    mocks.available.mockResolvedValue(slots(5));
    const response = await POST(
      request({
        assetId: asset.id,
        mode: "times",
        timezone: "UTC",
        locale: "en-US",
        selectedStartsAt: [slots()[0]!.startsAt],
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("stale_times");
    expect(body.content).toBeUndefined();
    expect(body.choices).toHaveLength(12);
    expect(body.selectedStartsAt).toHaveLength(3);
  });

  it.each([
    ["zero", []],
    [
      "six",
      slots()
        .slice(0, 6)
        .map((slot) => slot.startsAt),
    ],
    ["duplicate", [slots()[0]!.startsAt, slots()[0]!.startsAt]],
    ["malformed", ["not-a-time"]],
  ])("fails closed on a %s selection", async (_label, selectedStartsAt) => {
    const response = await POST(
      request({
        assetId: asset.id,
        mode: "times",
        timezone: "UTC",
        locale: "en-US",
        selectedStartsAt,
      }),
    );
    expect(response.status).toBe(422);
    expect(mocks.available).not.toHaveBeenCalled();
  });

  it("does not expose a cross-representative asset", async () => {
    const response = await POST(
      request({
        assetId: "22222222-2222-4222-8222-222222222222",
        mode: "choices",
        timezone: "UTC",
        locale: "en-US",
      }),
    );
    expect(response.status).toBe(404);
    expect(mocks.loadSchedule).not.toHaveBeenCalled();
  });

  it("rejects draft, recipient, subject, and attachment fields", async () => {
    for (const field of ["draft", "recipient", "subject", "attachments"]) {
      const response = await POST(
        request({
          assetId: asset.id,
          mode: "choices",
          timezone: "UTC",
          locale: "en-US",
          [field]: "must-not-leave-the-client",
        }),
      );
      expect(response.status).toBe(422);
    }
    expect(mocks.loadSchedule).not.toHaveBeenCalled();
  });
});
