import type {
  EmailComposerAsset,
  EmailComposerContent,
  EmailComposerTimeChoices,
} from "@hot-potato/email-composer";
import {
  emailTimezoneLabel,
  emailTimezoneOptions,
} from "@hot-potato/email-composer";
import type { GoogleWorkspaceAddonEvent } from "@hot-potato/integrations";

type JsonRecord = Record<string, unknown>;

function cardText(value: string, maximumLength = 180): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maximumLength)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function actionSpec(
  endpoint: string,
  actionName: string,
  parameters: Record<string, string> = {},
): JsonRecord {
  return {
    function: endpoint,
    parameters: [
      { key: "action", value: actionName },
      ...Object.entries(parameters).map(([key, value]) => ({ key, value })),
    ],
  };
}

function action(
  endpoint: string,
  actionName: string,
  parameters: Record<string, string> = {},
): JsonRecord {
  return { action: actionSpec(endpoint, actionName, parameters) };
}

function addonCard(input: {
  endpoint: string;
  title: string;
  subtitle?: string;
  widgets: JsonRecord[];
}): JsonRecord {
  return {
    header: {
      title: cardText(input.title, 80),
      subtitle: cardText(input.subtitle ?? "Hot Potato", 80),
      imageUrl: new URL("/hot-potato-mascot.png", input.endpoint).toString(),
      imageType: "CIRCLE",
    },
    sections: [{ widgets: input.widgets }],
  };
}

function selectionInput(input: {
  name: string;
  label: string;
  assets: EmailComposerAsset[];
  selectedAssetId?: string | null;
}): JsonRecord {
  const visibleAssets = input.assets.slice(0, 100);
  const selectedAssetId = visibleAssets.some(
    (asset) => asset.id === input.selectedAssetId,
  )
    ? input.selectedAssetId
    : visibleAssets[0]?.id;
  return {
    selectionInput: {
      name: input.name,
      label: input.label,
      type: "DROPDOWN",
      items: visibleAssets.map((asset) => ({
        text: cardText(
          `${asset.kind === "router_link" ? "Smart Router · " : "Meeting · "}${asset.title}`,
        ),
        value: asset.id,
        selected: asset.id === selectedAssetId,
      })),
    },
  };
}

export function googleWorkspaceComposeCard(input: {
  endpoint: string;
  repName: string;
  organizationName: string;
  assets: EmailComposerAsset[];
  recentLinkAssetId?: string | null;
  recentMeetingTypeId?: string | null;
}): JsonRecord {
  const meetingAssets = input.assets.filter(
    (asset) => asset.kind === "meeting_type",
  );
  const widgets: JsonRecord[] = [
    {
      textParagraph: {
        text: `Signed in as <b>${cardText(input.repName)}</b> at ${cardText(input.organizationName)}. Hot Potato never reads this draft or its recipients.`,
      },
    },
  ];
  if (input.assets.length === 0) {
    widgets.push({
      textParagraph: {
        text: "No active scheduling links are ready. Ask an admin to activate a meeting type or Smart Router Link.",
      },
    });
  } else {
    widgets.push(
      selectionInput({
        name: "linkAssetId",
        label: "Booking or Smart Router Link",
        assets: input.assets,
        selectedAssetId: input.recentLinkAssetId,
      }),
      {
        buttonList: {
          buttons: [
            {
              text: "Insert booking link",
              onClick: action(input.endpoint, "insert_link"),
            },
          ],
        },
      },
    );
  }
  if (meetingAssets.length > 0) {
    widgets.push(
      {
        divider: {},
      },
      selectionInput({
        name: "meetingAssetId",
        label: "Meeting for live suggestions",
        assets: meetingAssets,
        selectedAssetId: input.recentMeetingTypeId,
      }),
      {
        textParagraph: {
          text: "Times start in your Gmail timezone. You can choose the recipient-facing timezone next; availability is checked across each enabled Google or Outlook calendar connection.",
        },
      },
      {
        buttonList: {
          buttons: [
            {
              text: "Choose live times",
              onClick: action(input.endpoint, "choose_times"),
            },
          ],
        },
      },
    );
  }

  return {
    renderActions: {
      action: {
        navigations: [
          {
            pushCard: addonCard({
              endpoint: input.endpoint,
              title: "Insert scheduling",
              widgets,
            }),
          },
        ],
      },
    },
  };
}

export function googleWorkspaceTimePickerCard(input: {
  endpoint: string;
  asset: EmailComposerAsset;
  timeChoices: EmailComposerTimeChoices;
  navigation: "pushCard" | "updateCard";
  notification?: string;
}): JsonRecord {
  const selected = new Set(input.timeChoices.selectedStartsAt);
  const widgets: JsonRecord[] = [
    {
      textParagraph: {
        text: `Choose 1–5 times for <b>${cardText(input.asset.title)}</b>. Availability will be checked again before anything is inserted.`,
      },
    },
    {
      selectionInput: {
        name: "displayTimezone",
        label: "Show times in",
        type: "DROPDOWN",
        items: emailTimezoneOptions(input.timeChoices.timezone).map(
          (option) => ({
            text: cardText(option.label),
            value: option.value,
            selected: option.value === input.timeChoices.timezone,
          }),
        ),
        onChangeAction: actionSpec(input.endpoint, "refresh_times", {
          meetingAssetId: input.asset.id,
        }),
      },
    },
    {
      selectionInput: {
        name: "selectedStartsAt",
        label: `Live in ${cardText(emailTimezoneLabel(input.timeChoices.timezone))}`,
        type: "CHECK_BOX",
        items: input.timeChoices.choices.slice(0, 12).map((choice) => ({
          text: cardText(choice.label),
          value: choice.startsAt,
          selected: selected.has(choice.startsAt),
        })),
      },
    },
    {
      buttonList: {
        buttons: [
          {
            text: "Insert selected times",
            onClick: action(input.endpoint, "insert_times", {
              meetingAssetId: input.asset.id,
            }),
          },
          {
            text: "Refresh availability",
            onClick: action(input.endpoint, "refresh_times", {
              meetingAssetId: input.asset.id,
            }),
          },
        ],
      },
    },
  ];
  const navigation = {
    [input.navigation]: addonCard({
      endpoint: input.endpoint,
      title: "Choose live times",
      subtitle: input.asset.title,
      widgets,
    }),
  };
  return {
    renderActions: {
      action: {
        ...(input.notification
          ? { notification: { text: cardText(input.notification, 240) } }
          : {}),
        navigations: [navigation],
      },
    },
  };
}

export function googleWorkspaceInsertedCard(input: {
  endpoint: string;
  content: EmailComposerContent;
}): JsonRecord {
  const inserted = googleWorkspaceDraftInsert(input.content);
  const renderActions = inserted.renderActions as JsonRecord;
  const actionMarkup = renderActions.action as JsonRecord;
  actionMarkup.navigations = [
    {
      updateCard: addonCard({
        endpoint: input.endpoint,
        title: "Scheduling inserted",
        widgets: [
          {
            textParagraph: {
              text: "Inserted once at the cursor. Edit the draft normally, or close Hot Potato when you are done.",
            },
          },
        ],
      }),
    },
  ];
  return inserted;
}

export function googleWorkspaceSetupCard(message: string): JsonRecord {
  return {
    renderActions: {
      action: {
        navigations: [
          {
            pushCard: {
              header: { title: "Hot Potato needs setup" },
              sections: [
                {
                  widgets: [
                    {
                      textParagraph: { text: cardText(message, 500) },
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    },
  };
}

export function googleWorkspaceNotification(message: string): JsonRecord {
  return {
    renderActions: {
      action: { notification: { text: cardText(message, 240) } },
    },
  };
}

export function googleWorkspaceScopeRequest(): JsonRecord {
  return {
    requesting_google_scopes: { all_scopes: true },
  };
}

export function googleWorkspaceDraftInsert(
  content: EmailComposerContent,
): JsonRecord {
  return {
    renderActions: {
      action: {
        notification: {
          text: "Scheduling options inserted. You can edit them before sending.",
        },
      },
      hostAppAction: {
        gmailAction: {
          updateDraftActionMarkup: {
            updateBody: {
              insertContents: [
                { content: content.html, contentType: "MUTABLE_HTML" },
              ],
              type: "IN_PLACE_INSERT",
            },
          },
        },
      },
    },
  };
}

export function googleWorkspaceStringInput(
  event: GoogleWorkspaceAddonEvent,
  name: string,
): string | null {
  const input = event.formInputs[name];
  if (input?.kind !== "strings" || input.values.length !== 1) return null;
  return input.values[0] ?? null;
}

export function googleWorkspaceStringInputs(
  event: GoogleWorkspaceAddonEvent,
  name: string,
): string[] {
  const input = event.formInputs[name];
  if (input?.kind !== "strings") return [];
  return [...input.values];
}
