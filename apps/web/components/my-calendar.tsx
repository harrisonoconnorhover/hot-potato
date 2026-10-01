"use client";

import type {
  CalendarOAuthProvider,
  DashboardCalendarConnection,
  OperatorRepCalendarProfile,
} from "@hot-potato/db";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AvailabilityEditor } from "./availability-editor";
import styles from "./my-calendar.module.css";

type CalendarProfileResponse = {
  linked: boolean;
  profile: OperatorRepCalendarProfile | null;
  providers: Record<CalendarOAuthProvider, { configured: boolean }>;
  error?: string;
};

type Notice = { tone: "success" | "error"; message: string };

const providerDetails = {
  google: {
    name: "Google Calendar",
    shortName: "Google",
    mark: "31",
    className: styles.google,
  },
  microsoft: {
    name: "Microsoft Outlook",
    shortName: "Outlook",
    mark: "MS",
    className: styles.microsoft,
  },
} as const;

function connectionFor(
  profile: OperatorRepCalendarProfile,
  provider: CalendarOAuthProvider,
): DashboardCalendarConnection {
  return provider === "google"
    ? profile.rep.googleCalendar
    : profile.rep.microsoftCalendar;
}

function selectedIds(
  connection: DashboardCalendarConnection,
  active: boolean,
): string[] {
  const selected = new Set(
    connection.calendars
      .filter((calendar) => calendar.selected)
      .map((calendar) => calendar.calendarId),
  );
  if (active) {
    connection.calendars
      .filter((calendar) => calendar.isDefault)
      .forEach((calendar) => selected.add(calendar.calendarId));
  }
  return [...selected];
}

function syncLabel(value: string | null): string {
  if (!value) return "Calendar list not refreshed yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Last refresh unavailable";
  return `Refreshed ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date)}`;
}

function connectionResultNotice(): Notice | null {
  if (typeof window === "undefined") return null;
  const query = new URLSearchParams(window.location.search);
  const provider = query.get("repConnection");
  const status = query.get("status");
  if (!provider || !status) return null;
  const name = provider === "google" ? "Google Calendar" : "Microsoft Outlook";
  const messages: Record<string, Notice> = {
    connected: {
      tone: "success",
      message: `${name} is connected and ready to configure.`,
    },
    "connected-needs-refresh": {
      tone: "success",
      message: `${name} is connected. Refresh its calendar list to finish setup.`,
    },
    "missing-config": {
      tone: "error",
      message: `${name} needs administrator setup before it can be connected.`,
    },
    "invalid-state": {
      tone: "error",
      message:
        "That connection expired or failed its security check. Start it again.",
    },
    denied: {
      tone: "error",
      message: `${name} access was not granted. Nothing was changed.`,
    },
    failed: {
      tone: "error",
      message: `${name} could not be connected. Try again or ask an administrator to check the server log.`,
    },
  };
  return messages[status] ?? null;
}

async function responseMessage(response: Response, fallback: string) {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

export function MyCalendar({ login }: { login: string }) {
  const [data, setData] = useState<CalendarProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/me/calendar", { cache: "no-store" });
    const body = (await response.json().catch(() => ({}))) as
      | CalendarProfileResponse
      | { error?: string };
    if (!response.ok) {
      throw new Error(
        "error" in body && body.error
          ? body.error
          : "Your calendar settings could not be loaded.",
      );
    }
    setData(body as CalendarProfileResponse);
  }, []);

  useEffect(() => {
    setNotice(connectionResultNotice());
    load()
      .catch((error: unknown) =>
        setNotice({
          tone: "error",
          message:
            error instanceof Error
              ? error.message
              : "Your calendar settings could not be loaded.",
        }),
      )
      .finally(() => setLoading(false));
  }, [load]);

  const schedulePath = useMemo(() => {
    if (!data?.profile?.rep.activeCalendarProvider) return null;
    return `/schedule/${data.profile.organization.slug}/${data.profile.rep.schedulingSlug}`;
  }, [data]);

  async function updateProvider(
    provider: CalendarOAuthProvider,
    nextSelectedIds: string[],
    makeActive = false,
  ) {
    const profile = data?.profile;
    if (!profile) return;
    setBusy(`${provider}:${makeActive ? "active" : "selection"}`);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/settings/reps/${encodeURIComponent(profile.rep.id)}/calendars/${provider}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            selectedCalendarIds: nextSelectedIds,
            ...(makeActive ? { makeActive: true } : {}),
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          await responseMessage(
            response,
            "The calendar setting could not be saved.",
          ),
        );
      }
      await load();
      setNotice({
        tone: "success",
        message: makeActive
          ? `${providerDetails[provider].name} will receive new bookings. All selected calendars still block busy times.`
          : `${providerDetails[provider].name} conflict calendars were updated.`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The calendar setting could not be saved.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function refreshProvider(provider: CalendarOAuthProvider) {
    const profile = data?.profile;
    if (!profile) return;
    setBusy(`${provider}:refresh`);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/settings/reps/${encodeURIComponent(profile.rep.id)}/calendars/${provider}`,
        { method: "POST" },
      );
      if (!response.ok) {
        throw new Error(
          await responseMessage(
            response,
            "The calendar list could not be refreshed.",
          ),
        );
      }
      await load();
      setNotice({
        tone: "success",
        message: `${providerDetails[provider].name} calendars were refreshed.`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The calendar list could not be refreshed.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function copyScheduleLink() {
    if (!schedulePath) return;
    try {
      await navigator.clipboard.writeText(
        new URL(schedulePath, window.location.origin).toString(),
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_800);
    } catch {
      setNotice({
        tone: "error",
        message: "The booking link could not be copied.",
      });
    }
  }

  return (
    <section className={styles.shell} id="my-calendar">
      <header>
        <div>
          <span>MY CALENDAR</span>
          <h2>Your availability, under your control.</h2>
          <p>
            Connect Google, Outlook, or both. Choose every calendar that should
            block busy time and the account that should receive new meetings.
          </p>
        </div>
        {data?.profile && (
          <strong>
            {data.profile.rep.activeCalendarProvider
              ? "READY TO BOOK"
              : "SETUP NEEDED"}
          </strong>
        )}
      </header>

      {notice && (
        <p
          className={`${styles.notice} ${styles[notice.tone]}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.message}
        </p>
      )}

      {loading && (
        <div className={styles.loading} role="status">
          Loading your calendar workspace…
        </div>
      )}

      {!loading && data && !data.linked && (
        <div className={styles.unlinked}>
          <span aria-hidden="true">↗</span>
          <div>
            <h3>Your login is not linked to a representative yet.</h3>
            <p>
              Ask an administrator to create one active representative with the
              exact email <b>{login}</b>. Hot Potato deliberately stops when the
              match is missing or ambiguous so nobody can connect the wrong
              calendar.
            </p>
          </div>
        </div>
      )}

      {!loading && data?.profile && (
        <div className={styles.body}>
          <div className={styles.identityBar}>
            <div className={styles.avatar} aria-hidden="true">
              {data.profile.rep.name
                .split(/\s+/)
                .slice(0, 2)
                .map((part) => part[0]?.toUpperCase())
                .join("")}
            </div>
            <div>
              <b>{data.profile.rep.name}</b>
              <span>{data.profile.rep.email}</span>
            </div>
            <p>
              <b>{data.profile.rep.timezone}</b>
              <span>
                {data.profile.rep.meetingDurationMinutes}-minute default meeting
              </span>
            </p>
          </div>

          <div className={styles.availability}>
            <AvailabilityEditor
              rep={data.profile.rep}
              onSaved={load}
              availabilitySchedules={data.profile.availabilitySchedules}
            />
          </div>

          <div className={styles.explainer}>
            <div>
              <b>Busy-time calendars</b>
              <span>
                Every selected Google and Outlook calendar blocks availability.
              </span>
            </div>
            <span aria-hidden="true">→</span>
            <div>
              <b>Booking calendar</b>
              <span>
                One active provider receives the event and meeting link.
              </span>
            </div>
          </div>

          <div className={styles.providerGrid}>
            {(["google", "microsoft"] as const).map((provider) => {
              const detail = providerDetails[provider];
              const connection = connectionFor(data.profile!, provider);
              const active =
                data.profile!.rep.activeCalendarProvider === provider;
              const currentSelectedIds = selectedIds(connection, active);
              const defaultCalendar = connection.calendars.find(
                (calendar) => calendar.isDefault && calendar.available,
              );
              const providerBusy = busy?.startsWith(`${provider}:`) ?? false;
              const connectAction = `/api/reps/${data.profile!.rep.id}/connections/${provider}/start?returnTo=my-calendar`;

              return (
                <article
                  className={`${styles.providerCard} ${active ? styles.activeProvider : ""}`}
                  key={provider}
                  aria-busy={providerBusy}
                >
                  <div className={styles.providerHeader}>
                    <span
                      className={`${styles.providerMark} ${detail.className}`}
                    >
                      {detail.mark}
                    </span>
                    <div>
                      <h3>{detail.name}</h3>
                      <span>
                        {connection.connected
                          ? (connection.accountName ?? "Connected account")
                          : data.providers[provider].configured
                            ? "Not connected"
                            : "Administrator setup needed"}
                      </span>
                    </div>
                    <span
                      className={`${styles.state} ${connection.connected ? styles.connected : ""}`}
                    >
                      {active
                        ? "BOOKING PROVIDER"
                        : connection.connected
                          ? "CONNECTED"
                          : "NOT CONNECTED"}
                    </span>
                  </div>

                  {!connection.connected ? (
                    <div className={styles.connectBody}>
                      <p>
                        Connect {detail.shortName} to check real availability
                        and create confirmed meetings in this account.
                      </p>
                      <form method="post" action={connectAction}>
                        <button
                          type="submit"
                          disabled={
                            !data.providers[provider].configured ||
                            busy !== null
                          }
                        >
                          Connect {detail.shortName}
                        </button>
                      </form>
                    </div>
                  ) : (
                    <>
                      <div className={styles.providerActions}>
                        <span>
                          {syncLabel(connection.calendarCatalogSyncedAt)}
                        </span>
                        <div>
                          {connection.canSyncCalendars && (
                            <button
                              type="button"
                              disabled={busy !== null}
                              onClick={() => void refreshProvider(provider)}
                            >
                              {busy === `${provider}:refresh`
                                ? "Refreshing…"
                                : "Refresh calendars"}
                            </button>
                          )}
                          {!active && (
                            <button
                              className={styles.primaryAction}
                              type="button"
                              disabled={
                                busy !== null ||
                                !connection.canSyncCalendars ||
                                !defaultCalendar
                              }
                              onClick={() =>
                                void updateProvider(
                                  provider,
                                  defaultCalendar
                                    ? [
                                        ...new Set([
                                          ...currentSelectedIds,
                                          defaultCalendar.calendarId,
                                        ]),
                                      ]
                                    : currentSelectedIds,
                                  true,
                                )
                              }
                            >
                              {busy === `${provider}:active`
                                ? "Switching…"
                                : "Use for bookings"}
                            </button>
                          )}
                        </div>
                      </div>

                      {!connection.canSyncCalendars && (
                        <div className={styles.reconnect}>
                          <p>
                            Reconnect {detail.shortName} to load and choose
                            named calendars. Your booking link will stay the
                            same.
                          </p>
                          <form method="post" action={connectAction}>
                            <button type="submit" disabled={busy !== null}>
                              Reconnect {detail.shortName}
                            </button>
                          </form>
                        </div>
                      )}

                      {connection.calendarCatalogError && (
                        <p className={styles.catalogError} role="alert">
                          {connection.calendarCatalogError}
                        </p>
                      )}

                      <fieldset className={styles.calendarList}>
                        <legend>Calendars that block busy time</legend>
                        {connection.calendars.length === 0 ? (
                          <p>
                            {connection.canSyncCalendars
                              ? "Refresh to load this account’s calendars."
                              : "Reconnect to load this account’s calendars."}
                          </p>
                        ) : (
                          connection.calendars.map((calendar) => {
                            const locked = active && calendar.isDefault;
                            const checked = calendar.selected || locked;
                            const disabled =
                              busy !== null ||
                              locked ||
                              (!calendar.available && !checked);
                            return (
                              <label
                                className={`${!calendar.available ? styles.missing : ""} ${locked ? styles.locked : ""}`}
                                key={calendar.calendarId}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={disabled}
                                  onChange={(event) => {
                                    const next = new Set(currentSelectedIds);
                                    if (event.target.checked) {
                                      next.add(calendar.calendarId);
                                    } else {
                                      next.delete(calendar.calendarId);
                                    }
                                    void updateProvider(provider, [...next]);
                                  }}
                                />
                                <span>
                                  <b>{calendar.name || calendar.calendarId}</b>
                                  <small>
                                    {locked
                                      ? "Required for the booking provider"
                                      : !calendar.available
                                        ? "Missing from the connected account"
                                        : calendar.isDefault
                                          ? "Default calendar"
                                          : "Blocks conflicts when selected"}
                                  </small>
                                </span>
                                {calendar.isDefault && <em>DEFAULT</em>}
                              </label>
                            );
                          })
                        )}
                      </fieldset>
                    </>
                  )}
                </article>
              );
            })}
          </div>

          <div className={styles.bookingLink}>
            <div>
              <span>PERSONAL BOOKING LINK</span>
              <b>
                {schedulePath
                  ? `${data.profile.organization.slug}/${data.profile.rep.schedulingSlug}`
                  : "Connect and choose a booking provider to go live"}
              </b>
            </div>
            {schedulePath && (
              <div>
                <a href={schedulePath} target="_blank" rel="noreferrer">
                  Preview ↗
                </a>
                <button type="button" onClick={() => void copyScheduleLink()}>
                  {copied ? "Copied ✓" : "Copy link"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
