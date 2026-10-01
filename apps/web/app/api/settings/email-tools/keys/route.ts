import { NextResponse } from "next/server";
import { z } from "zod";
import { createEmailToolToken } from "../../../../email-tools";
import { operatorAdminError } from "../../../../operator-session";
import { configuredOutlookNaa } from "../../../../outlook-naa";
import { repository } from "../../../../repository";

const repQuery = z.uuid();
const createKeyInput = z
  .object({
    repId: z.uuid(),
    clientType: z.literal("outlook"),
    label: z
      .string()
      .trim()
      .min(2)
      .max(80)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
  })
  .strict();

function serializedKey(key: {
  id: string;
  organizationSlug: string;
  repId: string;
  clientType: "gmail" | "outlook";
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  outlookIdentityLinked: boolean;
}) {
  return {
    ...key,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  };
}

export async function GET(request: Request) {
  const denied = await operatorAdminError(request);
  if (denied) return denied;
  const repId = repQuery.safeParse(
    new URL(request.url).searchParams.get("repId"),
  );
  if (!repId.success) {
    return NextResponse.json(
      { error: "Choose a representative." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const keys = await repository.listEmailToolAccessKeys(
    process.env.HOT_POTATO_ORG ?? "acme",
    repId.data,
  );
  let outlookNaaConfigured = false;
  let outlookNaaConfigurationError = false;
  try {
    outlookNaaConfigured = Boolean(configuredOutlookNaa());
  } catch {
    outlookNaaConfigurationError = true;
  }
  return NextResponse.json(
    {
      keys: keys.map(serializedKey),
      gmailConfigured: Boolean(
        process.env.GOOGLE_WORKSPACE_ADDON_OAUTH_CLIENT_ID &&
          process.env.GOOGLE_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL,
      ),
      outlookNaaConfigured,
      outlookNaaConfigurationError,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const denied = await operatorAdminError(request);
  if (denied) return denied;
  const parsed = createKeyInput.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the pairing key." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const secret = createEmailToolToken();
    const key = await repository.createEmailToolAccessKey({
      organizationSlug: process.env.HOT_POTATO_ORG ?? "acme",
      repId: parsed.data.repId,
      clientType: parsed.data.clientType,
      label: parsed.data.label,
      tokenHash: secret.tokenHash,
    });
    return NextResponse.json(
      { key: serializedKey(key), token: secret.token },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error(
      "Email tool pairing key creation failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return NextResponse.json(
      { error: "The pairing key could not be created." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
}
