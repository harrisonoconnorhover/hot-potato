import type { HotPotatoRepository } from "@hot-potato/db";
import { NextResponse } from "next/server";

export const publicRequestBodyLimit = 16 * 1024;

export const publicResponseHeaders = {
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

export class PublicBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 415,
    readonly code:
      | "invalid_json"
      | "payload_too_large"
      | "unsupported_media_type",
  ) {
    super(message);
    this.name = "PublicBodyError";
  }
}

export async function readPublicJson(
  request: Request,
  maximumBytes = publicRequestBodyLimit,
): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new PublicBodyError(
      "Send this request as JSON.",
      415,
      "unsupported_media_type",
    );
  }

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new PublicBodyError(
      "The request is too large.",
      413,
      "payload_too_large",
    );
  }

  if (!request.body) {
    throw new PublicBodyError(
      "Enter the required details.",
      400,
      "invalid_json",
    );
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel();
        throw new PublicBodyError(
          "The request is too large.",
          413,
          "payload_too_large",
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof PublicBodyError) throw error;
    throw new PublicBodyError("Enter valid JSON details.", 400, "invalid_json");
  }
}

export function publicJson<T>(value: T, status = 200, headers?: HeadersInit) {
  return NextResponse.json(value, {
    status,
    headers: { ...publicResponseHeaders, ...headers },
  });
}

export function publicError(
  status: number,
  message: string,
  code: string,
  headers?: HeadersInit,
) {
  return publicJson({ error: message, code }, status, headers);
}

export function publicBodyError(error: PublicBodyError) {
  return publicError(error.status, error.message, error.code);
}

export function publicClientAddress(request: Request): string {
  const configuredHeader =
    process.env.TRUSTED_PROXY_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (
    configuredHeader !== "cf-connecting-ip" &&
    configuredHeader !== "x-real-ip" &&
    configuredHeader !== "x-forwarded-for"
  ) {
    return "shared-origin";
  }
  const headerValue = request.headers.get(configuredHeader);
  const value =
    configuredHeader === "x-forwarded-for"
      ? headerValue?.split(",")[0]
      : headerValue;
  return (
    (value ?? "unknown-through-proxy")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, 128) || "unknown-through-proxy"
  );
}

type PublicRatePolicy = {
  scope: string;
  identifier: string;
  limit: number;
  windowSeconds: number;
};

function resetMilliseconds(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

export async function enforcePublicRateLimits(
  repository: HotPotatoRepository,
  organizationSlug: string,
  policies: PublicRatePolicy[],
): Promise<NextResponse | null> {
  for (const policy of policies) {
    const result = await repository.consumePublicRateLimit({
      organizationSlug,
      scope: policy.scope,
      identifier: policy.identifier,
      limit: policy.limit,
      windowSeconds: policy.windowSeconds,
    });
    if (result.allowed) continue;
    const retryAfter = Math.max(
      1,
      Math.ceil((resetMilliseconds(result.resetAt) - Date.now()) / 1_000),
    );
    return publicError(
      429,
      "Too many requests. Please wait a moment and try again.",
      "rate_limited",
      { "retry-after": String(retryAfter) },
    );
  }
  return null;
}
