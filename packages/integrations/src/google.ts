import { OAuth2Client } from "google-auth-library";
import { ProviderHttpError } from "./hubspot.js";
import type { OAuthProviderClient, OAuthTokenSet } from "./oauth.js";
import type { AvailabilityQuery, CalendarAdapter } from "./types.js";

const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.freebusy",
];

export class GoogleOAuthClient implements OAuthProviderClient {
  readonly provider = "google" as const;

  constructor(
    private readonly config: { clientId: string; clientSecret: string },
  ) {}

  authorizationUrl(input: { state: string; redirectUri: string }): string {
    return this.client(input.redirectUri).generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      scope: GOOGLE_SCOPES,
      state: input.state,
    });
  }

  async exchangeCode(input: {
    code: string;
    redirectUri: string;
  }): Promise<OAuthTokenSet> {
    const client = this.client(input.redirectUri);
    const { tokens } = await client.getToken({
      code: input.code,
      redirect_uri: input.redirectUri,
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
      scopes: tokens.scope?.split(" ").filter(Boolean) ?? GOOGLE_SCOPES,
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
