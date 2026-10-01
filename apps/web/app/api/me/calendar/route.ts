import { providerConfigured } from "@hot-potato/integrations";
import { NextResponse } from "next/server";
import { operatorSessionForRequest } from "../../../operator-session";
import { repository } from "../../../repository";

export const dynamic = "force-dynamic";
const noStoreHeaders = { "cache-control": "no-store" };

export async function GET(request: Request) {
  const identity = await operatorSessionForRequest(request);
  if (!identity) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401, headers: noStoreHeaders },
    );
  }
  try {
    const profile = await repository.operatorRepCalendarProfile(
      identity.organizationSlug,
      identity.operatorId,
    );
    return NextResponse.json(
      {
        linked: Boolean(profile),
        profile,
        providers: {
          google: { configured: providerConfigured("google") },
          microsoft: { configured: providerConfigured("microsoft") },
        },
      },
      { headers: noStoreHeaders },
    );
  } catch (error) {
    console.error(
      "Personal calendar profile failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return NextResponse.json(
      { error: "Your calendar profile is temporarily unavailable." },
      { status: 503, headers: noStoreHeaders },
    );
  }
}
