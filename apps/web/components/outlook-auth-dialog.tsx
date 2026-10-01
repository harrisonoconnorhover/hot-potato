"use client";

import { useEffect, useState } from "react";
import type { OutlookNaaPublicConfig } from "../app/outlook-naa";

type OfficeDialogRuntime = {
  onReady: (callback?: () => void) => Promise<unknown> | void;
  context: { ui?: { messageParent: (message: string) => void } };
};

function officeRuntime(): OfficeDialogRuntime | undefined {
  return (window as unknown as { Office?: OfficeDialogRuntime }).Office;
}

async function publicConfig(): Promise<OutlookNaaPublicConfig> {
  const response = await fetch("/api/email-tools/outlook-auth/config", {
    cache: "no-store",
  });
  const body = (await response.json()) as
    | ({ enabled: true } & OutlookNaaPublicConfig)
    | { enabled: false; error?: string };
  if (!response.ok || !body.enabled) {
    throw new Error(
      "error" in body && body.error
        ? body.error
        : "Microsoft sign-in is not configured.",
    );
  }
  return body;
}

export function OutlookAuthDialog() {
  const [message, setMessage] = useState("Connecting to Microsoft…");

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const config = await publicConfig();
      const { createStandardPublicClientApplication } = await import(
        "@azure/msal-browser"
      );
      const client = await createStandardPublicClientApplication({
        auth: {
          clientId: config.clientId,
          authority: config.authority,
          redirectUri: config.dialogUrl,
          clientCapabilities: ["CP1"],
        },
        cache: { cacheLocation: "sessionStorage" },
      });
      const redirected = await client.handleRedirectPromise();
      if (redirected?.accessToken) {
        const office = officeRuntime();
        await office?.onReady();
        office?.context.ui?.messageParent(
          JSON.stringify({ accessToken: redirected.accessToken }),
        );
        return;
      }
      if (cancelled) return;
      setMessage("Opening Microsoft sign-in…");
      await client.acquireTokenRedirect({
        scopes: [config.scope],
        redirectUri: config.dialogUrl,
        prompt: "select_account",
      });
    };
    void run().catch(async (error: unknown) => {
      if (cancelled) return;
      const detail =
        error instanceof Error
          ? error.message
          : "Microsoft sign-in could not be completed.";
      setMessage(detail);
      const office = officeRuntime();
      await office?.onReady();
      office?.context.ui?.messageParent(JSON.stringify({ error: detail }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "#f5efe6",
        color: "#181613",
        fontFamily: 'Inter, "Segoe UI", sans-serif',
      }}
    >
      <section style={{ maxWidth: 360, textAlign: "center" }}>
        <img src="/hot-potato-mascot.png" alt="" width="46" height="58" />
        <h1 style={{ margin: "14px 0 8px", fontSize: 24 }}>
          Microsoft sign-in
        </h1>
        <p style={{ margin: 0, color: "#6f665d", lineHeight: 1.5 }}>
          {message}
        </p>
      </section>
    </main>
  );
}
