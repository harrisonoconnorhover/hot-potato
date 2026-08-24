import type { OAuthProviderClient, OAuthTokenSet } from "./oauth.js";
import type {
  CrmAdapter,
  CrmOwnerWriteback,
  CrmWritebackResult,
} from "./types.js";

const AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize";
const TOKEN_URL = "https://api.hubapi.com/oauth/v3/token";
const API_URL = "https://api.hubapi.com";
const DEFAULT_SCOPES = [
  "oauth",
  "crm.objects.contacts.write",
  "crm.objects.owners.read",
];

type HubSpotTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scopes?: string[];
  hub_id?: number;
};

type HubSpotOwner = {
  id: string;
  email: string;
  archived: boolean;
};

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: "hubspot" | "google",
    readonly operation: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`${provider} ${operation} failed with HTTP ${status}.`);
    this.name = "ProviderHttpError";
  }
}

async function responseJson<T>(
  response: Response,
  provider: "hubspot" | "google",
  operation: string,
): Promise<T> {
  if (!response.ok) {
    const body = (await response.text()).slice(0, 1_000);
    throw new ProviderHttpError(provider, operation, response.status, body);
  }
  return (await response.json()) as T;
}

export class HubSpotOAuthClient implements OAuthProviderClient {
  readonly provider = "hubspot" as const;

  constructor(
    private readonly config: {
      clientId: string;
      clientSecret: string;
      scopes?: string[];
    },
    private readonly request: typeof fetch = fetch,
  ) {}

  authorizationUrl(input: { state: string; redirectUri: string }): string {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set(
      "scope",
      (this.config.scopes ?? DEFAULT_SCOPES).join(" "),
    );
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("state", input.state);
    return url.toString();
  }

  async exchangeCode(input: {
    code: string;
    redirectUri: string;
  }): Promise<OAuthTokenSet> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: input.redirectUri,
      code: input.code,
    });
  }

  async refresh(refreshToken: string): Promise<OAuthTokenSet> {
    return this.tokenRequest({
      grant_type: "refresh_token",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: refreshToken,
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
    const body = await responseJson<HubSpotTokenResponse>(
      response,
      "hubspot",
      "OAuth token exchange",
    );
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: new Date(Date.now() + body.expires_in * 1_000),
      scopes: body.scopes ?? this.config.scopes ?? DEFAULT_SCOPES,
      externalAccountId: body.hub_id ? String(body.hub_id) : undefined,
      externalAccountName: body.hub_id
        ? `HubSpot account ${body.hub_id}`
        : undefined,
      metadata: body.hub_id ? { hubId: body.hub_id } : {},
    };
  }
}

export class HubSpotOwnerNotFoundError extends Error {
  constructor(email: string) {
    super(`No active HubSpot owner matches ${email}.`);
    this.name = "HubSpotOwnerNotFoundError";
  }
}

export class HubSpotCrmAdapter implements CrmAdapter {
  readonly key = "hubspot";

  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly request: typeof fetch = fetch,
  ) {}

  async writeOwner(input: CrmOwnerWriteback): Promise<CrmWritebackResult> {
    const accessToken = await this.getAccessToken();
    const owner = await this.findOwner(accessToken, input.ownerEmail);
    const url = new URL(
      `/crm/objects/2026-03/contacts/${encodeURIComponent(input.leadEmail)}`,
      API_URL,
    );
    url.searchParams.set("idProperty", "email");

    const response = await this.request(url, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ properties: { hubspot_owner_id: owner.id } }),
    });
    await responseJson<Record<string, unknown>>(
      response,
      "hubspot",
      "contact owner writeback",
    );
    return {
      externalReference: `hubspot:contact:${input.leadEmail}:owner:${owner.id}`,
    };
  }

  private async findOwner(
    accessToken: string,
    email: string,
  ): Promise<HubSpotOwner> {
    let after: string | undefined;
    do {
      const url = new URL("/crm/v3/owners", API_URL);
      url.searchParams.set("archived", "false");
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("after", after);

      const response = await this.request(url, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const body = await responseJson<{
        results: HubSpotOwner[];
        paging?: { next?: { after?: string } };
      }>(response, "hubspot", "owner lookup");
      const owner = body.results.find(
        (candidate) =>
          !candidate.archived &&
          candidate.email.toLocaleLowerCase() === email.toLocaleLowerCase(),
      );
      if (owner) return owner;
      after = body.paging?.next?.after;
    } while (after);

    throw new HubSpotOwnerNotFoundError(email);
  }
}
