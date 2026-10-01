import { describe, expect, it } from "vitest";
import {
  googleWorkspaceComposeCard,
  googleWorkspaceDraftInsert,
  googleWorkspaceInsertedCard,
  googleWorkspaceScopeRequest,
  googleWorkspaceSetupCard,
  googleWorkspaceStringInput,
  googleWorkspaceStringInputs,
  googleWorkspaceTimePickerCard,
} from "../app/google-workspace-addon";

const endpoint =
  "https://hot-potato.example/api/integrations/google-workspace-addon";

describe("Google Workspace add-on cards", () => {
  it("renders link and live-time actions against one exact endpoint", () => {
    const response = googleWorkspaceComposeCard({
      endpoint,
      repName: "Ada <Admin>",
      organizationName: "Acme & Co",
      assets: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          kind: "meeting_type",
          slug: "intro",
          title: "Intro",
          description: "",
          bookingUrl: "https://hot-potato.example/schedule/acme/intro",
          hostName: "Ada",
          durationMinutes: 30,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          kind: "router_link",
          slug: "talk-to-sales",
          title: "Talk to sales",
          description: "",
          bookingUrl: "https://hot-potato.example/r/acme/talk-to-sales",
          hostName: null,
          durationMinutes: null,
        },
      ],
    });
    const json = JSON.stringify(response);
    expect(json).toContain("linkAssetId");
    expect(json).toContain("meetingAssetId");
    expect(json.match(new RegExp(endpoint, "g"))?.length).toBe(2);
    expect(json).toContain("Ada &lt;Admin&gt;");
    expect(json).not.toContain("Ada <Admin>");
  });

  it("preselects the rep's recent link and live-time meeting independently", () => {
    const response = googleWorkspaceComposeCard({
      endpoint,
      repName: "Ada",
      organizationName: "Acme",
      recentLinkAssetId: "22222222-2222-4222-8222-222222222222",
      recentMeetingTypeId: "11111111-1111-4111-8111-111111111111",
      assets: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          kind: "meeting_type",
          slug: "intro",
          title: "Intro",
          description: "",
          bookingUrl: "https://hot-potato.example/schedule/acme/intro",
          hostName: "Ada",
          durationMinutes: 30,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          kind: "router_link",
          slug: "talk-to-sales",
          title: "Talk to sales",
          description: "",
          bookingUrl: "https://hot-potato.example/r/acme/talk-to-sales",
          hostName: null,
          durationMinutes: null,
        },
      ],
    });
    const json = JSON.stringify(response);
    expect(json).toContain(
      '"value":"22222222-2222-4222-8222-222222222222","selected":true',
    );
    expect(json).toContain(
      '"value":"11111111-1111-4111-8111-111111111111","selected":true',
    );
  });

  it("uses the official host-app draft insertion wrapper", () => {
    expect(
      googleWorkspaceDraftInsert({
        html: '<p><a href="https://hot-potato.example">Book</a></p>',
        text: "Book: https://hot-potato.example",
      }),
    ).toMatchObject({
      renderActions: {
        hostAppAction: {
          gmailAction: {
            updateDraftActionMarkup: {
              updateBody: {
                insertContents: [
                  {
                    contentType: "MUTABLE_HTML",
                  },
                ],
                type: "IN_PLACE_INSERT",
              },
            },
          },
        },
      },
    });
  });

  it("renders twelve selectable live choices with refresh and selected insertion", () => {
    const asset = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "meeting_type" as const,
      slug: "intro",
      title: "Intro",
      description: "",
      bookingUrl: "https://hot-potato.example/schedule/acme/intro",
      hostName: "Ada",
      durationMinutes: 30,
    };
    const choices = Array.from({ length: 12 }, (_, index) => ({
      startsAt: new Date(Date.UTC(2026, 8, 1 + index, 14)).toISOString(),
      endsAt: new Date(Date.UTC(2026, 8, 1 + index, 14, 30)).toISOString(),
      label: `Choice ${index + 1}`,
      bookingUrl: `${asset.bookingUrl}?time=${index}`,
    }));
    const response = googleWorkspaceTimePickerCard({
      endpoint,
      asset,
      timeChoices: {
        choices,
        selectedStartsAt: choices.slice(0, 3).map((choice) => choice.startsAt),
        timezone: "America/New_York",
        locale: "en-US",
      },
      navigation: "updateCard",
    });
    const json = JSON.stringify(response);
    expect(json).toContain('"type":"CHECK_BOX"');
    expect(json).toContain('"name":"displayTimezone"');
    expect(json).toContain('"onChangeAction"');
    expect(json).toContain("Eastern — New York");
    expect(json).toContain('"updateCard"');
    expect(json.match(/"selected":true/g)).toHaveLength(4);
    expect(json).toContain("Refresh availability");
    expect(json).toContain("Insert selected times");
  });

  it("replaces the insert action with a confirmation card after one insert", () => {
    const response = googleWorkspaceInsertedCard({
      endpoint,
      content: { html: "<p>Book</p>", text: "Book" },
    });
    const json = JSON.stringify(response);
    expect(json).toContain("updateDraftActionMarkup");
    expect(json).toContain("Scheduling inserted");
    expect(json).not.toContain("Insert selected times");
  });

  it("returns Google's granular-consent response when required scopes are missing", () => {
    expect(googleWorkspaceScopeRequest()).toEqual({
      requesting_google_scopes: { all_scopes: true },
    });
  });

  it("escapes setup messages and reads only one string form value", () => {
    expect(
      JSON.stringify(googleWorkspaceSetupCard("<script>x</script>")),
    ).not.toContain("<script>");
    expect(
      googleWorkspaceStringInput(
        {
          hostApp: "GMAIL",
          platform: "WEB",
          userLocale: "en",
          timeZone: null,
          parameters: {},
          formInputs: {
            assetId: { kind: "strings", values: ["asset-1"] },
          },
        },
        "assetId",
      ),
    ).toBe("asset-1");
    expect(
      googleWorkspaceStringInputs(
        {
          hostApp: "GMAIL",
          platform: "WEB",
          userLocale: "en",
          timeZone: null,
          parameters: {},
          formInputs: {
            selectedStartsAt: {
              kind: "strings",
              values: ["2026-09-01T14:00:00.000Z", "2026-09-02T14:00:00.000Z"],
            },
          },
        },
        "selectedStartsAt",
      ),
    ).toEqual(["2026-09-01T14:00:00.000Z", "2026-09-02T14:00:00.000Z"]);
  });
});
