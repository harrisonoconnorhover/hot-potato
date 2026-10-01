import {
  HUBSPOT_CONTACT_READ_SCOPE,
  HUBSPOT_OWNER_READ_SCOPE,
  HubSpotCrmAdapter,
} from "@hot-potato/integrations";
import type { Lead } from "@hot-potato/router";
import { connectionManager } from "./connections";
import { repository } from "./repository";

type HubSpotConnectionStatus = {
  provider: string;
  connected: boolean;
  scopes: string[];
};

type HubSpotOwnershipRepository = {
  connectionStatuses(
    organizationSlug: string,
  ): Promise<HubSpotConnectionStatus[]>;
};

type HubSpotOwnerLookup = {
  ownerEmailForContact(
    contactEmail: string,
    signal?: AbortSignal,
  ): Promise<string | null>;
};

type HubSpotRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export const HUBSPOT_OWNERSHIP_LOOKUP_TIMEOUT_MS = 10_000;

export type HubSpotOwnershipResolution = {
  checked: boolean;
  ownerEmail: string | null;
};

export type HubSpotOwnershipDependencies = {
  environment?: HubSpotRuntimeEnvironment;
  repository?: HubSpotOwnershipRepository;
  createOwnerLookup?: (organizationSlug: string) => HubSpotOwnerLookup;
  lookupTimeoutMs?: number;
};

export class HubSpotOwnershipLookupError extends Error {
  constructor(
    message = "HubSpot contact ownership could not be verified.",
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "HubSpotOwnershipLookupError";
  }
}

export class HubSpotOwnershipConfigurationError extends HubSpotOwnershipLookupError {
  constructor() {
    super(
      "HubSpot is connected, but its OAuth runtime credentials are not configured.",
    );
    this.name = "HubSpotOwnershipConfigurationError";
  }
}

export class HubSpotReconnectRequiredError extends HubSpotOwnershipLookupError {
  constructor() {
    super(
      `Reconnect HubSpot to grant ${HUBSPOT_CONTACT_READ_SCOPE} and ${HUBSPOT_OWNER_READ_SCOPE} before routing.`,
    );
    this.name = "HubSpotReconnectRequiredError";
  }
}

function hasValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function withAbortDeadline<T>(operation: Promise<T>, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function hubSpotOwnershipConfigured(
  environment: HubSpotRuntimeEnvironment = process.env,
): boolean {
  return (
    hasValue(environment.OAUTH_ENCRYPTION_KEY) &&
    hasValue(environment.HUBSPOT_CLIENT_ID) &&
    hasValue(environment.HUBSPOT_CLIENT_SECRET)
  );
}

export async function resolveHubSpotOwnership(
  input: {
    organizationSlug: string;
    contactEmail: string;
    signal?: AbortSignal;
  },
  dependencies: HubSpotOwnershipDependencies = {},
): Promise<HubSpotOwnershipResolution> {
  let connection: HubSpotConnectionStatus | undefined;
  try {
    connection = (
      await (dependencies.repository ?? repository).connectionStatuses(
        input.organizationSlug,
      )
    ).find((candidate) => candidate.provider === "hubspot");
  } catch (error) {
    throw new HubSpotOwnershipLookupError(
      "HubSpot connection status could not be verified.",
      error,
    );
  }

  if (!connection?.connected) {
    return { checked: false, ownerEmail: null };
  }
  if (!hubSpotOwnershipConfigured(dependencies.environment ?? process.env)) {
    throw new HubSpotOwnershipConfigurationError();
  }
  if (
    !connection.scopes.includes(HUBSPOT_CONTACT_READ_SCOPE) ||
    !connection.scopes.includes(HUBSPOT_OWNER_READ_SCOPE)
  ) {
    throw new HubSpotReconnectRequiredError();
  }

  const ownerLookup =
    dependencies.createOwnerLookup?.(input.organizationSlug) ??
    new HubSpotCrmAdapter(() =>
      connectionManager().accessToken(input.organizationSlug, "hubspot"),
    );
  const deadlineSignal = AbortSignal.timeout(
    dependencies.lookupTimeoutMs ?? HUBSPOT_OWNERSHIP_LOOKUP_TIMEOUT_MS,
  );
  const lookupSignal = input.signal
    ? AbortSignal.any([input.signal, deadlineSignal])
    : deadlineSignal;
  try {
    lookupSignal.throwIfAborted();
    return {
      checked: true,
      ownerEmail: await withAbortDeadline(
        ownerLookup.ownerEmailForContact(input.contactEmail, lookupSignal),
        lookupSignal,
      ),
    };
  } catch (error) {
    throw new HubSpotOwnershipLookupError(undefined, error);
  }
}

export function leadWithAuthoritativeHubSpotOwner(
  lead: Lead,
  resolution: HubSpotOwnershipResolution,
): Lead {
  const trustedLead = { ...lead };
  delete trustedLead.current_owner_email;
  if (resolution.checked && resolution.ownerEmail) {
    trustedLead.current_owner_email = resolution.ownerEmail;
  }
  return trustedLead;
}
