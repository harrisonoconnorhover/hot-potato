export type EmailComposerAssetKind = "meeting_type" | "router_link";

export type EmailComposerAsset = {
  id: string;
  kind: EmailComposerAssetKind;
  slug: string;
  title: string;
  description: string;
  bookingUrl: string;
  hostName: string | null;
  durationMinutes: number | null;
};

export type EmailComposerSlot = {
  startsAt: string;
  endsAt: string;
};

export type SuggestedEmailSlot = EmailComposerSlot & {
  bookingUrl: string;
  label: string;
};

export type EmailComposerTimeChoices = {
  choices: SuggestedEmailSlot[];
  selectedStartsAt: string[];
  timezone: string;
  locale: string;
};

export type EmailComposerContent = {
  html: string;
  text: string;
};

export type EmailComposerInsertMessage = {
  type: "hot-potato.email-composer.insert";
  version: 1;
  requestId: string;
  content: EmailComposerContent;
};
