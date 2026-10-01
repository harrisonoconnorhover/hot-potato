import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  catalog: vi.fn(),
  assets: vi.fn(),
  identity: vi.fn(),
  consumeRateLimit: vi.fn(),
  loadSchedule: vi.fn(),
  available: vi.fn(),
  rememberRecent: vi.fn(),
}));

vi.mock("@hot-potato/integrations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@hot-potato/integrations")>();
  return {
    ...actual,
    createGoogleWorkspaceAddonVerifier: () => ({ verify: mocks.verify }),
  };
});

vi.mock("../app/email-tools", () => ({
  configuredAppOrigin: () => new URL("https://hot.example"),
  emailComposerAssets: mocks.assets,
  emailToolCatalogForVerifiedIdentity: mocks.catalog,
}));

vi.mock("../app/public-scheduling", () => ({
  loadPublicSchedule: mocks.loadSchedule,
  availablePublicSlots: mocks.available,
}));

vi.mock("../app/repository", () => ({
  repository: {
    repIdentityForVerifiedEmail: mocks.identity,
    consumePublicRateLimit: mocks.consumeRateLimit,
    rememberEmailToolRecentAsset: mocks.rememberRecent,
  },
}));

import { POST } from "../app/api/integrations/google-workspace-addon/route";

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

function verifiedEvent(input: {
  action: string;
  parameters?: Record<string, string>;
  formInputs?: Record<string, { kind: "strings"; values: readonly string[] }>;
}) {
  return {
    kind: "verified" as const,
    identity: { subject: "google-user-1", email: "ada@example.com" },
    event: {
      hostApp: "GMAIL" as const,
      platform: "WEB" as const,
      userLocale: "en-US",
      timeZone: { id: "America/New_York", offsetMilliseconds: -14_400_000 },
      parameters: { action: input.action, ...input.parameters },
      formInputs: input.formInputs ?? {},
    },
  };
}

function request() {
  return new Request(
    "https://hot.example/api/integrations/google-workspace-addon",
    {
      method: "POST",
      headers: {
        authorization: "Bearer google-system-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ commonEventObject: { hostApp: "GMAIL" } }),
    },
  );
}

describe("Gmail live-time picker route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GOOGLE_WORKSPACE_ADDON_OAUTH_CLIENT_ID", "oauth-client");
    vi.stubEnv(
      "GOOGLE_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL",
      "addon@example.iam.gserviceaccount.com",
    );
    mocks.identity.mockResolvedValue({
      organization: { slug: "acme" },
      rep: { id: "rep-1" },
    });
    mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
    mocks.catalog.mockResolvedValue({
      organizationName: "Acme",
      repName: "Ada",
    });
    mocks.assets.mockReturnValue([asset]);
    mocks.loadSchedule.mockResolvedValue({ id: "schedule-1" });
    mocks.available.mockResolvedValue(slots());
    mocks.rememberRecent.mockResolvedValue(true);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("remembers a successful booking-link insertion without blocking the draft action", async () => {
    mocks.verify.mockResolvedValue(
      verifiedEvent({
        action: "insert_link",
        formInputs: {
          linkAssetId: { kind: "strings", values: [asset.id] },
        },
      }),
    );
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.renderActions.hostAppAction).toBeDefined();
    expect(mocks.rememberRecent).toHaveBeenCalledWith({
      organizationSlug: "acme",
      repId: "rep-1",
      purpose: "link",
      assetId: asset.id,
    });
  });

  it("returns a twelve-choice checkbox card and inserts only a revalidated selection", async () => {
    mocks.verify.mockResolvedValueOnce(
      verifiedEvent({
        action: "choose_times",
        formInputs: {
          meetingAssetId: { kind: "strings", values: [asset.id] },
        },
      }),
    );
    const picker = await (await POST(request())).json();
    expect(JSON.stringify(picker)).toContain('"type":"CHECK_BOX"');
    expect(JSON.stringify(picker)).toContain('"name":"displayTimezone"');
    expect(JSON.stringify(picker).match(/"selected":true/g)).toHaveLength(4);

    mocks.verify.mockResolvedValueOnce(
      verifiedEvent({
        action: "insert_times",
        parameters: { meetingAssetId: asset.id },
        formInputs: {
          selectedStartsAt: {
            kind: "strings",
            values: [slots()[0]!.startsAt, slots()[3]!.startsAt],
          },
          displayTimezone: {
            kind: "strings",
            values: ["America/New_York"],
          },
        },
      }),
    );
    const inserted = await (await POST(request())).json();
    expect(inserted.renderActions.hostAppAction).toBeDefined();
    expect(JSON.stringify(inserted)).toContain("Scheduling inserted");
    expect(mocks.rememberRecent).toHaveBeenCalledWith({
      organizationSlug: "acme",
      repId: "rep-1",
      purpose: "times",
      assetId: asset.id,
    });
  });

  it("refreshes and inserts times in the sender-selected display timezone", async () => {
    mocks.verify.mockResolvedValueOnce(
      verifiedEvent({
        action: "refresh_times",
        parameters: { meetingAssetId: asset.id },
        formInputs: {
          displayTimezone: { kind: "strings", values: ["Asia/Tokyo"] },
        },
      }),
    );

    const refreshed = await (await POST(request())).json();
    const json = JSON.stringify(refreshed);
    expect(json).toContain("Asia/Tokyo");
    expect(json).toContain("Tokyo");
    expect(json).toContain("GMT+9");

    mocks.verify.mockResolvedValueOnce(
      verifiedEvent({
        action: "insert_times",
        parameters: { meetingAssetId: asset.id },
        formInputs: {
          displayTimezone: { kind: "strings", values: ["Asia/Tokyo"] },
          selectedStartsAt: {
            kind: "strings",
            values: [slots()[0]!.startsAt],
          },
        },
      }),
    );
    const inserted = await (await POST(request())).json();
    expect(JSON.stringify(inserted)).toContain("Asia/Tokyo");
    expect(JSON.stringify(inserted)).toContain("GMT+9");
  });

  it("rejects a forged display timezone without loading availability", async () => {
    mocks.verify.mockResolvedValue(
      verifiedEvent({
        action: "refresh_times",
        parameters: { meetingAssetId: asset.id },
        formInputs: {
          displayTimezone: {
            kind: "strings",
            values: ["Mars/Olympus_Mons"],
          },
        },
      }),
    );

    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).toContain("Choose a valid display timezone");
    expect(mocks.loadSchedule).not.toHaveBeenCalled();
    expect(mocks.available).not.toHaveBeenCalled();
  });

  it("refreshes the card without inserting when any chosen time is stale", async () => {
    mocks.available.mockResolvedValue(slots(5));
    mocks.verify.mockResolvedValue(
      verifiedEvent({
        action: "insert_times",
        parameters: { meetingAssetId: asset.id },
        formInputs: {
          selectedStartsAt: {
            kind: "strings",
            values: [slots()[0]!.startsAt],
          },
        },
      }),
    );
    const response = await POST(request());
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.renderActions.hostAppAction).toBeUndefined();
    expect(body.renderActions.action.navigations[0].updateCard).toBeDefined();
    expect(JSON.stringify(body)).toContain("Availability changed");
  });

  it("does not insert zero, six, duplicate, or malformed selections", async () => {
    const cases = [
      [],
      slots()
        .slice(0, 6)
        .map((slot) => slot.startsAt),
      [slots()[0]!.startsAt, slots()[0]!.startsAt],
      ["not-a-time"],
    ];
    for (const values of cases) {
      mocks.verify.mockResolvedValueOnce(
        verifiedEvent({
          action: "insert_times",
          parameters: { meetingAssetId: asset.id },
          formInputs: {
            selectedStartsAt: { kind: "strings", values },
          },
        }),
      );
      const body = await (await POST(request())).json();
      expect(body.renderActions.hostAppAction).toBeUndefined();
      expect(JSON.stringify(body)).toContain(
        "Choose one to five distinct available times",
      );
    }
  });
});
