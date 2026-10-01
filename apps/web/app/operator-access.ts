import { createHash, randomBytes } from "node:crypto";
import { OperatorAccessError } from "@hot-potato/db";
import { NextResponse } from "next/server";

export const operatorAccessTokenPattern = /^hp_access_[A-Za-z0-9_-]{43}$/;

export function createOperatorAccessToken(): {
  token: string;
  tokenHash: string;
} {
  const token = `hp_access_${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashOperatorAccessToken(token) };
}

export function hashOperatorAccessToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function operatorAccessErrorResponse(error: unknown): NextResponse {
  if (error instanceof OperatorAccessError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "forbidden"
          ? 403
          : error.code === "conflict" || error.code === "last_owner"
            ? 409
            : 400;
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status, headers: { "cache-control": "no-store" } },
    );
  }
  console.error(
    "Operator access operation failed:",
    error instanceof Error ? error.name : "Unknown error",
  );
  return NextResponse.json(
    { error: "People and access is temporarily unavailable." },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}
