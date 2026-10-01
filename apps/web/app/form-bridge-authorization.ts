import type { PublicRouterFormBridgeConfig } from "@hot-potato/db";

const bridgeIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requestedFormBridgeId(
  value: string | string[] | undefined,
): string | null {
  return typeof value === "string" && bridgeIdPattern.test(value)
    ? value
    : null;
}

export function authorizedFormBridgeMode(input: {
  requestedBridgeId: string | null;
  parentOrigin: string | null;
  routerPath: string;
  config: PublicRouterFormBridgeConfig | null;
}): boolean {
  return Boolean(
    input.requestedBridgeId &&
      input.parentOrigin &&
      input.config &&
      input.config.routerPath === input.routerPath &&
      input.config.allowedOrigins.includes(input.parentOrigin),
  );
}
