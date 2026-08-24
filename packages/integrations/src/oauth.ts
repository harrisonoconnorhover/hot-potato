import type { TokenCipher } from "./token-cipher.js";

export type OAuthProvider = "hubspot" | "google";

export type OAuthTokenSet = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scopes: string[];
  externalAccountId?: string;
  externalAccountName?: string;
  metadata?: Record<string, unknown>;
};

export type StoredOAuthConnection = {
  organizationSlug: string;
  provider: OAuthProvider;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  expiresAt: Date;
  scopes: string[];
  externalAccountId: string | null;
  externalAccountName: string | null;
  metadata: Record<string, unknown>;
  updatedAt: Date;
};

export type SaveStoredOAuthConnection = Omit<
  StoredOAuthConnection,
  "updatedAt"
>;

export interface OAuthConnectionStore {
  getOAuthConnection(
    organizationSlug: string,
    provider: OAuthProvider,
  ): Promise<StoredOAuthConnection | null>;
  saveOAuthConnection(connection: SaveStoredOAuthConnection): Promise<void>;
}

export interface OAuthProviderClient {
  readonly provider: OAuthProvider;
  authorizationUrl(input: { state: string; redirectUri: string }): string;
  exchangeCode(input: {
    code: string;
    redirectUri: string;
  }): Promise<OAuthTokenSet>;
  refresh(refreshToken: string): Promise<OAuthTokenSet>;
}

export class OAuthConnectionMissingError extends Error {
  constructor(provider: OAuthProvider) {
    super(`${provider} is not connected.`);
    this.name = "OAuthConnectionMissingError";
  }
}

export class ConnectionTokenManager {
  private readonly refreshes = new Map<string, Promise<string>>();

  constructor(
    private readonly store: OAuthConnectionStore,
    private readonly cipher: TokenCipher,
    private readonly clients: Map<OAuthProvider, OAuthProviderClient>,
  ) {}

  authorizationUrl(
    provider: OAuthProvider,
    input: { state: string; redirectUri: string },
  ): string {
    return this.client(provider).authorizationUrl(input);
  }

  async connect(
    organizationSlug: string,
    provider: OAuthProvider,
    input: { code: string; redirectUri: string },
  ): Promise<void> {
    const tokens = await this.client(provider).exchangeCode(input);
    if (!tokens.refreshToken) {
      throw new Error(`${provider} did not return a refresh token.`);
    }
    await this.save(organizationSlug, provider, tokens, tokens.refreshToken);
  }

  async accessToken(
    organizationSlug: string,
    provider: OAuthProvider,
  ): Promise<string> {
    const connection = await this.store.getOAuthConnection(
      organizationSlug,
      provider,
    );
    if (!connection) throw new OAuthConnectionMissingError(provider);

    if (connection.expiresAt.getTime() > Date.now() + 60_000) {
      return this.cipher.decrypt(connection.encryptedAccessToken);
    }

    const key = `${organizationSlug}:${provider}`;
    const existing = this.refreshes.get(key);
    if (existing) return existing;

    const refresh = this.refresh(connection).finally(() => {
      this.refreshes.delete(key);
    });
    this.refreshes.set(key, refresh);
    return refresh;
  }

  private async refresh(connection: StoredOAuthConnection): Promise<string> {
    const currentRefreshToken = this.cipher.decrypt(
      connection.encryptedRefreshToken,
    );
    const tokens = await this.client(connection.provider).refresh(
      currentRefreshToken,
    );
    await this.save(
      connection.organizationSlug,
      connection.provider,
      {
        ...tokens,
        scopes: tokens.scopes.length > 0 ? tokens.scopes : connection.scopes,
        externalAccountId:
          tokens.externalAccountId ?? connection.externalAccountId ?? undefined,
        externalAccountName:
          tokens.externalAccountName ??
          connection.externalAccountName ??
          undefined,
        metadata: { ...connection.metadata, ...tokens.metadata },
      },
      tokens.refreshToken ?? currentRefreshToken,
    );
    return tokens.accessToken;
  }

  private async save(
    organizationSlug: string,
    provider: OAuthProvider,
    tokens: OAuthTokenSet,
    refreshToken: string,
  ): Promise<void> {
    await this.store.saveOAuthConnection({
      organizationSlug,
      provider,
      encryptedAccessToken: this.cipher.encrypt(tokens.accessToken),
      encryptedRefreshToken: this.cipher.encrypt(refreshToken),
      expiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      externalAccountId: tokens.externalAccountId ?? null,
      externalAccountName: tokens.externalAccountName ?? null,
      metadata: tokens.metadata ?? {},
    });
  }

  private client(provider: OAuthProvider): OAuthProviderClient {
    const client = this.clients.get(provider);
    if (!client) throw new Error(`${provider} OAuth is not configured.`);
    return client;
  }
}
