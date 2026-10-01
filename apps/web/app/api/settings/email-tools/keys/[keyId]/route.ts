import { NextResponse } from "next/server";
import { z } from "zod";
import { operatorAdminError } from "../../../../../operator-session";
import { repository } from "../../../../../repository";

const identifiers = z.object({ keyId: z.uuid(), repId: z.uuid() });

export async function DELETE(
  request: Request,
  context: { params: Promise<{ keyId: string }> },
) {
  const denied = await operatorAdminError(request);
  if (denied) return denied;
  const { keyId } = await context.params;
  const parsed = identifiers.safeParse({
    keyId,
    repId: new URL(request.url).searchParams.get("repId"),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Pairing key not found." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  const revoked = await repository.revokeEmailToolAccessKey({
    organizationSlug: process.env.HOT_POTATO_ORG ?? "acme",
    repId: parsed.data.repId,
    keyId: parsed.data.keyId,
  });
  if (!revoked) {
    return NextResponse.json(
      { error: "Pairing key not found." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  return NextResponse.json(
    {
      key: {
        ...revoked,
        createdAt: revoked.createdAt.toISOString(),
        lastUsedAt: revoked.lastUsedAt?.toISOString() ?? null,
        revokedAt: revoked.revokedAt?.toISOString() ?? null,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
