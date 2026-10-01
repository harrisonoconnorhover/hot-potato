"use client";

import type {
  EmailComposerAsset,
  EmailComposerContent,
  SuggestedEmailSlot,
} from "@hot-potato/email-composer";
import { emailTimezoneOptions } from "@hot-potato/email-composer";
import type { OutlookNaaPublicConfig } from "../app/outlook-naa";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  acquireOutlookNaaAccessToken,
  nestedAppAuthSupported,
  type OutlookAuthOfficeRuntime,
} from "./outlook-naa-client";
import styles from "./outlook-email-composer.module.css";

const sessionKeyName = "hotPotatoEmailToolKey";

type CatalogResponse = {
  organizationName: string;
  repName: string;
  authentication: "microsoft" | "pairing_key";
  recentLinkAssetId: string | null;
  recentMeetingTypeId: string | null;
  recentPurpose: "link" | "times" | null;
  assets: EmailComposerAsset[];
};

type OutlookNaaConfigResponse =
  | ({ enabled: true } & OutlookNaaPublicConfig)
  | { enabled: false; error?: string };

export type OutlookRenderResponse = {
  content?: EmailComposerContent;
  slots?: SuggestedEmailSlot[];
  choices?: SuggestedEmailSlot[];
  selectedStartsAt?: string[];
  timezone?: string;
  locale?: string;
  code?: string;
  error?: string;
};

export type OutlookContentRequest = {
  accessKey: string;
  assetId: string;
  mode: "link" | "times";
  timezone: string;
  locale: string;
  selectedStartsAt?: string[];
};

type OutlookRequest = (
  path: string,
  key: string,
  init?: RequestInit,
) => Promise<Response>;

class EmailToolRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EmailToolRequestError";
  }
}

export class OutlookRenderRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly response: OutlookRenderResponse,
  ) {
    super(message);
    this.name = "OutlookRenderRequestError";
  }
}

type OfficeResult<T> = {
  status: string;
  value: T;
  error?: { message?: string };
};

export type OfficeRuntime = OutlookAuthOfficeRuntime & {
  onReady: (callback?: () => void) => Promise<unknown> | void;
  CoercionType: { Html: string; Text: string };
  context: OutlookAuthOfficeRuntime["context"] & {
    mailbox?: {
      item?: {
        body?: {
          getTypeAsync: (
            callback: (result: OfficeResult<string>) => void,
          ) => void;
          setSelectedDataAsync: (
            data: string,
            options: { coercionType: string },
            callback: (result: OfficeResult<void>) => void,
          ) => void;
        };
      };
    };
  };
};

function officeRuntime(): OfficeRuntime | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { Office?: OfficeRuntime }).Office;
}

function saveSessionKey(value: string | null): void {
  if (value) window.sessionStorage.setItem(sessionKeyName, value);
  else window.sessionStorage.removeItem(sessionKeyName);
}

function storedSessionKey(): string {
  return window.sessionStorage.getItem(sessionKeyName) ?? "";
}

async function requestWithKey(
  path: string,
  key: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(path, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
      authorization: `Bearer ${key}`,
    },
  });
}

export async function requestFreshOutlookContent(
  input: OutlookContentRequest,
  request: OutlookRequest = requestWithKey,
): Promise<OutlookRenderResponse & { content: EmailComposerContent }> {
  const response = await request("/api/email-tools/render", input.accessKey, {
    method: "POST",
    body: JSON.stringify({
      assetId: input.assetId,
      mode: input.mode,
      timezone: input.timezone,
      locale: input.locale,
      ...(input.mode === "times"
        ? { selectedStartsAt: input.selectedStartsAt ?? [] }
        : {}),
    }),
  });
  const body = (await response
    .json()
    .catch(() => ({}))) as OutlookRenderResponse;
  if (!response.ok || !body.content) {
    throw new OutlookRenderRequestError(
      body.error ?? "The scheduling options could not be prepared.",
      response.status,
      body,
    );
  }
  return { ...body, content: body.content };
}

export async function rememberOutlookSchedulingChoice(
  input: {
    accessKey: string;
    purpose: "link" | "times";
    assetId: string;
  },
  request: OutlookRequest = requestWithKey,
): Promise<boolean> {
  const response = await request(
    "/api/email-tools/preferences",
    input.accessKey,
    {
      method: "POST",
      body: JSON.stringify({
        purpose: input.purpose,
        assetId: input.assetId,
      }),
    },
  );
  return response.ok;
}

export type OutlookMutationLock = { current: boolean };

export async function runFreshOutlookMutation<T>(input: {
  lock: OutlookMutationLock;
  refresh: () => Promise<EmailComposerContent>;
  mutate: (content: EmailComposerContent) => Promise<T>;
  retainLockOnSuccess?: boolean;
}): Promise<
  | { executed: false }
  | { executed: true; content: EmailComposerContent; result: T }
> {
  if (input.lock.current) return { executed: false };
  input.lock.current = true;
  try {
    const freshContent = await input.refresh();
    const result = await input.mutate(freshContent);
    if (!input.retainLockOnSuccess) input.lock.current = false;
    return { executed: true, content: freshContent, result };
  } catch (error) {
    input.lock.current = false;
    throw error;
  }
}

export type OfficeInsertResult = "html" | "text" | "text_fallback";

export function officeInsert(
  content: EmailComposerContent,
  runtime = officeRuntime(),
): Promise<OfficeInsertResult> {
  const office = runtime;
  const body = office?.context.mailbox?.item?.body;
  if (!office || !body) {
    return Promise.reject(
      new Error("Open this pane from an Outlook message you are composing."),
    );
  }
  return new Promise((resolve, reject) => {
    body.getTypeAsync((typeResult) => {
      if (typeResult.status !== office.AsyncResultStatus.Succeeded) {
        reject(
          new Error(
            typeResult.error?.message ??
              "Outlook could not read the draft format.",
          ),
        );
        return;
      }
      const isHtml = typeResult.value === office.CoercionType.Html;
      body.setSelectedDataAsync(
        isHtml ? content.html : content.text,
        {
          coercionType: isHtml
            ? office.CoercionType.Html
            : office.CoercionType.Text,
        },
        (insertResult) => {
          if (insertResult.status === office.AsyncResultStatus.Succeeded) {
            resolve(isHtml ? "html" : "text");
            return;
          }
          if (isHtml) {
            body.setSelectedDataAsync(
              content.text,
              { coercionType: office.CoercionType.Text },
              (fallbackResult) => {
                if (
                  fallbackResult.status === office.AsyncResultStatus.Succeeded
                ) {
                  resolve("text_fallback");
                } else {
                  reject(
                    new Error(
                      fallbackResult.error?.message ??
                        insertResult.error?.message ??
                        "Outlook could not insert the scheduling options.",
                    ),
                  );
                }
              },
            );
            return;
          }
          reject(
            new Error(
              insertResult.error?.message ??
                "Outlook could not insert the scheduling options.",
            ),
          );
        },
      );
    });
  });
}

async function copyEmailContent(content: EmailComposerContent): Promise<void> {
  if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([content.html], { type: "text/html" }),
        "text/plain": new Blob([content.text], { type: "text/plain" }),
      }),
    ]);
    return;
  }
  await navigator.clipboard.writeText(content.text);
}

export type OutlookChoiceGroup = {
  key: string;
  label: string;
  choices: Array<SuggestedEmailSlot & { timeLabel: string }>;
};

export function groupOutlookChoices(
  choices: SuggestedEmailSlot[],
  timezone: string,
  locale: string,
): OutlookChoiceGroup[] {
  const dayFormatter = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const keyFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const timeFormatter = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const groups = new Map<string, OutlookChoiceGroup>();
  for (const choice of choices) {
    const date = new Date(choice.startsAt);
    const key = keyFormatter.format(date);
    const group = groups.get(key) ?? {
      key,
      label: dayFormatter.format(date),
      choices: [],
    };
    group.choices.push({ ...choice, timeLabel: timeFormatter.format(date) });
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function toggleOutlookChoice(
  current: string[],
  startsAt: string,
): { selected: string[]; error: string | null } {
  if (current.includes(startsAt)) {
    return {
      selected: current.filter((candidate) => candidate !== startsAt),
      error: null,
    };
  }
  if (current.length >= 5) {
    return {
      selected: current,
      error: "Choose at most five times.",
    };
  }
  return { selected: [...current, startsAt], error: null };
}

export function initialOutlookSchedulingSelection(
  catalog: Pick<
    CatalogResponse,
    "assets" | "recentLinkAssetId" | "recentMeetingTypeId" | "recentPurpose"
  >,
): { assetId: string; mode: "link" | "times" } {
  const recentLink = catalog.assets.find(
    (asset) => asset.id === catalog.recentLinkAssetId,
  );
  const recentMeeting = catalog.assets.find(
    (asset) =>
      asset.id === catalog.recentMeetingTypeId && asset.kind === "meeting_type",
  );
  if (catalog.recentPurpose === "link" && recentLink) {
    return { assetId: recentLink.id, mode: "link" };
  }
  if (catalog.recentPurpose === "times" && recentMeeting) {
    return { assetId: recentMeeting.id, mode: "times" };
  }
  const firstMeeting = catalog.assets.find(
    (asset) => asset.kind === "meeting_type",
  );
  if (firstMeeting) return { assetId: firstMeeting.id, mode: "times" };
  const firstLink = recentLink ?? catalog.assets[0];
  return { assetId: firstLink?.id ?? "", mode: "link" };
}

export function OutlookEmailComposer() {
  const [officeReady, setOfficeReady] = useState(false);
  const [officeAvailable, setOfficeAvailable] = useState(false);
  const [officeLoadFailed, setOfficeLoadFailed] = useState(false);
  const [pairingKey, setPairingKey] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [pendingMicrosoftToken, setPendingMicrosoftToken] = useState<
    string | null
  >(null);
  const [authentication, setAuthentication] = useState<
    "microsoft" | "pairing_key" | null
  >(null);
  const [naaConfig, setNaaConfig] = useState<OutlookNaaPublicConfig | null>(
    null,
  );
  const [naaConfigLoaded, setNaaConfigLoaded] = useState(false);
  const [naaSupported, setNaaSupported] = useState(false);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [mode, setMode] = useState<"link" | "times">("times");
  const [content, setContent] = useState<EmailComposerContent | null>(null);
  const [slots, setSlots] = useState<SuggestedEmailSlot[]>([]);
  const [choices, setChoices] = useState<SuggestedEmailSlot[]>([]);
  const [selectedStartsAt, setSelectedStartsAt] = useState<string[]>([]);
  const [displayTimezone, setDisplayTimezone] = useState("UTC");
  const [choiceTimezone, setChoiceTimezone] = useState("UTC");
  const [choiceLocale, setChoiceLocale] = useState("en-US");
  const [inserted, setInserted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activeMutation, setActiveMutation] = useState<
    "insert" | "copy" | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const insertionLocked = useRef(false);
  const copyLocked = useRef(false);
  const identityBooted = useRef(false);

  const selectedAsset = useMemo(
    () => catalog?.assets.find((asset) => asset.id === selectedAssetId) ?? null,
    [catalog, selectedAssetId],
  );
  const choiceGroups = useMemo(
    () => groupOutlookChoices(choices, choiceTimezone, choiceLocale),
    [choices, choiceLocale, choiceTimezone],
  );
  const timezoneOptions = useMemo(
    () => emailTimezoneOptions(displayTimezone),
    [displayTimezone],
  );

  const loadCatalog = useCallback(async (key: string) => {
    const response = await requestWithKey("/api/email-tools/catalog", key);
    const body = (await response.json().catch(() => ({}))) as
      | CatalogResponse
      | { error?: string };
    if (!response.ok || !("assets" in body)) {
      throw new EmailToolRequestError(
        ("error" in body ? body.error : undefined) ??
          "Microsoft sign-in or the pairing key could not be verified.",
        response.status,
      );
    }
    setAccessKey(key);
    setCatalog(body);
    setAuthentication(body.authentication);
    const initialSelection = initialOutlookSchedulingSelection(body);
    setSelectedAssetId(initialSelection.assetId);
    setMode(initialSelection.mode);
    setPairingKey("");
    setContent(null);
    setSlots([]);
    setChoices([]);
    setSelectedStartsAt([]);
    setInserted(false);
    insertionLocked.current = false;
    copyLocked.current = false;
  }, []);

  useEffect(() => {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    setDisplayTimezone(timezone);
    setChoiceTimezone(timezone);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/email-tools/outlook-auth/config", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as OutlookNaaConfigResponse;
        if (!response.ok) throw new Error("Outlook auth config unavailable");
        if (!cancelled) setNaaConfig(body.enabled ? body : null);
      })
      .catch(() => {
        if (!cancelled) setNaaConfig(null);
      })
      .finally(() => {
        if (!cancelled) setNaaConfigLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const office = officeRuntime();
      if (!office) {
        if (attempts >= 60) {
          window.clearInterval(timer);
          setOfficeLoadFailed(true);
        }
        return;
      }
      window.clearInterval(timer);
      office.onReady(() => {
        if (cancelled) return;
        setOfficeAvailable(true);
        setOfficeReady(Boolean(office.context.mailbox?.item?.body));
      });
    }, 250);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadCatalog]);

  useEffect(() => {
    if (!officeAvailable || !naaConfigLoaded || identityBooted.current) return;
    identityBooted.current = true;
    let cancelled = false;
    const initializeIdentity = async () => {
      const office = officeRuntime();
      setNaaSupported(nestedAppAuthSupported(office));
      if (naaConfig) {
        const token = await acquireOutlookNaaAccessToken({
          config: naaConfig,
          office,
          interactive: false,
        }).catch(() => null);
        if (token) {
          try {
            await loadCatalog(token);
            if (!cancelled) return;
          } catch (caught) {
            if (
              !cancelled &&
              caught instanceof EmailToolRequestError &&
              caught.status === 401
            ) {
              setPendingMicrosoftToken(token);
              setError(
                "Microsoft sign-in succeeded. Paste one fallback key to link this account to the correct representative.",
              );
            }
          }
        }
      }
      const stored = storedSessionKey();
      if (!stored || cancelled) return;
      try {
        await loadCatalog(stored);
      } catch (caught) {
        if (cancelled) return;
        if (
          caught instanceof EmailToolRequestError &&
          (caught.status === 401 || caught.status === 403)
        ) {
          saveSessionKey(null);
          setError(
            "Your saved pairing key expired or was revoked. Sign in with Microsoft or pair Outlook again.",
          );
          return;
        }
        setError(
          "Hot Potato could not be reached. Your saved pairing key was kept; reopen the pane to retry.",
        );
      }
    };
    void initializeIdentity();
    return () => {
      cancelled = true;
    };
  }, [loadCatalog, naaConfig, naaConfigLoaded, officeAvailable]);

  useEffect(() => {
    if (selectedAsset?.kind === "router_link") setMode("link");
    setContent(null);
    setSlots([]);
    setChoices([]);
    setSelectedStartsAt([]);
    setInserted(false);
    insertionLocked.current = false;
    copyLocked.current = false;
    setNotice(null);
  }, [selectedAsset]);

  async function pair() {
    const key = pairingKey.trim();
    if (!/^hp_email_[A-Za-z0-9_-]{32,}$/.test(key)) {
      setError("Paste the complete pairing key from Hot Potato settings.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (pendingMicrosoftToken) {
        const response = await requestWithKey(
          "/api/email-tools/outlook-auth/bind",
          pendingMicrosoftToken,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ pairingKey: key }),
          },
        );
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        if (!response.ok) {
          throw new EmailToolRequestError(
            body.error ?? "This Microsoft account could not be linked.",
            response.status,
          );
        }
        await loadCatalog(pendingMicrosoftToken);
        setPendingMicrosoftToken(null);
        saveSessionKey(null);
        setNotice(
          "Microsoft account linked. Future sign-ins use the Microsoft identity; revoking this fallback key disables both paths.",
        );
        return;
      }
      await loadCatalog(key);
      saveSessionKey(key);
      setNotice(
        "Outlook is paired for this task pane session. The key can be revoked at any time in Hot Potato.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Outlook could not be paired.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function signInMicrosoft() {
    if (!naaConfig) return;
    setBusy(true);
    setError(null);
    let token: string | null = null;
    try {
      token = await acquireOutlookNaaAccessToken({
        config: naaConfig,
        office: officeRuntime(),
        interactive: true,
      });
      if (!token) throw new Error("Microsoft sign-in did not return a token.");
      await loadCatalog(token);
      setPendingMicrosoftToken(null);
      saveSessionKey(null);
      setNotice(
        "Signed in with Microsoft using the account linked to this representative, without reading the draft or mailbox.",
      );
    } catch (caught) {
      if (
        token &&
        caught instanceof EmailToolRequestError &&
        caught.status === 401
      ) {
        setPendingMicrosoftToken(token);
        setError(
          "Microsoft sign-in succeeded. Paste one fallback key to link this account to the correct representative.",
        );
        return;
      }
      setError(
        caught instanceof Error
          ? caught.message
          : "Microsoft sign-in could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    saveSessionKey(null);
    setAccessKey("");
    setPendingMicrosoftToken(null);
    setAuthentication(null);
    setCatalog(null);
    setContent(null);
    setSlots([]);
    setChoices([]);
    setSelectedStartsAt([]);
    setInserted(false);
    insertionLocked.current = false;
    copyLocked.current = false;
    setNotice(null);
    setError(null);
  }

  async function authorizedRequest(
    path: string,
    fallbackKey: string,
    init?: RequestInit,
  ): Promise<Response> {
    let key = fallbackKey;
    if (authentication === "microsoft" && naaConfig) {
      const silent = await acquireOutlookNaaAccessToken({
        config: naaConfig,
        office: officeRuntime(),
        interactive: false,
      }).catch(() => null);
      if (silent) {
        key = silent;
        if (silent !== accessKey) setAccessKey(silent);
      }
    }
    let response = await requestWithKey(path, key, init);
    if (
      response.status === 401 &&
      authentication === "microsoft" &&
      naaConfig
    ) {
      const refreshed = await acquireOutlookNaaAccessToken({
        config: naaConfig,
        office: officeRuntime(),
        interactive: true,
      });
      if (refreshed) {
        setAccessKey(refreshed);
        response = await requestWithKey(path, refreshed, init);
      }
    }
    return response;
  }

  async function rememberRecentAsset(purpose: "link" | "times") {
    if (!selectedAsset || !accessKey) return;
    try {
      const remembered = await rememberOutlookSchedulingChoice(
        { accessKey, purpose, assetId: selectedAsset.id },
        authorizedRequest,
      );
      if (!remembered) return;
      setCatalog((current) =>
        current
          ? {
              ...current,
              recentPurpose: purpose,
              recentLinkAssetId:
                purpose === "link"
                  ? selectedAsset.id
                  : current.recentLinkAssetId,
              recentMeetingTypeId:
                purpose === "times"
                  ? selectedAsset.id
                  : current.recentMeetingTypeId,
            }
          : current,
      );
    } catch {
      // Remembering a convenience preference must never block insertion.
    }
  }

  function browserPreferences(timezone = displayTimezone) {
    return {
      timezone,
      locale: navigator.language || "en-US",
    };
  }

  async function loadTimeChoices(timezone = displayTimezone) {
    if (!selectedAsset || !accessKey) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setContent(null);
    setSlots([]);
    setInserted(false);
    insertionLocked.current = false;
    copyLocked.current = false;
    try {
      const preferences = browserPreferences(timezone);
      const response = await authorizedRequest(
        "/api/email-tools/render",
        accessKey,
        {
          method: "POST",
          body: JSON.stringify({
            assetId: selectedAsset.id,
            mode: "choices",
            ...preferences,
          }),
        },
      );
      const body = (await response
        .json()
        .catch(() => ({}))) as OutlookRenderResponse;
      if (!response.ok || !body.choices) {
        if (response.status === 401) await disconnect();
        throw new Error(
          body.error ?? "The scheduling options could not be prepared.",
        );
      }
      setChoices(body.choices);
      setSelectedStartsAt(body.selectedStartsAt ?? []);
      const normalizedTimezone = body.timezone ?? preferences.timezone;
      setDisplayTimezone(normalizedTimezone);
      setChoiceTimezone(normalizedTimezone);
      setChoiceLocale(body.locale ?? preferences.locale);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The scheduling options could not be prepared.",
      );
    } finally {
      setBusy(false);
    }
  }

  function currentContentRequest(): OutlookContentRequest | null {
    if (!selectedAsset || !accessKey) return null;
    const preferences = browserPreferences();
    return {
      accessKey,
      assetId: selectedAsset.id,
      mode,
      timezone: mode === "times" ? choiceTimezone : preferences.timezone,
      locale: mode === "times" ? choiceLocale : preferences.locale,
      ...(mode === "times" ? { selectedStartsAt } : {}),
    };
  }

  async function fetchCurrentContent() {
    const request = currentContentRequest();
    if (!request) throw new Error("Choose a scheduling link.");
    return requestFreshOutlookContent(request, authorizedRequest);
  }

  async function handleRenderFailure(caught: unknown, fallback: string) {
    if (caught instanceof OutlookRenderRequestError) {
      if (caught.status === 401) await disconnect();
      setContent(null);
      setSlots([]);
      setInserted(false);
      if (caught.response.code === "stale_times" && caught.response.choices) {
        setChoices(caught.response.choices);
        setSelectedStartsAt(caught.response.selectedStartsAt ?? []);
        setChoiceTimezone(caught.response.timezone ?? choiceTimezone);
        setChoiceLocale(caught.response.locale ?? choiceLocale);
      }
    }
    setError(caught instanceof Error ? caught.message : fallback);
  }

  async function preview() {
    if (!selectedAsset || !accessKey) return;
    if (
      mode === "times" &&
      (selectedStartsAt.length < 1 || selectedStartsAt.length > 5)
    ) {
      setError("Choose one to five live times.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = await fetchCurrentContent();
      setContent(body.content);
      setSlots(body.slots ?? []);
      setInserted(false);
      insertionLocked.current = false;
      copyLocked.current = false;
    } catch (caught) {
      await handleRenderFailure(
        caught,
        "The scheduling options could not be prepared.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function insert() {
    if (!content || insertionLocked.current || inserted) return;
    setBusy(true);
    setActiveMutation("insert");
    setError(null);
    setNotice(null);
    try {
      const outcome = await runFreshOutlookMutation({
        lock: insertionLocked,
        refresh: async () => {
          const rendered = await fetchCurrentContent();
          setContent(rendered.content);
          setSlots(rendered.slots ?? []);
          return rendered.content;
        },
        mutate: (freshContent) => officeInsert(freshContent),
        retainLockOnSuccess: true,
      });
      if (!outcome.executed) return;
      void rememberRecentAsset(mode);
      setInserted(true);
      setNotice(
        outcome.result === "text_fallback"
          ? `${mode === "times" ? "Rechecked live availability. " : "Refreshed the booking link. "}Outlook rejected rich formatting, so Hot Potato inserted the plain-text version once.`
          : `${mode === "times" ? "Rechecked live availability" : "Refreshed the booking link"} and inserted once at the cursor. You can edit the wording before sending.`,
      );
    } catch (caught) {
      await handleRenderFailure(
        caught,
        "Outlook could not insert the content.",
      );
    } finally {
      setBusy(false);
      setActiveMutation(null);
    }
  }

  async function copy() {
    if (!content || copyLocked.current) return;
    setBusy(true);
    setActiveMutation("copy");
    setNotice(null);
    try {
      const outcome = await runFreshOutlookMutation({
        lock: copyLocked,
        refresh: async () => {
          const rendered = await fetchCurrentContent();
          setContent(rendered.content);
          setSlots(rendered.slots ?? []);
          return rendered.content;
        },
        mutate: copyEmailContent,
      });
      if (!outcome.executed) return;
      void rememberRecentAsset(mode);
      setNotice(
        `${mode === "times" ? "Rechecked live availability" : "Refreshed the booking link"} and copied with formatting.`,
      );
      setError(null);
    } catch (caught) {
      await handleRenderFailure(
        caught,
        "The preview could not be copied. Select the text and copy it manually.",
      );
    } finally {
      setBusy(false);
      setActiveMutation(null);
    }
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <img src="/hot-potato-mascot.png" alt="" />
        <div>
          <b>HOT POTATO</b>
          <span>INSERT SCHEDULING</span>
        </div>
      </header>

      {!catalog ? (
        <section className={styles.pairing}>
          <small>SESSION SETUP</small>
          <h1>Connect this Outlook pane</h1>
          {naaConfig && (
            <>
              <p>
                Use the Microsoft account already signed in to Outlook. Hot
                Potato requests only its own scheduling permission, verifies
                your identity server-side, and never reads the draft, mailbox,
                or recipients.
              </p>
              <button
                type="button"
                className={styles.microsoftButton}
                onClick={() => void signInMicrosoft()}
                disabled={busy}
              >
                {busy ? "Connecting…" : "Continue with Microsoft"}
                <span>↗</span>
              </button>
              <p className={styles.authSupport}>
                {naaSupported
                  ? "This Outlook client supports nested app authentication."
                  : officeAvailable
                    ? "This client will use Microsoft’s secure sign-in dialog if seamless sign-in is unavailable."
                    : "Microsoft sign-in also works in supported Outlook clients; browser preview remains copy-only."}
              </p>
              <div className={styles.authDivider}>
                <span>Scoped fallback</span>
              </div>
            </>
          )}
          <p>
            {naaConfig
              ? pendingMicrosoftToken
                ? "Use one revocable fallback key to prove which representative this Microsoft account belongs to. The key becomes the admin-controlled revocation anchor."
                : "For an older client—or to link a Microsoft account for the first time—create a revocable Outlook key in Hot Potato and paste it below."
              : "Create a scoped Outlook key in Hot Potato, then paste it here. It can only read this rep’s shareable scheduling links and can be revoked without touching calendar connections."}
          </p>
          <label>
            {pendingMicrosoftToken ? "One-time fallback key" : "Pairing key"}
            <input
              type="password"
              autoComplete="off"
              placeholder="hp_email_…"
              value={pairingKey}
              onChange={(event) => setPairingKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void pair();
              }}
            />
          </label>
          <button type="button" onClick={() => void pair()} disabled={busy}>
            {busy
              ? "Checking…"
              : pendingMicrosoftToken
                ? "Link Microsoft account"
                : "Use pairing key"}
            <span>↗</span>
          </button>
          <p className={styles.context}>
            {officeReady
              ? "Outlook compose is ready."
              : officeLoadFailed
                ? "Office.js did not load. Reload the pane, or preview and copy the content instead."
                : "You can preview and copy in a browser; insertion appears inside Outlook compose."}
          </p>
        </section>
      ) : (
        <section className={styles.composer}>
          <div className={styles.identity}>
            <div>
              <small>{catalog.organizationName}</small>
              <b>{catalog.repName}</b>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void disconnect()}
            >
              Disconnect
            </button>
          </div>

          {catalog.assets.length === 0 ? (
            <div className={styles.empty}>
              <b>No shareable links yet</b>
              <p>Activate a meeting type or Smart Router Link in Hot Potato.</p>
            </div>
          ) : (
            <>
              <label className={styles.field}>
                What are you sharing?
                <select
                  value={selectedAssetId}
                  disabled={busy}
                  onChange={(event) => {
                    const assetId = event.target.value;
                    const asset = catalog.assets.find(
                      (candidate) => candidate.id === assetId,
                    );
                    setSelectedAssetId(assetId);
                    if (asset?.kind === "router_link") setMode("link");
                    setContent(null);
                    setSlots([]);
                    setChoices([]);
                    setSelectedStartsAt([]);
                    setInserted(false);
                    insertionLocked.current = false;
                    copyLocked.current = false;
                    setNotice(null);
                    setError(null);
                  }}
                >
                  {catalog.assets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.kind === "router_link"
                        ? "Smart Router · "
                        : "Meeting · "}
                      {asset.title}
                    </option>
                  ))}
                </select>
              </label>

              <div className={styles.mode} aria-label="Scheduling format">
                <button
                  type="button"
                  className={mode === "times" ? styles.active : ""}
                  disabled={
                    busy ||
                    !catalog.assets.some(
                      (asset) => asset.kind === "meeting_type",
                    )
                  }
                  onClick={() => {
                    if (selectedAsset?.kind === "router_link") {
                      const meeting =
                        catalog.assets.find(
                          (asset) =>
                            asset.id === catalog.recentMeetingTypeId &&
                            asset.kind === "meeting_type",
                        ) ??
                        catalog.assets.find(
                          (asset) => asset.kind === "meeting_type",
                        );
                      if (meeting) setSelectedAssetId(meeting.id);
                    }
                    setMode("times");
                    setContent(null);
                    setChoices([]);
                    setSelectedStartsAt([]);
                    setInserted(false);
                    insertionLocked.current = false;
                    copyLocked.current = false;
                  }}
                >
                  1–5 live times
                </button>
                <button
                  type="button"
                  className={mode === "link" ? styles.active : ""}
                  disabled={busy}
                  onClick={() => {
                    setMode("link");
                    setContent(null);
                    setChoices([]);
                    setSelectedStartsAt([]);
                    setInserted(false);
                    insertionLocked.current = false;
                    copyLocked.current = false;
                  }}
                >
                  Booking link
                </button>
              </div>

              {selectedAsset?.kind === "router_link" && (
                <p className={styles.hint}>
                  Smart Router Links qualify the recipient first, so they are
                  shared as one clean link.
                </p>
              )}

              {mode === "times" && selectedAsset?.kind === "meeting_type" && (
                <label className={`${styles.field} ${styles.timezoneField}`}>
                  Display suggested times in
                  <select
                    value={displayTimezone}
                    disabled={busy}
                    onChange={(event) => {
                      const timezone = event.target.value;
                      const refresh = choices.length > 0 || Boolean(content);
                      setDisplayTimezone(timezone);
                      setChoiceTimezone(timezone);
                      setContent(null);
                      setSlots([]);
                      setChoices([]);
                      setSelectedStartsAt([]);
                      setInserted(false);
                      insertionLocked.current = false;
                      copyLocked.current = false;
                      setNotice(null);
                      setError(null);
                      if (refresh) void loadTimeChoices(timezone);
                    }}
                  >
                    {timezoneOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <small>
                    Pick the recipient&apos;s timezone without reading the draft
                    or using enrichment.
                  </small>
                </label>
              )}

              {!content ? (
                mode === "times" && choices.length > 0 ? (
                  <div className={styles.choiceBlock}>
                    <div className={styles.choiceHeading}>
                      <div>
                        <span>LIVE AVAILABILITY</span>
                        <b>{selectedStartsAt.length} selected · choose 1–5</b>
                      </div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void loadTimeChoices()}
                      >
                        Refresh
                      </button>
                    </div>
                    <p className={styles.choiceMeta}>
                      Times are shown in {choiceTimezone.replaceAll("_", " ")}.
                      Hot Potato rechecks them before preview.
                    </p>
                    <div className={styles.choiceGroups}>
                      {choiceGroups.map((group) => (
                        <fieldset
                          className={styles.choiceGroup}
                          key={group.key}
                        >
                          <legend>{group.label}</legend>
                          <div className={styles.choiceGrid}>
                            {group.choices.map((choice) => {
                              const selected = selectedStartsAt.includes(
                                choice.startsAt,
                              );
                              return (
                                <button
                                  type="button"
                                  key={choice.startsAt}
                                  className={selected ? styles.selected : ""}
                                  aria-pressed={selected}
                                  disabled={busy}
                                  onClick={() => {
                                    const next = toggleOutlookChoice(
                                      selectedStartsAt,
                                      choice.startsAt,
                                    );
                                    setSelectedStartsAt(next.selected);
                                    setError(next.error);
                                    setNotice(null);
                                  }}
                                >
                                  <span>{choice.timeLabel}</span>
                                  <small>
                                    {selected ? "Selected ✓" : "Select"}
                                  </small>
                                </button>
                              );
                            })}
                          </div>
                        </fieldset>
                      ))}
                    </div>
                    <button
                      className={styles.primary}
                      type="button"
                      onClick={() => void preview()}
                      disabled={
                        busy ||
                        selectedStartsAt.length < 1 ||
                        selectedStartsAt.length > 5
                      }
                    >
                      {busy
                        ? "Rechecking calendars…"
                        : "Preview selected times"}
                      <span>↗</span>
                    </button>
                  </div>
                ) : (
                  <button
                    className={styles.primary}
                    type="button"
                    onClick={() =>
                      void (mode === "times" ? loadTimeChoices() : preview())
                    }
                    disabled={busy || !selectedAsset}
                  >
                    {busy
                      ? "Checking calendars…"
                      : mode === "times"
                        ? "Choose live times"
                        : "Preview link"}
                    <span>↗</span>
                  </button>
                )
              ) : (
                <div className={styles.previewBlock}>
                  <div className={styles.previewHeading}>
                    <span>EMAIL PREVIEW</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setContent(null);
                        setInserted(false);
                        insertionLocked.current = false;
                        copyLocked.current = false;
                      }}
                    >
                      Change
                    </button>
                  </div>
                  <div
                    className={styles.preview}
                    dangerouslySetInnerHTML={{ __html: content.html }}
                  />
                  {slots.length > 0 && (
                    <small className={styles.freshness}>
                      Rechecked for this preview · rechecked again immediately
                      before Insert or Copy · checked again when the recipient
                      books
                    </small>
                  )}
                  <button
                    className={styles.primary}
                    type="button"
                    onClick={() => void insert()}
                    disabled={busy || !officeReady || inserted}
                  >
                    {inserted
                      ? "Inserted ✓"
                      : activeMutation === "insert"
                        ? "Rechecking & inserting…"
                        : "Insert at cursor"}
                    <span>↗</span>
                  </button>
                  <button
                    className={styles.secondary}
                    type="button"
                    onClick={() => void copy()}
                    disabled={busy}
                  >
                    {activeMutation === "copy"
                      ? "Rechecking & copying…"
                      : "Copy instead"}
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {notice && (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <footer>
        Only shareable links leave Hot Potato. Drafts and recipients stay in
        Outlook.
      </footer>
    </main>
  );
}
