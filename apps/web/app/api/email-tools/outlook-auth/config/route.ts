import { configuredOutlookNaa } from "../../../../outlook-naa";
import { publicError, publicJson } from "../../../../public-api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const config = configuredOutlookNaa();
    return publicJson(
      config ? { enabled: true, ...config } : { enabled: false },
    );
  } catch (error) {
    console.error(
      "Outlook NAA configuration failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return publicError(
      503,
      "Microsoft sign-in is not configured correctly.",
      "outlook_auth_unavailable",
    );
  }
}
