import { createHash, randomBytes } from "node:crypto";
import type {
  EmailToolSchedulingCatalog,
  ResolvedEmailToolAccess,
  VerifiedRepIdentity,
} from "@hot-potato/db";
import type { EmailComposerAsset } from "@hot-potato/email-composer";
import { verifyOutlookNaaAccessToken } from "./outlook-naa";
import { repository } from "./repository";

export const emailToolTokenPrefix = "hp_email_";
const emailToolTokenPattern = /^hp_email_[A-Za-z0-9_-]{32,128}$/;

export function createEmailToolToken(): { token: string; tokenHash: string } {
  const token = `${emailToolTokenPrefix}${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashEmailToolToken(token) };
}

export function hashEmailToolToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function configuredAppOrigin(): URL {
  const value = process.env.APP_URL?.trim() || "http://localhost:3000";
  const origin = new URL(value);
  if (
    (origin.protocol !== "https:" && origin.protocol !== "http:") ||
    origin.username ||
    origin.password
  ) {
    throw new Error("APP_URL must be an HTTP(S) origin without credentials.");
  }
  const localHttp =
    origin.protocol === "http:" &&
    (origin.hostname === "localhost" ||
      origin.hostname === "127.0.0.1" ||
      origin.hostname === "[::1]");
  if (
    process.env.NODE_ENV === "production" &&
    origin.protocol !== "https:" &&
    !localHttp
  ) {
    throw new Error("APP_URL must use HTTPS outside local development.");
  }
  origin.pathname = "/";
  origin.search = "";
  origin.hash = "";
  return origin;
}

export function emailComposerAssets(
  catalog: EmailToolSchedulingCatalog,
): EmailComposerAsset[] {
  const base = configuredAppOrigin();
  const meetingTypes: EmailComposerAsset[] = catalog.meetingTypes.map(
    (meeting) => ({
      id: meeting.id,
      kind: "meeting_type",
      slug: meeting.slug,
      title: meeting.title,
      description: meeting.description,
      bookingUrl: new URL(
        `/schedule/${encodeURIComponent(catalog.organizationSlug)}/${encodeURIComponent(meeting.slug)}`,
        base,
      ).toString(),
      hostName: meeting.targetName,
      durationMinutes: meeting.durationMinutes,
    }),
  );
  const routerLinks: EmailComposerAsset[] = catalog.smartRouterLinks.map(
    (link) => ({
      id: link.id,
      kind: "router_link",
      slug: link.slug,
      title: link.title,
      description: link.description,
      bookingUrl: new URL(
        `/r/${encodeURIComponent(catalog.organizationSlug)}/${encodeURIComponent(link.slug)}`,
        base,
      ).toString(),
      hostName: null,
      durationMinutes: null,
    }),
  );
  return [...meetingTypes, ...routerLinks].sort((left, right) =>
    left.title.localeCompare(right.title),
  );
}

export function bearerEmailToolToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match || !emailToolTokenPattern.test(match[1]!)) return null;
  return match[1]!;
}

export function bearerOutlookNaaToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  return (
    /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
      authorization,
    )?.[1] ?? null
  );
}

export async function emailToolAccess(
  request: Request,
): Promise<ResolvedEmailToolAccess | null> {
  const token = bearerEmailToolToken(request);
  if (token) {
    return repository.resolveEmailToolAccessKey(hashEmailToolToken(token));
  }

  const bearer = bearerOutlookNaaToken(request);
  if (!bearer) return null;
  const verified = await verifyOutlookNaaAccessToken(bearer);
  if (!verified) return null;
  return repository.resolveOutlookEmailIdentity({
    tenantId: verified.tenantId,
    subject: verified.subject,
  });
}

export async function emailToolCatalogForAccess(
  access: ResolvedEmailToolAccess,
): Promise<EmailToolSchedulingCatalog | null> {
  return repository.emailToolSchedulingCatalog(
    access.organization.slug,
    access.rep.id,
  );
}

export async function emailToolCatalogForVerifiedIdentity(
  identity: VerifiedRepIdentity,
): Promise<EmailToolSchedulingCatalog | null> {
  return repository.emailToolSchedulingCatalog(
    identity.organization.slug,
    identity.rep.id,
  );
}
