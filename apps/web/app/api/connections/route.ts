import { providerConfigured } from "@hot-potato/integrations";
import { NextResponse } from "next/server";
import { repository } from "../../repository";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const statuses = await repository.connectionStatuses(
      process.env.HOT_POTATO_ORG ?? "acme",
    );
    return NextResponse.json(
      statuses.map((status) => ({
        ...status,
        configured: providerConfigured(status.provider),
      })),
    );
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Connection status could not be loaded." },
      { status: 503 },
    );
  }
}
