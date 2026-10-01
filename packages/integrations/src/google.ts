import { createHash } from "node:crypto";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
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

const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const CALENDAR_LIST_URL =
  "https://www.googleapis.com/calendar/v3/users/me/calendarList";
export const GOOGLE_PRIMARY_CALENDAR_ID = "primary";
const PRIMARY_EVENTS_URL = `https://www.googleapis.com/calendar/v3/calendars/${GOOGLE_PRIMARY_CALENDAR_ID}/events`;
const GOOGLE_IDENTITY_SCOPES = ["openid", "email"];
const GOOGLE_FREEBUSY_SCOPE =
  "https://www.googleapis.com/auth/calendar.freebusy";
const GOOGLE_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const GOOGLE_CALENDAR_LIST_READONLY_SCOPE =
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const GOOGLE_CALENDAR_LIST_MAX_PAGES = 20;
const GOOGLE_CALENDAR_ID_MAX_LENGTH = 1_024;
const GOOGLE_CALENDAR_NAME_MAX_LENGTH = 300;
const GOOGLE_PAGE_TOKEN_MAX_LENGTH = 2_048;

export class GoogleOAuthClient implements OAuthProviderClient {
  readonly provider = "google" as const;

  constructor(
    private readonly config: {
      clientId: string;
      clientSecret: string;
      calendarAccess?: "freebusy" | "readwrite";
    },
  ) {}

  private get scopes(): string[] {
    return [
      ...GOOGLE_IDENTITY_SCOPES,
      GOOGLE_FREEBUSY_SCOPE,
      ...(this.config.calendarAccess === "readwrite"
        ? [GOOGLE_EVENTS_SCOPE, GOOGLE_CALENDAR_LIST_READONLY_SCOPE]
        : []),
    ];
  }

  authorizationUrl(input: OAuthAuthorizationInput): string {
    return this.client(input.redirectUri).generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      scope: this.scopes,
      state: input.state,
      ...(input.codeChallenge
        ? {
            code_challenge: input.codeChallenge,
            code_challenge_method: CodeChallengeMethod.S256,
          }
        : {}),
    });
  }

  async exchangeCode(input: OAuthCodeInput): Promise<OAuthTokenSet> {
    const client = this.client(input.redirectUri);
    const { tokens } = await client.getToken({
      code: input.code,
      redirect_uri: input.redirectUri,
      ...(input.codeVerifier ? { codeVerifier: input.codeVerifier } : {}),
    });

    let accountId: string | undefined;
    let accountName: string | undefined;
    if (tokens.id_token) {
      const ticket = await client.verifyIdToken({
        idToken: tokens.id_token,
        audience: this.config.clientId,
      });
      const payload = ticket.getPayload();
      accountId = payload?.sub;
      accountName = payload?.email;
    }
    return this.tokenSet(tokens, accountId, accountName);
  }

  async refresh(refreshToken: string): Promise<OAuthTokenSet> {
    const client = this.client();
    client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await client.refreshAccessToken();
    return this.tokenSet(credentials);
  }

  private client(redirectUri?: string): OAuth2Client {
    return new OAuth2Client({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      redirectUri,
    });
  }

  private tokenSet(
    tokens: {
      access_token?: string | null;
      refresh_token?: string | null;
      expiry_date?: number | null;
      scope?: string;
    },
    accountId?: string,
    accountName?: string,
  ): OAuthTokenSet {
    if (!tokens.access_token)
      throw new Error("Google did not return an access token.");
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? undefined,
      expiresAt: new Date(tokens.expiry_date ?? Date.now() + 3_600_000),
      scopes: tokens.scope?.split(" ").filter(Boolean) ?? this.scopes,
      externalAccountId: accountId,
      externalAccountName: accountName,
    };
  }
}

export class GoogleCalendarAdapter implements CalendarAdapter {
  readonly key = "google";

  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly request: typeof fetch = fetch,
  ) {}

  async busyRepEmails(input: AvailabilityQuery): Promise<string[]> {
    const accessToken = await this.getAccessToken();
    const busy = new Set<string>();

    for (let index = 0; index < input.repEmails.length; index += 50) {
      const emails = input.repEmails.slice(index, index + 50);
      const response = await this.request(FREEBUSY_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          timeMin: input.startsAt.toISOString(),
          timeMax: input.endsAt.toISOString(),
          timeZone: "UTC",
          calendarExpansionMax: 50,
          items: emails.map((id) => ({ id })),
        }),
      });
      if (!response.ok) {
        throw new ProviderHttpError(
          "google",
          "calendar free/busy",
          response.status,
          (await response.text()).slice(0, 1_000),
        );
      }
      const body = (await response.json()) as {
        calendars: Record<
          string,
          { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }
        >;
      };
      for (const email of emails) {
        const calendar = body.calendars[email];
        if (!calendar || (calendar.errors?.length ?? 0) > 0) {
          throw new Error(
            `Google Calendar could not verify availability for ${email}.`,
          );
        }
        if ((calendar.busy?.length ?? 0) > 0) busy.add(email);
      }
    }

    return [...busy];
  }
}

function googleEventId(transactionId: string): string {
  return `hp${createHash("sha256").update(transactionId).digest("hex")}`;
}

const GOOGLE_MEET_POLL_DELAYS_MS = [200, 400, 800, 1_600, 2_000] as const;

type GoogleCalendarEvent = {
  id: string;
  status?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  extendedProperties?: {
    private?: { hotPotatoExternalId?: string; [key: string]: unknown };
  };
  attendees?: Array<{
    email?: string;
    displayName?: string;
    [key: string]: unknown;
  }>;
  conferenceData?: {
    createRequest?: { status?: { statusCode?: string } };
    entryPoints?: Array<{ entryPointType?: string; uri?: string }>;
  };
};

class GoogleMeetCreationFailedError extends Error {}
class GoogleAttendeeFinalizationError extends Error {}

function isPermanentProviderFailure(error: unknown): boolean {
  return (
    error instanceof ProviderHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 409, 425, 429].includes(error.status)
  );
}

function googleMeetUrl(event: GoogleCalendarEvent): string | null {
  return (
    event.hangoutLink ??
    event.conferenceData?.entryPoints?.find(
      (entryPoint) => entryPoint.entryPointType === "video",
    )?.uri ??
    null
  );
}

function verifiedGoogleUrl(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Google Calendar returned an invalid ${label}.`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Google Calendar returned an invalid ${label}.`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`Google Calendar returned an invalid ${label}.`);
  }
  return value;
}

function verifiedGoogleBookingEvent(
  event: GoogleCalendarEvent,
  input: CalendarEventLookupInput,
  options: {
    requireOwnershipMarker: boolean;
    expectedEventId?: string;
  },
): GoogleCalendarEvent {
  const expectedEventId =
    options.expectedEventId ?? googleEventId(input.transactionId);
  if (event.id !== expectedEventId) {
    throw new Error("Google Calendar returned the wrong booking event.");
  }
  const storedTransactionId =
    event.extendedProperties?.private?.hotPotatoExternalId;
  if (
    storedTransactionId !== undefined &&
    storedTransactionId !== input.transactionId
  ) {
    throw new Error(
      "Google Calendar returned conflicting booking ownership evidence.",
    );
  }
  if (options.requireOwnershipMarker && storedTransactionId === undefined) {
    throw new Error(
      "Google Calendar returned missing booking ownership evidence.",
    );
  }

  const startsAt = new Date(event.start?.dateTime ?? "");
  const endsAt = new Date(event.end?.dateTime ?? "");
  if (
    !Number.isFinite(startsAt.getTime()) ||
    !Number.isFinite(endsAt.getTime()) ||
    startsAt.getTime() !== input.startsAt.getTime() ||
    endsAt.getTime() !== input.endsAt.getTime()
  ) {
    throw new Error(
      "Google Calendar returned a booking event outside the reserved time.",
    );
  }
  if (event.status === "cancelled") {
    throw new Error("Google Calendar returned a cancelled booking event.");
  }
  if (event.status !== "confirmed" && event.status !== "tentative") {
    throw new Error("Google Calendar returned an invalid booking status.");
  }
  verifiedGoogleUrl(event.htmlLink, "booking event link");
  verifiedGoogleUrl(googleMeetUrl(event), "conference link");
  return event;
}

async function googleJson<T>(
  response: Response,
  operation: string,
): Promise<T> {
  if (!response.ok) {
    throw new ProviderHttpError(
      "google",
      operation,
      response.status,
      (await response.text()).slice(0, 1_000),
    );
  }
  return (await response.json()) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validProviderString(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`Google Calendar returned an invalid ${label}.`);
  }
  return value;
}

function selectedCalendarIds(calendarIds?: string[]): string[] {
  if (calendarIds === undefined) return [GOOGLE_PRIMARY_CALENDAR_ID];
  if (!Array.isArray(calendarIds) || calendarIds.length === 0) {
    throw new Error("Choose at least one Google calendar to check.");
  }

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const value of calendarIds) {
    const id = validProviderString(
      value,
      "calendar identifier",
      GOOGLE_CALENDAR_ID_MAX_LENGTH,
    );
    if (seen.has(id)) continue;
    seen.add(id);
    selected.push(id);
    if (selected.length > 50) {
      throw new Error("Choose no more than 50 Google calendars to check.");
    }
  }
  return selected;
}

function calendarListPage(value: unknown): {
  items: Record<string, unknown>[];
  nextPageToken?: string;
} {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error("Google Calendar returned an invalid calendar list.");
  }
  const items = value.items.map((item) => {
    if (!isRecord(item)) {
      throw new Error("Google Calendar returned an invalid calendar entry.");
    }
    return item;
  });
  if (value.nextPageToken === undefined) return { items };
  return {
    items,
    nextPageToken: validProviderString(
      value.nextPageToken,
      "calendar-list page token",
      GOOGLE_PAGE_TOKEN_MAX_LENGTH,
    ),
  };
}

function connectedCalendar(entry: Record<string, unknown>): {
  providerId: string;
  calendar: ConnectedCalendar;
} {
  const providerId = validProviderString(
    entry.id,
    "calendar identifier",
    GOOGLE_CALENDAR_ID_MAX_LENGTH,
  );
  const summary = validProviderString(
    entry.summary,
    "calendar name",
    GOOGLE_CALENDAR_NAME_MAX_LENGTH,
  );
  const name =
    typeof entry.summaryOverride === "string" &&
    entry.summaryOverride.trim().length > 0
      ? validProviderString(
          entry.summaryOverride,
          "calendar name",
          GOOGLE_CALENDAR_NAME_MAX_LENGTH,
        )
      : summary;
  if (entry.primary !== undefined && typeof entry.primary !== "boolean") {
    throw new Error(
      "Google Calendar returned an invalid primary calendar flag.",
    );
  }
  const isDefault = entry.primary === true;
  return {
    providerId,
    calendar: {
      id: isDefault ? GOOGLE_PRIMARY_CALENDAR_ID : providerId,
      name,
      isDefault,
    },
  };
}

export class GoogleRepCalendarAdapter implements CalendarAdapter {
  readonly key = "google-rep";

  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly request: typeof fetch = fetch,
    private readonly wait: (milliseconds: number) => Promise<void> = (
      milliseconds,
    ) =>
      new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
      }),
  ) {}

  async listCalendars(
    input: { signal?: AbortSignal } = {},
  ): Promise<ConnectedCalendar[]> {
    input.signal?.throwIfAborted();
    const accessToken = await this.getAccessToken();
    input.signal?.throwIfAborted();
    const calendars = new Map<string, ConnectedCalendar>();
    const providerCalendarDefaults = new Map<string, boolean>();
    const primaryProviderIds = new Set<string>();
    const requestedPageTokens = new Set<string>();
    let pageToken: string | undefined;

    for (let page = 0; page < GOOGLE_CALENDAR_LIST_MAX_PAGES; page += 1) {
      input.signal?.throwIfAborted();
      if (pageToken) {
        if (requestedPageTokens.has(pageToken)) {
          throw new Error(
            "Google Calendar repeated a calendar-list page token.",
          );
        }
        requestedPageTokens.add(pageToken);
      }
      const url = new URL(CALENDAR_LIST_URL);
      url.searchParams.set("maxResults", "250");
      url.searchParams.set("minAccessRole", "freeBusyReader");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const response = await this.request(url, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: input.signal,
      });
      const body = calendarListPage(
        await googleJson<unknown>(response, "calendar list discovery"),
      );
      for (const entry of body.items) {
        const discovered = connectedCalendar(entry);
        const knownDefault = providerCalendarDefaults.get(
          discovered.providerId,
        );
        if (knownDefault !== undefined) {
          if (knownDefault !== discovered.calendar.isDefault) {
            throw new Error(
              "Google Calendar returned conflicting calendar entries.",
            );
          }
          continue;
        }
        providerCalendarDefaults.set(
          discovered.providerId,
          discovered.calendar.isDefault,
        );
        if (discovered.calendar.isDefault) {
          primaryProviderIds.add(discovered.providerId);
        }
        const existing = calendars.get(discovered.calendar.id);
        if (existing) {
          if (existing.isDefault !== discovered.calendar.isDefault) {
            throw new Error(
              "Google Calendar returned conflicting calendar entries.",
            );
          }
          continue;
        }
        calendars.set(discovered.calendar.id, discovered.calendar);
      }

      if (!body.nextPageToken) break;
      if (requestedPageTokens.has(body.nextPageToken)) {
        throw new Error("Google Calendar repeated a calendar-list page token.");
      }
      if (page === GOOGLE_CALENDAR_LIST_MAX_PAGES - 1) {
        throw new Error(
          "Google Calendar returned too many calendar-list pages.",
        );
      }
      pageToken = body.nextPageToken;
    }

    const primary = calendars.get(GOOGLE_PRIMARY_CALENDAR_ID);
    if (
      primaryProviderIds.size !== 1 ||
      !primary ||
      !primary.isDefault ||
      [...calendars.values()].filter((calendar) => calendar.isDefault)
        .length !== 1
    ) {
      throw new Error(
        "Google Calendar must return exactly one primary calendar.",
      );
    }
    return [
      primary,
      ...[...calendars.values()].filter(
        (calendar) => calendar.id !== GOOGLE_PRIMARY_CALENDAR_ID,
      ),
    ];
  }

  private async eventWithRequiredGoogleMeet(
    initialEvent: GoogleCalendarEvent,
    externalEventId: string,
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<GoogleCalendarEvent> {
    let event = initialEvent;
    for (const delay of GOOGLE_MEET_POLL_DELAYS_MS) {
      signal?.throwIfAborted();
      if (googleMeetUrl(event)) return event;
      if (
        event.conferenceData?.createRequest?.status?.statusCode === "failure"
      ) {
        throw new GoogleMeetCreationFailedError(
          "Google Calendar could not create the Google Meet room.",
        );
      }
      await this.wait(delay);
      signal?.throwIfAborted();
      event = await googleJson<GoogleCalendarEvent>(
        await this.request(
          `${PRIMARY_EVENTS_URL}/${encodeURIComponent(externalEventId)}`,
          {
            headers: { authorization: `Bearer ${accessToken}` },
            signal,
          },
        ),
        "Google Meet conference lookup",
      );
    }

    const conferenceUrl = googleMeetUrl(event);
    if (conferenceUrl) return event;
    if (event.conferenceData?.createRequest?.status?.statusCode === "failure") {
      throw new GoogleMeetCreationFailedError(
        "Google Calendar could not create the Google Meet room.",
      );
    }
    throw new Error(
      "Google Calendar did not finish creating the Google Meet room.",
    );
  }

  private async ensureAttendees(
    event: GoogleCalendarEvent,
    externalEventId: string,
    input: CalendarEventInput,
    accessToken: string,
  ): Promise<GoogleCalendarEvent> {
    input.signal?.throwIfAborted();
    const intended = calendarEventAttendees(input);
    if (intended.length === 0) return event;
    const existingEmails = new Set(
      (event.attendees ?? [])
        .map((attendee) => attendee.email?.trim().toLowerCase())
        .filter((email): email is string => Boolean(email)),
    );
    const missing = intended.filter(
      (attendee) => !existingEmails.has(attendee.email),
    );
    if (missing.length === 0) return event;

    const response = await this.request(
      `${PRIMARY_EVENTS_URL}/${encodeURIComponent(externalEventId)}?sendUpdates=all&conferenceDataVersion=1`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          attendees: [
            ...(event.attendees ?? []),
            ...missing.map((attendee) => ({
              email: attendee.email,
              ...(attendee.name ? { displayName: attendee.name } : {}),
            })),
          ],
        }),
        signal: input.signal,
      },
    );
    const updated = await googleJson<GoogleCalendarEvent>(
      response,
      "calendar attendee invitation",
    );
    const merged = {
      ...event,
      ...updated,
      hangoutLink: updated.hangoutLink ?? event.hangoutLink,
      conferenceData: updated.conferenceData ?? event.conferenceData,
    };
    const confirmedEmails = new Set(
      (merged.attendees ?? [])
        .map((attendee) => attendee.email?.trim().toLowerCase())
        .filter((email): email is string => Boolean(email)),
    );
    if (intended.some((attendee) => !confirmedEmails.has(attendee.email))) {
      throw new GoogleAttendeeFinalizationError(
        "Google Calendar did not confirm every attendee invitation.",
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
        `${PRIMARY_EVENTS_URL}/${encodeURIComponent(externalEventId)}?sendUpdates=all`,
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
      throw new Error("Google calendar availability range is invalid.");
    }
    const calendarIds = selectedCalendarIds(input.calendarIds);
    input.signal?.throwIfAborted();
    const accessToken = await this.getAccessToken();
    input.signal?.throwIfAborted();
    const response = await this.request(FREEBUSY_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        timeMin: input.startsAt.toISOString(),
        timeMax: input.endsAt.toISOString(),
        timeZone: "UTC",
        calendarExpansionMax: 50,
        items: calendarIds.map((id) => ({ id })),
      }),
      signal: input.signal,
    });
    const body = await googleJson<unknown>(
      response,
      "representative calendar availability",
    );
    if (!isRecord(body) || !isRecord(body.calendars)) {
      throw new Error("Google Calendar could not verify availability.");
    }

    const intervals = new Map<string, { startsAt: Date; endsAt: Date }>();
    for (const calendarId of calendarIds) {
      if (!Object.prototype.hasOwnProperty.call(body.calendars, calendarId)) {
        throw new Error("Google Calendar could not verify availability.");
      }
      const calendar = body.calendars[calendarId];
      if (!isRecord(calendar)) {
        throw new Error("Google Calendar could not verify availability.");
      }
      if (
        calendar.errors !== undefined &&
        (!Array.isArray(calendar.errors) || calendar.errors.length > 0)
      ) {
        throw new Error("Google Calendar could not verify availability.");
      }
      if (calendar.busy !== undefined && !Array.isArray(calendar.busy)) {
        throw new Error("Google Calendar could not verify availability.");
      }
      for (const value of calendar.busy ?? []) {
        if (!isRecord(value)) {
          throw new Error("Google Calendar could not verify availability.");
        }
        const startsAt = new Date(String(value.start ?? ""));
        const endsAt = new Date(String(value.end ?? ""));
        if (
          !Number.isFinite(startsAt.getTime()) ||
          !Number.isFinite(endsAt.getTime()) ||
          endsAt <= startsAt
        ) {
          throw new Error("Google Calendar could not verify availability.");
        }
        intervals.set(`${startsAt.toISOString()}:${endsAt.toISOString()}`, {
          startsAt,
          endsAt,
        });
      }
    }
    return [...intervals.values()].sort(
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
      throw new Error("Google calendar event lookup input is invalid.");
    }

    input.signal?.throwIfAborted();
    const accessToken = await this.getAccessToken();
    input.signal?.throwIfAborted();
    const eventId = googleEventId(input.transactionId);
    const url = new URL(`${PRIMARY_EVENTS_URL}/${encodeURIComponent(eventId)}`);
    url.searchParams.set(
      "fields",
      "id,status,htmlLink,hangoutLink,conferenceData,extendedProperties,start,end",
    );
    const response = await this.request(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: input.signal,
    });
    if (response.status === 404 || response.status === 410) return null;
    const event = await googleJson<GoogleCalendarEvent>(
      response,
      "booking event reconciliation",
    );
    if (event.id !== eventId) {
      throw new Error("Google Calendar returned the wrong booking event.");
    }
    const storedTransactionId =
      event.extendedProperties?.private?.hotPotatoExternalId;
    if (
      storedTransactionId !== undefined &&
      storedTransactionId !== input.transactionId
    ) {
      throw new Error(
        "Google Calendar returned conflicting booking ownership evidence.",
      );
    }
    if (event.status === "cancelled") return null;
    verifiedGoogleBookingEvent(event, input, {
      requireOwnershipMarker: false,
    });
    return {
      externalEventId: event.id,
      webLink: event.htmlLink ?? null,
      conferenceUrl: googleMeetUrl(event),
    };
  }

  async createEvent(input: CalendarEventInput): Promise<CalendarEventResult> {
    input.signal?.throwIfAborted();
    const accessToken = await this.getAccessToken();
    input.signal?.throwIfAborted();
    const eventId = googleEventId(input.transactionId);
    const createMeet = input.conferenceProvider === "google_meet";
    const attendees = calendarEventAttendees(input);
    const response = await this.request(
      `${PRIMARY_EVENTS_URL}?sendUpdates=all&conferenceDataVersion=1`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          id: eventId,
          summary: input.subject,
          description: input.description,
          ...(input.conferenceProvider === "zoom" && input.conferenceUrl
            ? { location: input.conferenceUrl }
            : {}),
          start: { dateTime: input.startsAt.toISOString(), timeZone: "UTC" },
          end: { dateTime: input.endsAt.toISOString(), timeZone: "UTC" },
          attendees: createMeet
            ? []
            : attendees.map((attendee) => ({
                email: attendee.email,
                ...(attendee.name ? { displayName: attendee.name } : {}),
              })),
          extendedProperties: {
            private: { hotPotatoExternalId: input.transactionId },
          },
          ...(createMeet
            ? {
                conferenceData: {
                  createRequest: {
                    requestId: input.transactionId,
                    conferenceSolutionKey: { type: "hangoutsMeet" },
                  },
                },
              }
            : {}),
        }),
        signal: input.signal,
      },
    );

    let event: GoogleCalendarEvent;
    if (response.status === 409) {
      const existingEventUrl = new URL(
        `${PRIMARY_EVENTS_URL}/${encodeURIComponent(eventId)}`,
      );
      existingEventUrl.searchParams.set(
        "fields",
        "id,status,htmlLink,hangoutLink,conferenceData,extendedProperties,start,end,attendees",
      );
      event = await googleJson<GoogleCalendarEvent>(
        await this.request(existingEventUrl, {
          headers: { authorization: `Bearer ${accessToken}` },
          signal: input.signal,
        }),
        "existing calendar event lookup",
      );
    } else {
      event = await googleJson<GoogleCalendarEvent>(
        response,
        "calendar event creation",
      );
    }
    verifiedGoogleBookingEvent(event, input, {
      requireOwnershipMarker: true,
    });
    try {
      if (createMeet) {
        event = await this.eventWithRequiredGoogleMeet(
          event,
          eventId,
          accessToken,
          input.signal,
        );
      }
      event = await this.ensureAttendees(event, eventId, input, accessToken);
    } catch (error) {
      if (
        error instanceof GoogleMeetCreationFailedError ||
        error instanceof GoogleAttendeeFinalizationError ||
        isPermanentProviderFailure(error)
      ) {
        await this.bestEffortDeleteEvent(eventId, accessToken, input.signal);
      }
      throw error;
    }
    verifiedGoogleBookingEvent(event, input, {
      requireOwnershipMarker: true,
    });
    return {
      externalEventId: event.id,
      webLink: event.htmlLink ?? null,
      conferenceUrl: googleMeetUrl(event) ?? input.conferenceUrl ?? null,
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
      `${PRIMARY_EVENTS_URL}/${encodeURIComponent(externalEventId)}?sendUpdates=all&conferenceDataVersion=1`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          start: { dateTime: input.startsAt.toISOString(), timeZone: "UTC" },
          end: { dateTime: input.endsAt.toISOString(), timeZone: "UTC" },
        }),
        signal: input.signal,
      },
    );
    let event = await googleJson<GoogleCalendarEvent>(
      response,
      "calendar event update",
    );
    verifiedGoogleBookingEvent(event, input, {
      requireOwnershipMarker: true,
      expectedEventId: externalEventId,
    });
    if (input.conferenceProvider === "google_meet") {
      event = await this.eventWithRequiredGoogleMeet(
        event,
        externalEventId,
        accessToken,
        input.signal,
      );
    }
    verifiedGoogleBookingEvent(event, input, {
      requireOwnershipMarker: true,
      expectedEventId: externalEventId,
    });
    return {
      externalEventId: event.id,
      webLink: event.htmlLink ?? null,
      conferenceUrl: googleMeetUrl(event) ?? input.conferenceUrl ?? null,
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
      `${PRIMARY_EVENTS_URL}/${encodeURIComponent(externalEventId)}?sendUpdates=all`,
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
      "google",
      "calendar event cancellation",
      response.status,
      (await response.text()).slice(0, 1_000),
    );
  }
}
