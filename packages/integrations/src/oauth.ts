import type { TokenCipher } from "./token-cipher.js";

export type OAuthProvider = "hubspot" | "google" | "microsoft";
export type CalendarOAuthProvider = Exclude<OAuthProvider, "hubspot">;

export type OAuthAuthorizationInput = {
  state: string;
  redirectUri: string;
  codeChallenge?: string;
};

export type OAuthCodeInput = {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
};

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

export type StoredRepCalendarConnection = {
  organizationSlug: string;
  repId: string;
  provider: CalendarOAuthProvider;
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  expiresAt: Date;
  scopes: string[];
  externalAccountId: string | null;
  externalAccountName: string | null;
  metadata: Record<string, unknown>;
  updatedAt: Date;
};

export type SaveStoredRepCalendarConnection = Omit<
  StoredRepCalendarConnection,
  "updatedAt"
>;

export interface OAuthConnectionStore {
  getOAuthConnection(
    organizationSlug: string,
    provider: OAuthProvider,
  ): Promise<StoredOAuthConnection | null>;
  saveOAuthConnection(
    connection: SaveStoredOAuthConnection,
    options?: {
      expectedExternalAccountId?: string | null;
      expectedEncryptedRefreshToken?: string;
    },
  ): Promise<void>;
}

export interface RepCalendarConnectionStore {
  getRepCalendarConnection(
    organizationSlug: string,
    repId: string,
    provider: CalendarOAuthProvider,
  ): Promise<StoredRepCalendarConnection | null>;
  getActiveRepCalendarProvider(
    organizationSlug: string,
    repId: string,
  ): Promise<CalendarOAuthProvider | null>;
  saveRepCalendarConnection(
    connection: SaveStoredRepCalendarConnection,
    options?: {
      preserveCalendarSources?: boolean;
      expectedExternalAccountId?: string | null;
      expectedEncryptedRefreshToken?: string;
    },
  ): Promise<void>;
  setActiveRepCalendarProvider(
    organizationSlug: string,
    repId: string,
    provider: CalendarOAuthProvider,
  ): Promise<void>;
}

export interface OAuthProviderClient {
  readonly provider: OAuthProvider;
  authorizationUrl(input: OAuthAuthorizationInput): string;
  exchangeCode(input: OAuthCodeInput): Promise<OAuthTokenSet>;
  refresh(refreshToken: string): Promise<OAuthTokenSet>;
}

export class OAuthConnectionMissingError extends Error {
  constructor(provider: OAuthProvider) {
    super(`${provider} is not connected.`);
    this.name = "OAuthConnectionMissingError";
  }
}

export class OAuthConnectionAccountMismatchError extends Error {
  constructor(provider: CalendarOAuthProvider) {
    super(
      `The connected ${provider} calendar account no longer matches this booking. Reconnect the original account before retrying its calendar operation.`,
    );
    this.name = "OAuthConnectionAccountMismatchError";
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
    input: OAuthAuthorizationInput,
  ): string {
    return this.client(provider).authorizationUrl(input);
  }

  async connect(
    organizationSlug: string,
    provider: OAuthProvider,
    input: OAuthCodeInput,
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

    const key = JSON.stringify([
      organizationSlug,
      provider,
      connection.externalAccountId,
      connection.encryptedRefreshToken,
    ]);
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
    if (
      tokens.externalAccountId !== undefined &&
      connection.externalAccountId !== null &&
      connection.externalAccountId !== tokens.externalAccountId
    ) {
      throw new Error(`${connection.provider} account changed during refresh.`);
    }
    const refreshedExternalAccountId =
      tokens.externalAccountId ?? connection.externalAccountId;
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
      {
        expectedExternalAccountId: connection.externalAccountId,
        expectedEncryptedRefreshToken: connection.encryptedRefreshToken,
      },
    );
    const stored = await this.store.getOAuthConnection(
      connection.organizationSlug,
      connection.provider,
    );
    if (
      !stored ||
      stored.externalAccountId !== refreshedExternalAccountId ||
      this.cipher.decrypt(stored.encryptedAccessToken) !== tokens.accessToken
    ) {
      throw new Error(
        `${connection.provider} connection changed during refresh.`,
      );
    }
    return tokens.accessToken;
  }

  private async save(
    organizationSlug: string,
    provider: OAuthProvider,
    tokens: OAuthTokenSet,
    refreshToken: string,
    options?: {
      expectedExternalAccountId?: string | null;
      expectedEncryptedRefreshToken?: string;
    },
  ): Promise<void> {
    await this.store.saveOAuthConnection(
      {
        organizationSlug,
        provider,
        encryptedAccessToken: this.cipher.encrypt(tokens.accessToken),
        encryptedRefreshToken: this.cipher.encrypt(refreshToken),
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        externalAccountId: tokens.externalAccountId ?? null,
        externalAccountName: tokens.externalAccountName ?? null,
        metadata: tokens.metadata ?? {},
      },
      options,
    );
  }

  private client(provider: OAuthProvider): OAuthProviderClient {
    const client = this.clients.get(provider);
    if (!client) throw new Error(`${provider} OAuth is not configured.`);
    return client;
  }
}

export class RepCalendarTokenManager {
  private readonly refreshes = new Map<string, Promise<string>>();

  constructor(
    private readonly store: RepCalendarConnectionStore,
    private readonly cipher: TokenCipher,
    private readonly clients: Map<CalendarOAuthProvider, OAuthProviderClient>,
  ) {}

  authorizationUrl(
    provider: CalendarOAuthProvider,
    input: OAuthAuthorizationInput,
  ): string {
    return this.client(provider).authorizationUrl(input);
  }

  async connect(
    organizationSlug: string,
    repId: string,
    provider: CalendarOAuthProvider,
    input: OAuthCodeInput,
  ): Promise<void> {
    const tokens = await this.client(provider).exchangeCode(input);
    if (!tokens.refreshToken) {
      throw new Error(`${provider} did not return a refresh token.`);
    }
    const activeProvider = await this.store.getActiveRepCalendarProvider(
      organizationSlug,
      repId,
    );
    await this.save(
      organizationSlug,
      repId,
      provider,
      tokens,
      tokens.refreshToken,
    );
    if (!activeProvider) {
      await this.store.setActiveRepCalendarProvider(
        organizationSlug,
        repId,
        provider,
      );
    }
  }

  async accessToken(
    organizationSlug: string,
    repId: string,
    provider: CalendarOAuthProvider,
    expectedExternalAccountId?: string,
  ): Promise<string> {
    const connection = await this.store.getRepCalendarConnection(
      organizationSlug,
      repId,
      provider,
    );
    if (!connection) throw new OAuthConnectionMissingError(provider);
    if (
      expectedExternalAccountId !== undefined &&
      connection.externalAccountId !== expectedExternalAccountId
    ) {
      throw new OAuthConnectionAccountMismatchError(provider);
    }

    if (connection.expiresAt.getTime() > Date.now() + 60_000) {
      return this.cipher.decrypt(connection.encryptedAccessToken);
    }

    const key = JSON.stringify([
      organizationSlug,
      repId,
      provider,
      connection.externalAccountId,
      connection.encryptedRefreshToken,
    ]);
    const existing = this.refreshes.get(key);
    if (existing) return existing;

    const refresh = this.refresh(connection).finally(() => {
      this.refreshes.delete(key);
    });
    this.refreshes.set(key, refresh);
    return refresh;
  }

  private async refresh(
    connection: StoredRepCalendarConnection,
  ): Promise<string> {
    const currentRefreshToken = this.cipher.decrypt(
      connection.encryptedRefreshToken,
    );
    const tokens = await this.client(connection.provider).refresh(
      currentRefreshToken,
    );
    if (
      tokens.externalAccountId !== undefined &&
      connection.externalAccountId !== null &&
      connection.externalAccountId !== tokens.externalAccountId
    ) {
      throw new OAuthConnectionAccountMismatchError(connection.provider);
    }
    const refreshedExternalAccountId =
      tokens.externalAccountId ?? connection.externalAccountId;
    await this.save(
      connection.organizationSlug,
      connection.repId,
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
      {
        preserveCalendarSources: true,
        expectedExternalAccountId: connection.externalAccountId,
        expectedEncryptedRefreshToken: connection.encryptedRefreshToken,
      },
    );
    const stored = await this.store.getRepCalendarConnection(
      connection.organizationSlug,
      connection.repId,
      connection.provider,
    );
    if (
      !stored ||
      stored.externalAccountId !== refreshedExternalAccountId ||
      this.cipher.decrypt(stored.encryptedAccessToken) !== tokens.accessToken
    ) {
      throw new OAuthConnectionAccountMismatchError(connection.provider);
    }
    return tokens.accessToken;
  }

  private async save(
    organizationSlug: string,
    repId: string,
    provider: CalendarOAuthProvider,
    tokens: OAuthTokenSet,
    refreshToken: string,
    options: {
      preserveCalendarSources?: boolean;
      expectedExternalAccountId?: string | null;
      expectedEncryptedRefreshToken?: string;
    } = { preserveCalendarSources: false },
  ): Promise<void> {
    await this.store.saveRepCalendarConnection(
      {
        organizationSlug,
        repId,
        provider,
        encryptedAccessToken: this.cipher.encrypt(tokens.accessToken),
        encryptedRefreshToken: this.cipher.encrypt(refreshToken),
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        externalAccountId: tokens.externalAccountId ?? null,
        externalAccountName: tokens.externalAccountName ?? null,
        metadata: tokens.metadata ?? {},
      },
      options,
    );
  }

  private client(provider: CalendarOAuthProvider): OAuthProviderClient {
    const client = this.clients.get(provider);
    if (!client) throw new Error(`${provider} OAuth is not configured.`);
    return client;
  }
}
