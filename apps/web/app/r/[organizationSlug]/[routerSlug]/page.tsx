import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { SmartRouterClient } from "../../../../components/smart-router-client";
import {
  authorizedFormBridgeMode,
  requestedFormBridgeId,
} from "../../../form-bridge-authorization";
import { repository } from "../../../repository";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Find the right meeting — Hot Potato",
  description: "Answer a few questions and choose a live meeting time.",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function embedParentOrigin(
  value: string | string[] | undefined,
): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (
      url.origin !== value ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

export default async function SmartRouterPage({
  params,
  searchParams,
}: {
  params: Promise<{ organizationSlug: string; routerSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const route = await params;
  if (
    !slugPattern.test(route.organizationSlug) ||
    !slugPattern.test(route.routerSlug) ||
    route.organizationSlug.length > 80 ||
    route.routerSlug.length > 80
  ) {
    notFound();
  }

  const query = await searchParams;
  let link = await repository.publicRouterLink(
    route.organizationSlug,
    route.routerSlug,
  );
  let recoveryOnly = false;
  if (!link) {
    const identity = await repository.recoverableRouterLinkIdentity(
      route.organizationSlug,
      route.routerSlug,
    );
    if (!identity) notFound();

    if (identity.active && identity.slug !== route.routerSlug) {
      const nextQuery = new URLSearchParams();
      if (query.embed === "1") {
        nextQuery.set("embed", "1");
        const parentOrigin = embedParentOrigin(query.parentOrigin);
        if (parentOrigin) nextQuery.set("parentOrigin", parentOrigin);
        const bridgeId = requestedFormBridgeId(query.bridge);
        if (bridgeId) nextQuery.set("bridge", bridgeId);
      }
      const suffix = nextQuery.size > 0 ? `?${nextQuery.toString()}` : "";
      redirect(
        `/r/${encodeURIComponent(identity.organizationSlug)}/${encodeURIComponent(identity.slug)}${suffix}`,
      );
    }

    recoveryOnly = true;
    link = {
      id: identity.id,
      organizationName: identity.organizationName,
      organizationSlug: identity.organizationSlug,
      slug: identity.slug,
      title: "Scheduling link unavailable",
      description: "",
      buttonLabel: "Find a meeting",
      noMatchMessage: "This scheduling link is no longer accepting requests.",
      successRedirectUrl: null,
      successRedirectDelaySeconds: 5,
      accentColor: "#E2552D",
      questions: [],
    };
  }

  const embed = query.embed === "1";
  const parentOrigin = embed ? embedParentOrigin(query.parentOrigin) : null;
  const bridgeId = embed ? requestedFormBridgeId(query.bridge) : null;
  const bridgeConfig =
    !recoveryOnly && bridgeId && parentOrigin
      ? await repository.publicRouterFormBridge(bridgeId)
      : null;
  const bridge = recoveryOnly
    ? false
    : authorizedFormBridgeMode({
        requestedBridgeId: bridgeId,
        parentOrigin,
        routerPath: `/r/${route.organizationSlug}/${route.routerSlug}`,
        config: bridgeConfig,
      });

  return (
    <SmartRouterClient
      link={link}
      embed={embed}
      bridge={bridge}
      parentOrigin={parentOrigin}
      recoveryOnly={recoveryOnly}
    />
  );
}
