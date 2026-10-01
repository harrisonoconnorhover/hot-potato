import { z } from "zod";
import {
  bearerOutlookNaaToken,
  hashEmailToolToken,
} from "../../../../email-tools";
import { verifyOutlookNaaAccessToken } from "../../../../outlook-naa";
import {
  publicBodyError,
  PublicBodyError,
  publicError,
  publicJson,
  readPublicJson,
} from "../../../../public-api";
import { repository } from "../../../../repository";

const bindingInput = z
  .object({
    pairingKey: z.string().regex(/^hp_email_[A-Za-z0-9_-]{32,128}$/),
  })
  .strict();

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const token = bearerOutlookNaaToken(request);
    const principal = token ? await verifyOutlookNaaAccessToken(token) : null;
    if (!principal) {
      return publicError(
        401,
        "Sign in with Microsoft before linking this Outlook pane.",
        "invalid_outlook_identity",
      );
    }
    const parsed = bindingInput.safeParse(await readPublicJson(request, 1024));
    if (!parsed.success) {
      return publicError(
        422,
        "Paste a complete, active Outlook fallback key.",
        "invalid_pairing_key",
      );
    }
    const access = await repository.bindOutlookEmailIdentity({
      tenantId: principal.tenantId,
      subject: principal.subject,
      assertedEmail: principal.email,
      bootstrapTokenHash: hashEmailToolToken(parsed.data.pairingKey),
    });
    if (!access) {
      return publicError(
        409,
        "That Microsoft account or fallback key is already linked differently, inactive, or revoked.",
        "identity_binding_conflict",
      );
    }
    return publicJson({
      linked: true,
      organizationName: access.organization.name,
      repName: access.rep.name,
    });
  } catch (error) {
    if (error instanceof PublicBodyError) return publicBodyError(error);
    console.error(
      "Outlook identity binding failed:",
      error instanceof Error ? error.name : "Unknown error",
    );
    return publicError(
      503,
      "The Microsoft account could not be linked. Please try again.",
      "service_unavailable",
    );
  }
}
