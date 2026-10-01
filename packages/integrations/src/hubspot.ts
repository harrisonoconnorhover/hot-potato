import type { OAuthProviderClient, OAuthTokenSet } from "./oauth.js";
import type {
  CrmAdapter,
  CrmOwnerWriteback,
  CrmRoleWriteback,
  CrmWritebackResult,
} from "./types.js";

const AUTHORIZE_URL = "https://app.hubspot.com/oauth/authorize";
const TOKEN_URL = "https://api.hubapi.com/oauth/v3/token";
const API_URL = "https://api.hubapi.com";
const DEFAULT_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.owners.read",
];

export const HUBSPOT_CONTACT_READ_SCOPE = "crm.objects.contacts.read";
export const HUBSPOT_OWNER_READ_SCOPE = "crm.objects.owners.read";

type HubSpotTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scopes?: string[];
  hub_id?: number;
};

type HubSpotOwner = {
  id: string;
  email?: string | null;
  archived: boolean;
  type?: string;
};

function jsonObject(
  value: unknown,
  operation: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`HubSpot ${operation} returned an invalid response.`);
  }
  return value as Record<string, unknown>;
}

function normalizedEmail(value: string, operation: string): string {
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new Error(`HubSpot ${operation} received an invalid email address.`);
  }
  return email;
}

function normalizedRoleOwners(input: CrmRoleWriteback) {
  if (input.roleOwners.length < 1 || input.roleOwners.length > 5) {
    throw new Error("HubSpot role writeback requires 1–5 owner mappings.");
  }
  const properties = new Set<string>();
  return input.roleOwners.map((role) => {
    const propertyName = role.propertyName.trim();
    if (
      !/^[a-z][a-z0-9_]{0,99}$/.test(propertyName) ||
      propertyName === "hubspot_owner_id"
    ) {
      throw new Error(
        "HubSpot role writeback received an invalid owner property.",
      );
    }
    if (properties.has(propertyName)) {
      throw new Error(
        "HubSpot role writeback received a duplicate owner property.",
      );
    }
    properties.add(propertyName);
    return {
      propertyName,
      ownerEmail: normalizedEmail(role.ownerEmail, "role writeback"),
    };
  });
}

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: "hubspot" | "google" | "microsoft",
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
  provider: "hubspot" | "google" | "microsoft",
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

export class HubSpotRolePropertyError extends Error {
  constructor(propertyName: string) {
    super(
      `HubSpot property ${propertyName} is not a writable contact user property.`,
    );
    this.name = "HubSpotRolePropertyError";
  }
}

export class HubSpotCrmAdapter implements CrmAdapter {
  readonly key = "hubspot";

  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly request: typeof fetch = fetch,
  ) {}

  async writeOwner(input: CrmOwnerWriteback): Promise<CrmWritebackResult> {
    input.signal?.throwIfAborted();
    const accessToken = await this.getAccessToken();
    input.signal?.throwIfAborted();
    const owner = await this.findOwner(
      accessToken,
      input.ownerEmail,
      input.signal,
    );
    input.signal?.throwIfAborted();
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
      signal: input.signal,
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

  async writeRoles(input: CrmRoleWriteback): Promise<CrmWritebackResult> {
    input.signal?.throwIfAborted();
    const leadEmail = normalizedEmail(input.leadEmail, "role writeback");
    const roles = normalizedRoleOwners(input);
    const accessToken = await this.getAccessToken();
    input.signal?.throwIfAborted();
    for (const role of roles) {
      await this.validateRoleProperty(
        accessToken,
        role.propertyName,
        input.signal,
      );
    }
    const owners = await this.findOwners(
      accessToken,
      roles.map((role) => role.ownerEmail),
      input.signal,
    );
    input.signal?.throwIfAborted();
    const url = new URL(
      `/crm/objects/2026-03/contacts/${encodeURIComponent(leadEmail)}`,
      API_URL,
    );
    url.searchParams.set("idProperty", "email");
    const properties = Object.fromEntries(
      roles.map((role) => [role.propertyName, owners.get(role.ownerEmail)!.id]),
    );
    const response = await this.request(url, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ properties }),
      signal: input.signal,
    });
    await responseJson<Record<string, unknown>>(
      response,
      "hubspot",
      "contact role writeback",
    );
    return {
      externalReference: `hubspot:contact:${leadEmail}:roles:${roles.length}`,
    };
  }

  async ownerEmailForContact(
    contactEmail: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    signal?.throwIfAborted();
    const normalizedContactEmail = normalizedEmail(
      contactEmail,
      "contact owner lookup",
    );
    const accessToken = await this.getAccessToken();
    signal?.throwIfAborted();
    const contactUrl = new URL(
      `/crm/objects/2026-03/contacts/${encodeURIComponent(normalizedContactEmail)}`,
      API_URL,
    );
    contactUrl.searchParams.set("idProperty", "email");
    contactUrl.searchParams.set("properties", "hubspot_owner_id");
    contactUrl.searchParams.set("archived", "false");
    const contactResponse = await this.request(contactUrl, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal,
    });
    if (contactResponse.status === 404) return null;
    const contact = jsonObject(
      await responseJson<unknown>(
        contactResponse,
        "hubspot",
        "contact owner lookup",
      ),
      "contact owner lookup",
    );
    const properties = jsonObject(contact.properties, "contact owner lookup");
    const rawOwnerId = properties.hubspot_owner_id;
    if (rawOwnerId === null || rawOwnerId === undefined || rawOwnerId === "") {
      return null;
    }
    if (typeof rawOwnerId !== "string") {
      throw new Error(
        "HubSpot contact owner lookup returned an invalid owner ID.",
      );
    }
    const ownerId = rawOwnerId.trim();
    if (!ownerId || /[\u0000-\u001f\u007f]/.test(ownerId)) {
      throw new Error(
        "HubSpot contact owner lookup returned an invalid owner ID.",
      );
    }

    signal?.throwIfAborted();
    const ownerUrl = new URL(
      `/crm/owners/2026-03/${encodeURIComponent(ownerId)}`,
      API_URL,
    );
    ownerUrl.searchParams.set("idProperty", "id");
    ownerUrl.searchParams.set("archived", "false");
    const ownerResponse = await this.request(ownerUrl, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal,
    });
    if (ownerResponse.status === 404) return null;
    const owner = jsonObject(
      await responseJson<unknown>(
        ownerResponse,
        "hubspot",
        "contact owner resolution",
      ),
      "contact owner resolution",
    );
    if (String(owner.id ?? "") !== ownerId) {
      throw new Error(
        "HubSpot contact owner resolution returned a different owner.",
      );
    }
    if (
      owner.archived === true ||
      owner.type === "QUEUE" ||
      owner.email === null ||
      owner.email === undefined ||
      owner.email === ""
    ) {
      return null;
    }
    if (owner.archived !== false || typeof owner.email !== "string") {
      throw new Error(
        "HubSpot contact owner resolution returned an invalid owner.",
      );
    }
    return normalizedEmail(owner.email, "contact owner resolution");
  }

  private async findOwner(
    accessToken: string,
    email: string,
    signal?: AbortSignal,
  ): Promise<HubSpotOwner> {
    const normalized = normalizedEmail(email, "owner lookup");
    return (await this.findOwners(accessToken, [normalized], signal)).get(
      normalized,
    )!;
  }

  private async validateRoleProperty(
    accessToken: string,
    propertyName: string,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const url = new URL(
      `/crm/properties/2026-03/contacts/${encodeURIComponent(propertyName)}`,
      API_URL,
    );
    url.searchParams.set("archived", "false");
    const response = await this.request(url, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal,
    });
    if (response.status === 404) {
      throw new HubSpotRolePropertyError(propertyName);
    }
    const property = jsonObject(
      await responseJson<unknown>(
        response,
        "hubspot",
        "contact role property lookup",
      ),
      "contact role property lookup",
    );
    const modificationMetadata = jsonObject(
      property.modificationMetadata,
      "contact role property lookup",
    );
    if (
      property.name !== propertyName ||
      property.archived !== false ||
      property.externalOptions !== true ||
      property.referencedObjectType !== "OWNER" ||
      modificationMetadata.readOnlyValue === true
    ) {
      throw new HubSpotRolePropertyError(propertyName);
    }
  }

  private async findOwners(
    accessToken: string,
    emails: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, HubSpotOwner>> {
    const expected = new Set(
      emails.map((email) => normalizedEmail(email, "owner lookup")),
    );
    const owners = new Map<string, HubSpotOwner>();
    let after: string | undefined;
    do {
      signal?.throwIfAborted();
      const url = new URL("/crm/owners/2026-03", API_URL);
      url.searchParams.set("archived", "false");
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("after", after);

      const response = await this.request(url, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal,
      });
      const body = await responseJson<{
        results: HubSpotOwner[];
        paging?: { next?: { after?: string } };
      }>(response, "hubspot", "owner lookup");
      for (const candidate of body.results) {
        if (
          candidate.archived !== false ||
          candidate.type === "QUEUE" ||
          typeof candidate.email !== "string"
        ) {
          continue;
        }
        const email = candidate.email.trim().toLowerCase();
        if (expected.has(email)) owners.set(email, candidate);
      }
      if (owners.size === expected.size) return owners;
      after = body.paging?.next?.after;
    } while (after);

    const missing = [...expected].find((email) => !owners.has(email))!;
    throw new HubSpotOwnerNotFoundError(missing);
  }
}
