import type {
  EmailComposerAsset,
  EmailComposerContent,
  EmailComposerSlot,
  EmailComposerTimeChoices,
  SuggestedEmailSlot,
} from "./types.js";

export const maximumSelectedEmailSlots = 5;
export const defaultSelectedEmailSlots = 3;
export const defaultEmailTimeChoiceCount = 12;
export const maximumEmailTimeChoiceCount = 15;

function withoutControls(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
}

function safeDisplayText(value: string, maximumLength = 500): string {
  return withoutControls(value).slice(0, maximumLength);
}

export function escapeEmailHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function safeBookingUrl(value: string): string {
  if (value.length > 2_048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("The scheduling URL is invalid.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The scheduling URL is invalid.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The scheduling URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("The scheduling URL cannot include credentials.");
  }
  return url.toString();
}

export function validateTimezone(timezone: string): string {
  const normalized = withoutControls(timezone).slice(0, 100);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format();
  } catch {
    throw new Error("Choose a valid timezone.");
  }
  return normalized;
}

export function validateLocale(locale = "en-US"): string {
  const normalized = withoutControls(locale).slice(0, 80);
  if (!normalized) throw new Error("Choose a valid locale.");
  try {
    const canonical = Intl.getCanonicalLocales(normalized);
    if (canonical.length !== 1 || !canonical[0]) {
      throw new Error("Choose a valid locale.");
    }
    return canonical[0];
  } catch {
    throw new Error("Choose a valid locale.");
  }
}

function localDateKey(value: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function formatSuggestedSlot(
  value: string,
  timezone: string,
  locale = "en-US",
): string {
  const safeTimezone = validateTimezone(timezone);
  const safeLocale = validateLocale(locale);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("A suggested time is invalid.");
  }
  return new Intl.DateTimeFormat(safeLocale, {
    timeZone: safeTimezone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function selectSuggestedSlots(
  slots: EmailComposerSlot[],
  requestedCount: number,
  timezone: string,
): EmailComposerSlot[] {
  const safeTimezone = validateTimezone(timezone);
  const count = Math.max(
    1,
    Math.min(maximumSelectedEmailSlots, Math.trunc(requestedCount)),
  );
  const ordered = [...slots]
    .filter((slot) => {
      const start = new Date(slot.startsAt).getTime();
      const end = new Date(slot.endsAt).getTime();
      return Number.isFinite(start) && Number.isFinite(end) && end > start;
    })
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  const unique = ordered.filter(
    (slot, index) =>
      index === 0 || slot.startsAt !== ordered[index - 1]?.startsAt,
  );

  const selected: EmailComposerSlot[] = [];
  const selectedStarts = new Set<string>();
  const selectedDays = new Set<string>();
  for (const slot of unique) {
    const day = localDateKey(slot.startsAt, safeTimezone);
    if (selectedDays.has(day)) continue;
    selected.push(slot);
    selectedStarts.add(slot.startsAt);
    selectedDays.add(day);
    if (selected.length === count) return selected;
  }
  for (const slot of unique) {
    if (selectedStarts.has(slot.startsAt)) continue;
    selected.push(slot);
    if (selected.length === count) break;
  }
  return selected;
}

function orderedUniqueSlots(slots: EmailComposerSlot[]): EmailComposerSlot[] {
  const ordered = [...slots]
    .filter((slot) => {
      const start = new Date(slot.startsAt).getTime();
      const end = new Date(slot.endsAt).getTime();
      return Number.isFinite(start) && Number.isFinite(end) && end > start;
    })
    .sort(
      (left, right) =>
        left.startsAt.localeCompare(right.startsAt) ||
        left.endsAt.localeCompare(right.endsAt),
    );
  const starts = new Set<string>();
  return ordered.filter((slot) => {
    if (starts.has(slot.startsAt)) return false;
    starts.add(slot.startsAt);
    return true;
  });
}

function diverseChoiceWindow(
  slots: EmailComposerSlot[],
  choiceCount: number,
  timezone: string,
): EmailComposerSlot[] {
  const slotsByDay = new Map<string, EmailComposerSlot[]>();
  for (const slot of orderedUniqueSlots(slots)) {
    const day = localDateKey(slot.startsAt, timezone);
    const daySlots = slotsByDay.get(day) ?? [];
    daySlots.push(slot);
    slotsByDay.set(day, daySlots);
  }

  const dayGroups = [...slotsByDay.values()];
  const selected: EmailComposerSlot[] = [];
  for (
    let groupStart = 0;
    groupStart < dayGroups.length && selected.length < choiceCount;
    groupStart += defaultSelectedEmailSlots
  ) {
    const group = dayGroups.slice(
      groupStart,
      groupStart + defaultSelectedEmailSlots,
    );
    for (let slotIndex = 0; selected.length < choiceCount; slotIndex += 1) {
      let added = false;
      for (const daySlots of group) {
        const slot = daySlots[slotIndex];
        if (!slot) continue;
        selected.push(slot);
        added = true;
        if (selected.length === choiceCount) break;
      }
      if (!added) break;
    }
  }
  return selected.sort((left, right) =>
    left.startsAt.localeCompare(right.startsAt),
  );
}

export function createEmailTimeChoices(input: {
  asset: EmailComposerAsset;
  available: EmailComposerSlot[];
  timezone: string;
  locale?: string;
  choiceCount?: number;
}): EmailComposerTimeChoices {
  const safe = safeAsset(input.asset);
  if (safe.kind !== "meeting_type") {
    throw new Error("Smart Router Links can only be inserted as links.");
  }
  const timezone = validateTimezone(input.timezone);
  const locale = validateLocale(input.locale);
  const choiceCount = Math.max(
    1,
    Math.min(
      maximumEmailTimeChoiceCount,
      Math.trunc(input.choiceCount ?? defaultEmailTimeChoiceCount),
    ),
  );
  const choices = diverseChoiceWindow(
    input.available,
    choiceCount,
    timezone,
  ).map((slot) => {
    const bookingUrl = new URL(safe.bookingUrl);
    bookingUrl.searchParams.set("time", slot.startsAt);
    return {
      ...slot,
      bookingUrl: bookingUrl.toString(),
      label: formatSuggestedSlot(slot.startsAt, timezone, locale),
    };
  });
  const selectedStartsAt = selectSuggestedSlots(
    choices,
    defaultSelectedEmailSlots,
    timezone,
  ).map((slot) => slot.startsAt);
  return { choices, selectedStartsAt, timezone, locale };
}

export type RevalidatedEmailTimeSelection =
  | { ok: true; slots: SuggestedEmailSlot[] }
  | { ok: false; reason: "invalid_selection" | "stale_selection" };

export function revalidateEmailTimeSelection(input: {
  choices: SuggestedEmailSlot[];
  selectedStartsAt: string[];
}): RevalidatedEmailTimeSelection {
  if (
    input.selectedStartsAt.length < 1 ||
    input.selectedStartsAt.length > maximumSelectedEmailSlots ||
    new Set(input.selectedStartsAt).size !== input.selectedStartsAt.length ||
    input.selectedStartsAt.some((value) => {
      const date = new Date(value);
      return !Number.isFinite(date.getTime()) || date.toISOString() !== value;
    })
  ) {
    return { ok: false, reason: "invalid_selection" };
  }
  const byStart = new Map(
    input.choices.map((choice) => [choice.startsAt, choice] as const),
  );
  const slots = input.selectedStartsAt.map((startsAt) => byStart.get(startsAt));
  if (slots.some((slot) => !slot)) {
    return { ok: false, reason: "stale_selection" };
  }
  return { ok: true, slots: slots as SuggestedEmailSlot[] };
}

function safeAsset(asset: EmailComposerAsset) {
  return {
    ...asset,
    title: safeDisplayText(asset.title, 120) || "meeting",
    hostName: asset.hostName ? safeDisplayText(asset.hostName, 120) : null,
    bookingUrl: safeBookingUrl(asset.bookingUrl),
  };
}

export function renderBookingLink(
  asset: EmailComposerAsset,
): EmailComposerContent {
  const safe = safeAsset(asset);
  const label = safe.hostName
    ? `Book ${safe.title} with ${safe.hostName}`
    : `Book ${safe.title}`;
  return {
    html: `<p><a href="${escapeEmailHtml(safe.bookingUrl)}">${escapeEmailHtml(label)}</a></p>`,
    text: `${label}: ${safe.bookingUrl}`,
  };
}

export function renderSuggestedTimes(input: {
  asset: EmailComposerAsset;
  slots: SuggestedEmailSlot[];
  timezone: string;
}): EmailComposerContent {
  const safe = safeAsset(input.asset);
  if (safe.kind !== "meeting_type") {
    throw new Error("Smart Router Links can only be inserted as links.");
  }
  const timezone = validateTimezone(input.timezone);
  const slots = input.slots.slice(0, maximumSelectedEmailSlots).map((slot) => ({
    ...slot,
    label: safeDisplayText(slot.label, 180),
    bookingUrl: safeBookingUrl(slot.bookingUrl),
  }));
  if (slots.length === 0) {
    throw new Error("Choose at least one available time.");
  }
  const timezoneLabel = timezone.replaceAll("_", " ");
  const listHtml = slots
    .map(
      (slot) =>
        `<li><a href="${escapeEmailHtml(slot.bookingUrl)}">${escapeEmailHtml(slot.label)}</a></li>`,
    )
    .join("");
  const listText = slots
    .map((slot) => `- ${slot.label}: ${slot.bookingUrl}`)
    .join("\n");
  const moreLabel = `See more times for ${safe.title}`;
  return {
    html: `<p>Would any of these times work? Times are shown in <strong>${escapeEmailHtml(timezoneLabel)}</strong>.</p><ul>${listHtml}</ul><p><a href="${escapeEmailHtml(safe.bookingUrl)}">${escapeEmailHtml(moreLabel)}</a></p>`,
    text: `Would any of these times work? Times are shown in ${timezoneLabel}.\n\n${listText}\n\n${moreLabel}: ${safe.bookingUrl}`,
  };
}
