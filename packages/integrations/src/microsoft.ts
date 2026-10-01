import { ProviderHttpError } from "./hubspot.js";
import type {
  OAuthAuthorizationInput,
  OAuthCodeInput,
  OAuthProviderClient,
  OAuthTokenSet,
} from "./oauth.js";
import type {
  AvailabilityQuery,
  CalendarAdapter,
  CalendarEventInput,
  CalendarEventLookupInput,
  CalendarEventResult,
  CalendarIntervalQuery,
  ConnectedCalendar,
} from "./types.js";
import { calendarEventAttendees } from "./types.js";

const AUTHORIZE_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const PROFILE_URL =
  "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName";
const SCHEDULE_URL = "https://graph.microsoft.com/v1.0/me/calendar/getSchedule";
const CALENDAR_VIEW_URL = "https://graph.microsoft.com/v1.0/me/calendarView";
const CALENDARS_URL = "https://graph.microsoft.com/v1.0/me/calendars";
const EVENTS_URL = "https://graph.microsoft.com/v1.0/me/events";
const GRAPH_ORIGIN = "https://graph.microsoft.com";
const MAX_GRAPH_PAGES = 50;
const MAX_SELECTED_CALENDARS = 50;
const MAX_CALENDAR_ID_LENGTH = 1_024;
const CALENDAR_READ_CONCURRENCY = 4;
export const MICROSOFT_DEFAULT_CALENDAR_ID = "default";
const MICROSOFT_CONSUMER_TENANT_ID = "9188040d-6c67-4c5b-b112-36a304b66dad";
const MICROSOFT_IDENTITY_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
];

type MicrosoftTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  id_token?: string;
  scope?: string;
};

function microsoftAccountMetadata(idToken?: string): Record<string, unknown> {
  if (!idToken) return {};
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { tid?: unknown };
    if (typeof payload.tid !== "string") return {};
    const personal = payload.tid === MICROSOFT_CONSUMER_TENANT_ID;
    return {
      tenantId: payload.tid,
      accountType: personal ? "personal" : "organization",
      availabilityMode: personal ? "unsupported" : "getSchedule",
    };
  } catch {
    return {};
  }
}

async function responseJson<T>(
  response: Response,
  operation: string,
): Promise<T> {
  if (!response.ok) {
    throw new ProviderHttpError(
      "microsoft",
      operation,
      response.status,
      (await response.text()).slice(0, 1_000),
    );
  }
  return (await response.json()) as T;
}

type JsonRecord = Record<string, unknown>;

function jsonRecord(value: unknown, operation: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Microsoft ${operation} returned an invalid response.`);
  }
  return value as JsonRecord;
}

function collectionPage(
  value: unknown,
  operation: string,
): { items: unknown[]; nextLink: string | null } {
  const body = jsonRecord(value, operation);
  if (!Array.isArray(body.value)) {
    throw new Error(`Microsoft ${operation} returned an invalid collection.`);
  }
  const nextLink = body["@odata.nextLink"];
  if (
    nextLink !== undefined &&
    (typeof nextLink !== "string" || nextLink.trim().length === 0)
  ) {
    throw new Error(`Microsoft ${operation} returned an invalid next page.`);
  }
  return { items: body.value, nextLink: nextLink ?? null };
}

function validatedGraphPageUrl(
  value: string,
  expectedPath: string,
  operation: string,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Microsoft ${operation} returned an invalid next page.`);
  }
  if (
    url.origin !== GRAPH_ORIGIN ||
    url.pathname !== expectedPath ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(`Microsoft ${operation} returned an unsafe next page.`);
  }
  return url.toString();
}

async function graphCollection(input: {
  initialUrl: URL;
  accessToken: string;
  request: typeof fetch;
  operation: string;
  signal?: AbortSignal;
  preferUtc?: boolean;
}): Promise<unknown[]> {
  const expectedPath = input.initialUrl.pathname;
  const seen = new Set<string>();
  const items: unknown[] = [];
  let nextUrl: string | null = input.initialUrl.toString();
  let pageCount = 0;

  while (nextUrl) {
    input.signal?.throwIfAborted();
    if (pageCount >= MAX_GRAPH_PAGES) {
      throw new Error(
        `Microsoft ${input.operation} exceeded the pagination limit.`,
      );
    }
    const pageUrl = validatedGraphPageUrl(
      nextUrl,
      expectedPath,
      input.operation,
    );
    if (seen.has(pageUrl)) {
      throw new Error(`Microsoft ${input.operation} repeated a page.`);
    }
    seen.add(pageUrl);
    pageCount += 1;

    const response = await input.request(pageUrl, {
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        ...(input.preferUtc ? { prefer: 'outlook.timezone="UTC"' } : {}),
      },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const page = collectionPage(
      await responseJson<unknown>(response, input.operation),
      input.operation,
    );
    items.push(...page.items);
    nextUrl = page.nextLink;
  }

  return items;
}

function validatedCalendarId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CALENDAR_ID_LENGTH ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error("Microsoft calendar selection contains an invalid ID.");
  }
  return value;
}

function selectedCalendarIds(values?: string[]): string[] {
  if (values !== undefined && !Array.isArray(values)) {
    throw new Error("Microsoft calendar selection must be a list.");
  }
  const selected = values ?? [MICROSOFT_DEFAULT_CALENDAR_ID];
  if (selected.length === 0 || selected.length > MAX_SELECTED_CALENDARS) {
    throw new Error(
      "Microsoft calendar selection must contain between 1 and 50 calendars.",
    );
  }
  return [...new Set(selected.map(validatedCalendarId))];
}

function microsoftCalendar(value: unknown): {
  id: string;
  name: string;
  isDefault: boolean;
} {
  const calendar = jsonRecord(value, "calendar discovery");
  const id = validatedCalendarId(calendar.id);
  const name = typeof calendar.name === "string" ? calendar.name.trim() : "";
  if (
    name.length === 0 ||
    name.length > 300 ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    typeof calendar.isDefaultCalendar !== "boolean"
  ) {
    throw new Error(
      "Microsoft calendar discovery returned an invalid calendar.",
    );
  }
  return {
    id,
    name,
    isDefault: calendar.isDefaultCalendar,
  };
}

function parseGraphDate(value: string, timezone?: string): Date {
  return new Date(
    timezone === "UTC" && !/[zZ]|[+-]\d\d:\d\d$/.test(value)
      ? `${value}Z`
      : value,
  );
}

function busyInterval(value: unknown): { startsAt: Date; endsAt: Date } | null {
  const event = jsonRecord(value, "representative calendar availability");
  if (
    event.isCancelled !== undefined &&
    typeof event.isCancelled !== "boolean"
  ) {
    throw new Error(
      "Microsoft representative calendar availability returned an invalid event.",
    );
  }
  if (event.showAs !== undefined && typeof event.showAs !== "string") {
    throw new Error(
      "Microsoft representative calendar availability returned an invalid event.",
    );
  }
  if (
    event.isCancelled ||
    event.showAs === "free" ||
    event.showAs === "workingElsewhere"
  ) {
    return null;
  }

  const start = jsonRecord(event.start, "representative calendar availability");
  const end = jsonRecord(event.end, "representative calendar availability");
  if (
    typeof start.dateTime !== "string" ||
    typeof end.dateTime !== "string" ||
    (start.timeZone !== undefined && typeof start.timeZone !== "string") ||
    (end.timeZone !== undefined && typeof end.timeZone !== "string")
  ) {
    throw new Error(
      "Microsoft representative calendar availability returned an invalid event.",
    );
  }
  const startsAt = parseGraphDate(start.dateTime, start.timeZone);
  const endsAt = parseGraphDate(end.dateTime, end.timeZone);
  if (
    !Number.isFinite(startsAt.getTime()) ||
    !Number.isFinite(endsAt.getTime()) ||
    endsAt <= startsAt
  ) {
    throw new Error(
      "Microsoft representative calendar availability returned an invalid event.",
    );
  }
  return { startsAt, endsAt };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await map(values[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () =>
      worker(),
    ),
  );
  return results;
}

export class MicrosoftOAuthClient implements OAuthProviderClient {
  readonly provider = "microsoft" as const;

  constructor(
    private readonly config: {
      clientId: string;
      clientSecret: string;
      calendarScope?: "Calendars.ReadBasic" | "Calendars.ReadWrite";
    },
    private readonly request: typeof fetch = fetch,
  ) {}

  private get scopes(): string[] {
    return [
      ...MICROSOFT_IDENTITY_SCOPES,
      this.config.calendarScope ?? "Calendars.ReadBasic",
    ];
  }

  authorizationUrl(input: OAuthAuthorizationInput): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("scope", this.scopes.join(" "));
    url.searchParams.set("state", input.state);
    url.searchParams.set("prompt", "select_account");
    if (input.codeChallenge) {
      url.searchParams.set("code_challenge", input.codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
    }
    return url.toString();
  }

  async exchangeCode(input: OAuthCodeInput): Promise<OAuthTokenSet> {
    const values: Record<string, string> = {
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      scope: this.scopes.join(" "),
    };
    if (input.codeVerifier) values.code_verifier = input.codeVerifier;
    const tokens = await this.tokenRequest(values);
    const profile = await responseJson<{
      id: string;
      displayName?: string;
      mail?: string | null;
      userPrincipalName?: string;
    }>(
      await this.request(PROFILE_URL, {
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      }),
      "profile lookup",
    );
    return {
      ...tokens,
      externalAccountId: profile.id,
      externalAccountName:
        profile.mail ?? profile.userPrincipalName ?? profile.displayName,
      metadata: { ...tokens.metadata, displayName: profile.displayName },
    };
  }

  async refresh(refreshToken: string): Promise<OAuthTokenSet> {
    return this.tokenRequest({
      grant_type: "refresh_token",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: refreshToken,
      scope: this.scopes.join(" "),
    });
  }

  private async tokenRequest(
    values: Record<string, string>,
  ): Promise<OAuthTokenSet> {
    const response = await this.request(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values),
    });
    const body = await responseJson<MicrosoftTokenResponse>(
      response,
      "OAuth token exchange",
    );
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: new Date(Date.now() + body.expires_in * 1_000),
      scopes: body.scope?.split(" ").filter(Boolean) ?? this.scopes,
      metadata: microsoftAccountMetadata(body.id_token),
    };
  }
}

function graphDateTime(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "");
}

type MicrosoftCalendarEvent = {
  id: string;
  transactionId?: string | null;
  isCancelled?: boolean;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  webLink?: string | null;
  onlineMeeting?: { joinUrl?: string | null } | null;
  attendees?: Array<{
    emailAddress?: { address?: string; [key: string]: unknown };
    [key: string]: unknown;
  }>;
};

class MicrosoftTeamsJoinUrlMissingError extends Error {}
class MicrosoftAttendeeFinalizationError extends Error {}

function isPermanentProviderFailure(error: unknown): boolean {
  return (
    error instanceof ProviderHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 409, 425, 429].includes(error.status)
  );
}

function microsoftConferenceUrl(
  event: MicrosoftCalendarEvent,
  input: CalendarEventInput,
): string | null {
  const teamsUrl = event.onlineMeeting?.joinUrl ?? null;
  if (input.conferenceProvider === "microsoft_teams" && !teamsUrl) {
    throw new MicrosoftTeamsJoinUrlMissingError(
      "Microsoft Outlook did not return a Microsoft Teams join URL.",
    );
  }
  return teamsUrl ?? input.conferenceUrl ?? null;
}

function verifiedMicrosoftUrl(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Microsoft Calendar returned an invalid ${label}.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Microsoft Calendar returned an invalid ${label}.`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`Microsoft Calendar returned an invalid ${label}.`);
  }
  return value;
}

function verifiedMicrosoftBookingEvent(
  event: MicrosoftCalendarEvent,
  input: CalendarEventLookupInput,
  expectedEventId?: string,
): MicrosoftCalendarEvent {
  if (
    typeof event.id !== "string" ||
    event.id.length === 0 ||
    event.id.trim() !== event.id ||
    /[\u0000-\u001f\u007f]/.test(event.id)
  ) {
    throw new Error("Microsoft Calendar returned an invalid booking event ID.");
  }
  if (expectedEventId !== undefined && event.id !== expectedEventId) {
    throw new Error("Microsoft Calendar returned the wrong booking event.");
  }
  if (event.transactionId !== input.transactionId) {
    throw new Error(
      "Microsoft Calendar returned conflicting booking ownership evidence.",
    );
  }
  if (event.isCancelled === true) {
    throw new Error("Microsoft Calendar returned a cancelled booking event.");
  }
  if (event.isCancelled !== false) {
    throw new Error("Microsoft Calendar returned an invalid booking status.");
  }
  if (
    typeof event.start?.dateTime !== "string" ||
    typeof event.end?.dateTime !== "string"
  ) {
    throw new Error(
      "Microsoft Calendar returned an invalid booking event time.",
    );
  }
  const startsAt = parseGraphDate(event.start.dateTime, event.start.timeZone);
  const endsAt = parseGraphDate(event.end.dateTime, event.end.timeZone);
  if (
    !Number.isFinite(startsAt.getTime()) ||
    !Number.isFinite(endsAt.getTime()) ||
    startsAt.getTime() !== input.startsAt.getTime() ||
    endsAt.getTime() !== input.endsAt.getTime()
  ) {
    throw new Error(
      "Microsoft Calendar returned a booking event outside the reserved time.",
    );
  }
  verifiedMicrosoftUrl(event.webLink, "booking event link");
  verifiedMicrosoftUrl(event.onlineMeeting?.joinUrl, "conference link");
  return event;
}

export class MicrosoftCalendarAdapter implements CalendarAdapter {
  readonly key = "microsoft";

  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly request: typeof fetch = fetch,
  ) {}

  async busyRepEmails(input: AvailabilityQuery): Promise<string[]> {
    const accessToken = await this.getAccessToken();
    const busy = new Set<string>();

    for (let index = 0; index < input.repEmails.length; index += 20) {
      const emails = input.repEmails.slice(index, index + 20);
      const response = await this.request(SCHEDULE_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          prefer: 'outlook.timezone="UTC"',
        },
        body: JSON.stringify({
          schedules: emails,
          startTime: {
            dateTime: graphDateTime(input.startsAt),
            timeZone: "UTC",
          },
          endTime: { dateTime: graphDateTime(input.endsAt), timeZone: "UTC" },
          availabilityViewInterval: 30,
        }),
      });
      const body = await responseJson<{
        value: Array<{
          scheduleId: string;
          availabilityView?: string;
          error?: { message?: string };
        }>;
      }>(response, "calendar free/busy");
      const schedules = new Map(
        body.value.map((item) => [item.scheduleId.toLocaleLowerCase(), item]),
      );
      for (const email of emails) {
        const schedule = schedules.get(email.toLocaleLowerCase());
        if (!schedule || schedule.error) {
          throw new Error(
            `Microsoft 365 could not verify availability for ${email}.`,
          );
        }
        if (
          [...(schedule.availabilityView ?? "")].some(
            (slot) => slot !== "0" && slot !== "4",
          )
        ) {
          busy.add(email);
        }
      }
    }

    return [...busy];
  }
}

export class MicrosoftRepCalendarAdapter implements CalendarAdapter {
  readonly key = "microsoft-rep";

  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly request: typeof fetch = fetch,
  ) {}

  async listCalendars(
    input: { signal?: AbortSignal } = {},
  ): Promise<ConnectedCalendar[]> {
    input.signal?.throwIfAborted();
    const accessToken = await this.getAccessToken();
    input.signal?.throwIfAborted();
    const initialUrl = new URL(CALENDARS_URL);
    initialUrl.searchParams.set("$select", "id,name,isDefaultCalendar");
    initialUrl.searchParams.set("$top", "100");
    const values = await graphCollection({
      initialUrl,
      accessToken,
      request: this.request,
      operation: "calendar discovery",
      signal: input.signal,
    });

    const discovered = new Map<
      string,
      { id: string; name: string; isDefault: boolean }
    >();
    for (const value of values) {
      const calendar = microsoftCalendar(value);
      const existing = discovered.get(calendar.id);
      if (
        existing &&
        (existing.name !== calendar.name ||
          existing.isDefault !== calendar.isDefault)
      ) {
        throw new Error(
          "Microsoft calendar discovery returned a conflicting duplicate calendar.",
        );
      }
      discovered.set(calendar.id, calendar);
    }

    const defaults = [...discovered.values()].filter(
      (calendar) => calendar.isDefault,
    );
    if (defaults.length !== 1) {
      throw new Error(
        "Microsoft calendar discovery must return exactly one default calendar.",
      );
    }

    const mapped = new Map<string, ConnectedCalendar>();
    for (const calendar of discovered.values()) {
      const id = calendar.isDefault
        ? MICROSOFT_DEFAULT_CALENDAR_ID
        : calendar.id;
      if (mapped.has(id)) {
        throw new Error(
          "Microsoft calendar discovery returned an ambiguous calendar ID.",
        );
      }
      mapped.set(id, {
        id,
        name: calendar.name,
        isDefault: calendar.isDefault,
      });
    }
    return [...mapped.values()].sort(
      (left, right) =>
        Number(right.isDefault) - Number(left.isDefault) ||
        left.name.localeCompare(right.name),
    );
  }

  private async ensureAttendees(
    event: MicrosoftCalendarEvent,
    input: CalendarEventInput,
    accessToken: string,
  ): Promise<MicrosoftCalendarEvent> {
    input.signal?.throwIfAborted();
    const intended = calendarEventAttendees(input);
    if (intended.length === 0) return event;
    const existingEmails = new Set(
      (event.attendees ?? [])
        .map((attendee) => attendee.emailAddress?.address?.trim().toLowerCase())
        .filter((email): email is string => Boolean(email)),
    );
    const missing = intended.filter(
      (attendee) => !existingEmails.has(attendee.email),
    );
    if (missing.length === 0) return event;

    const response = await this.request(
      `${EVENTS_URL}/${encodeURIComponent(event.id)}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          prefer: 'outlook.timezone="UTC"',
        },
        body: JSON.stringify({
          attendees: [
            ...(event.attendees ?? []),
            ...missing.map((attendee) => ({
              emailAddress: {
                address: attendee.email,
                ...(attendee.name ? { name: attendee.name } : {}),
              },
              type: "required",
            })),
          ],
        }),
        signal: input.signal,
      },
    );
    const updated = await responseJson<MicrosoftCalendarEvent>(
      response,
      "calendar attendee invitation",
    );
    const merged = {
      ...event,
      ...updated,
      onlineMeeting: updated.onlineMeeting ?? event.onlineMeeting,
    };
    const confirmedEmails = new Set(
      (merged.attendees ?? [])
        .map((attendee) => attendee.emailAddress?.address?.trim().toLowerCase())
        .filter((email): email is string => Boolean(email)),
    );
    if (intended.some((attendee) => !confirmedEmails.has(attendee.email))) {
      throw new MicrosoftAttendeeFinalizationError(
        "Microsoft Outlook did not confirm every attendee invitation.",
      );
    }
    return merged;
  }

  private async bestEffortDeleteEvent(
    externalEventId: string,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      signal?.throwIfAborted();
      await this.request(
        `${EVENTS_URL}/${encodeURIComponent(externalEventId)}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${accessToken}` },
          signal,
        },
      );
    } catch {
      // Preserve the original conference or invitation error.
    }
  }

  async busyRepEmails(input: AvailabilityQuery): Promise<string[]> {
    if (input.repEmails.length !== 1) {
      throw new Error(
        "A representative-scoped calendar can check exactly one representative.",
      );
    }
    const busy = (await this.busyIntervals(input)).some(
      (interval) =>
        interval.startsAt < input.endsAt && interval.endsAt > input.startsAt,
    );
    return busy ? input.repEmails : [];
  }

  async busyIntervals(
    input: CalendarIntervalQuery,
  ): Promise<Array<{ startsAt: Date; endsAt: Date }>> {
    if (
      !Number.isFinite(input.startsAt.getTime()) ||
      !Number.isFinite(input.endsAt.getTime()) ||
      input.endsAt <= input.startsAt
    ) {
      throw new Error("Microsoft calendar availability range is invalid.");
    }
    const calendarIds = selectedCalendarIds(input.calendarIds);
    input.signal?.throwIfAborted();
    const accessToken = await this.getAccessToken();
    input.signal?.throwIfAborted();
    const calendars = await mapWithConcurrency(
      calendarIds,
      CALENDAR_READ_CONCURRENCY,
      async (calendarId) => {
        input.signal?.throwIfAborted();
        const initialUrl =
          calendarId === MICROSOFT_DEFAULT_CALENDAR_ID
            ? new URL(CALENDAR_VIEW_URL)
            : new URL(
                `${CALENDARS_URL}/${encodeURIComponent(calendarId)}/calendarView`,
              );
        initialUrl.searchParams.set(
          "startDateTime",
          input.startsAt.toISOString(),
        );
        initialUrl.searchParams.set("endDateTime", input.endsAt.toISOString());
        initialUrl.searchParams.set(
          "$select",
          "id,showAs,isCancelled,start,end",
        );
        initialUrl.searchParams.set("$top", "1000");
        const values = await graphCollection({
          initialUrl,
          accessToken,
          request: this.request,
          operation: "representative calendar availability",
          signal: input.signal,
          preferUtc: true,
        });
        return values.flatMap((value) => {
          const interval = busyInterval(value);
          return interval ? [interval] : [];
        });
      },
    );

    const unique = new Map<string, { startsAt: Date; endsAt: Date }>();
    for (const interval of calendars.flat()) {
      unique.set(
        `${interval.startsAt.getTime()}:${interval.endsAt.getTime()}`,
        interval,
      );
    }
    return [...unique.values()].sort(
      (left, right) => left.startsAt.getTime() - right.startsAt.getTime(),
    );
  }

  async findEventByTransactionId(
    input: CalendarEventLookupInput,
  ): Promise<CalendarEventResult | null> {
    if (
      typeof input.transactionId !== "string" ||
      input.transactionId.length === 0 ||
      input.transactionId.length > 1_024 ||
      /[\u0000-\u001f\u007f]/.test(input.transactionId) ||
      !Number.isFinite(input.startsAt.getTime()) ||
      !Number.isFinite(input.endsAt.getTime()) ||
      input.endsAt <= input.startsAt
    ) {
      throw new Error("Microsoft calendar event lookup input is invalid.");
    }

    input.signal?.throwIfAborted();
    const accessToken = await this.getAccessToken();
    input.signal?.throwIfAborted();
    const initialUrl = new URL(CALENDAR_VIEW_URL);
    initialUrl.searchParams.set("startDateTime", input.startsAt.toISOString());
    initialUrl.searchParams.set("endDateTime", input.endsAt.toISOString());
    initialUrl.searchParams.set(
      "$select",
      "id,transactionId,webLink,onlineMeeting,isCancelled,start,end",
    );
    initialUrl.searchParams.set("$top", "1000");
    const values = await graphCollection({
      initialUrl,
      accessToken,
      request: this.request,
      operation: "booking event reconciliation",
      signal: input.signal,
      preferUtc: true,
    });
    const matches = values.filter((value) => {
      const event = jsonRecord(value, "booking event reconciliation");
      if (
        event.transactionId !== undefined &&
        event.transactionId !== null &&
        typeof event.transactionId !== "string"
      ) {
        throw new Error(
          "Microsoft booking event reconciliation returned invalid ownership evidence.",
        );
      }
      return event.transactionId === input.transactionId;
    });
    if (matches.length === 0) return null;
    if (matches.length > 1) {
      throw new Error(
        "Microsoft Calendar returned ambiguous booking ownership evidence.",
      );
    }

    const event = jsonRecord(
      matches[0],
      "booking event reconciliation",
    ) as MicrosoftCalendarEvent;
    if (
      typeof event.id !== "string" ||
      event.id.length === 0 ||
      event.id.trim() !== event.id ||
      /[\u0000-\u001f\u007f]/.test(event.id) ||
      typeof event.isCancelled !== "boolean"
    ) {
      throw new Error(
        "Microsoft booking event reconciliation returned an invalid event.",
      );
    }
    if (event.isCancelled === true) return null;
    if (
      event.transactionId !== input.transactionId ||
      event.isCancelled !== false
    ) {
      throw new Error(
        "Microsoft booking event reconciliation returned an invalid event.",
      );
    }
    verifiedMicrosoftBookingEvent(event, input);
    const joinUrl = event.onlineMeeting?.joinUrl;
    return {
      externalEventId: event.id,
      webLink: event.webLink ?? null,
      conferenceUrl: joinUrl ?? null,
    };
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEventResult> {
    input.signal?.throwIfAborted();
    const accessToken = await this.getAccessToken();
    input.signal?.throwIfAborted();
    const attendees = calendarEventAttendees(input);
    const response = await this.request(EVENTS_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        prefer: 'outlook.timezone="UTC"',
      },
      body: JSON.stringify({
        subject: input.subject,
        start: { dateTime: graphDateTime(input.startsAt), timeZone: "UTC" },
        end: { dateTime: graphDateTime(input.endsAt), timeZone: "UTC" },
        transactionId: input.transactionId,
        ...(input.conferenceProvider === "microsoft_teams"
          ? {
              isOnlineMeeting: true,
              onlineMeetingProvider: "teamsForBusiness",
            }
          : {}),
        ...(input.conferenceProvider === "zoom" && input.conferenceUrl
          ? {
              location: {
                displayName: "Zoom",
                locationUri: input.conferenceUrl,
              },
            }
          : {}),
        ...(input.description
          ? { body: { contentType: "text", content: input.description } }
          : {}),
        attendees:
          input.conferenceProvider === "microsoft_teams"
            ? []
            : attendees.map((attendee) => ({
                emailAddress: {
                  address: attendee.email,
                  ...(attendee.name ? { name: attendee.name } : {}),
                },
                type: "required",
              })),
      }),
      signal: input.signal,
    });
    let body = await responseJson<MicrosoftCalendarEvent>(
      response,
      "calendar event creation",
    );
    verifiedMicrosoftBookingEvent(body, input);
    try {
      if (input.conferenceProvider === "microsoft_teams") {
        microsoftConferenceUrl(body, input);
      }
      body = await this.ensureAttendees(body, input, accessToken);
    } catch (error) {
      if (
        error instanceof MicrosoftTeamsJoinUrlMissingError ||
        error instanceof MicrosoftAttendeeFinalizationError ||
        isPermanentProviderFailure(error)
      ) {
        await this.bestEffortDeleteEvent(body.id, accessToken, input.signal);
      }
      throw error;
    }
    verifiedMicrosoftBookingEvent(body, input);
    return {
      externalEventId: body.id,
      webLink: body.webLink ?? null,
      conferenceUrl: microsoftConferenceUrl(body, input),
    };
  }

  async updateEvent(
    externalEventId: string,
    input: CalendarEventInput,
  ): Promise<CalendarEventResult> {
    input.signal?.throwIfAborted();
    const accessToken = await this.getAccessToken();
    input.signal?.throwIfAborted();
    const response = await this.request(
      `${EVENTS_URL}/${encodeURIComponent(externalEventId)}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          prefer: 'outlook.timezone="UTC"',
        },
        body: JSON.stringify({
          start: { dateTime: graphDateTime(input.startsAt), timeZone: "UTC" },
          end: { dateTime: graphDateTime(input.endsAt), timeZone: "UTC" },
        }),
        signal: input.signal,
      },
    );
    const body = await responseJson<MicrosoftCalendarEvent>(
      response,
      "calendar event update",
    );
    verifiedMicrosoftBookingEvent(body, input, externalEventId);
    return {
      externalEventId: body.id,
      webLink: body.webLink ?? null,
      conferenceUrl: microsoftConferenceUrl(body, input),
    };
  }

  async cancelEvent(
    externalEventId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const accessToken = await this.getAccessToken();
    signal?.throwIfAborted();
    const response = await this.request(
      `${EVENTS_URL}/${encodeURIComponent(externalEventId)}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessToken}` },
        signal,
      },
    );
    if (response.ok || response.status === 404 || response.status === 410) {
      return;
    }
    throw new ProviderHttpError(
      "microsoft",
      "calendar event cancellation",
      response.status,
      (await response.text()).slice(0, 1_000),
    );
  }
}
