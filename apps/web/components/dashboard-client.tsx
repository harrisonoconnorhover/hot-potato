"use client";

import type {
  Dashboard,
  DashboardCalendarConnection,
  RouteDecision,
} from "@hot-potato/db";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { RoutingStudio } from "./routing-studio";
import { EmailToolsSettings } from "./email-tools-settings";
import { FormBridgeSettings } from "./form-bridge-settings";
import { SchedulingSettings } from "./scheduling-settings";
import { SmartRouterSettings } from "./smart-router-settings";
import { HandoffScheduler } from "./handoff-scheduler";
import { WorkspaceLaunchpad } from "./workspace-launchpad";
import { ReportingDashboard } from "./reporting-dashboard";
import { hubSpotConnectionNeedsReconnect } from "./workspace-readiness";
import { PeopleAccess } from "./people-access";
import { AccountSecurity } from "./account-security";
import { MyCalendar } from "./my-calendar";

type LeadForm = {
  email: string;
  employees: string;
  state: string;
};

type Connection = {
  provider: "hubspot" | "google" | "microsoft";
  connected: boolean;
  active: boolean;
  configured: boolean;
  accountId: string | null;
  accountName: string | null;
  scopes: string[];
  expiresAt: string | null;
};

type CalendarProvider = "google" | "microsoft";

type OperatorSummary = {
  displayName: string;
  login: string;
  role: "owner" | "admin" | "operator";
};

const adminNavigationSections = new Set([
  "people-access",
  "connections",
  "connection-hubspot",
  "connection-google",
  "connection-microsoft",
  "routing-studio",
  "reps",
  "pools",
  "rules",
  "test-route",
  "smart-links",
  "form-bridges",
  "calendar-readiness",
  "email-tools",
  "meeting-types",
  "working-hours",
]);

type CalendarAction = {
  key: string;
  kind: "activate" | "refresh" | "selection";
};

const initialLead: LeadForm = {
  email: "maya@northstarlabs.example",
  employees: "820",
  state: "NY",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function providerName(provider: string): string {
  if (provider === "google") return "Google Calendar";
  if (provider === "microsoft") return "Microsoft 365";
  return "HubSpot";
}

function providerStatus(connection: Connection | undefined): string {
  if (hubSpotConnectionNeedsReconnect(connection)) {
    return "Reconnect required";
  }
  if (!connection?.connected) return "Not connected";
  return connection.active ? "Connected · Active" : "Connected";
}

function calendarProviderName(provider: CalendarProvider): string {
  return provider === "google" ? "Google" : "Outlook";
}

function calendarSelectionIds(
  connection: DashboardCalendarConnection,
  active: boolean,
): string[] {
  if (!connection.connected) return [];
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

function calendarSyncLabel(value: string | null): string {
  if (!value) return "Not refreshed yet";
  const syncedAt = new Date(value);
  if (Number.isNaN(syncedAt.getTime())) return "Last refresh unavailable";
  return `Last synced ${formatTime(value)}`;
}

function selectedCalendarCount(
  rep: Dashboard["pools"][number]["members"][number],
): number {
  return (
    calendarSelectionIds(
      rep.googleCalendar,
      rep.activeCalendarProvider === "google",
    ).length +
    calendarSelectionIds(
      rep.microsoftCalendar,
      rep.activeCalendarProvider === "microsoft",
    ).length
  );
}

function operatorInitials(name: string): string {
  return (
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toLocaleUpperCase() ?? "")
      .join("") || "HP"
  );
}

function operatorCanAdmin(operator: OperatorSummary | null): boolean {
  return operator?.role === "owner" || operator?.role === "admin";
}

function RuleConditions({
  conditions,
}: {
  conditions: Record<string, unknown>;
}) {
  return (
    <div className="condition-list">
      {Object.entries(conditions).map(([field, predicate]) => (
        <span key={field}>
          <b>{field.replace("company.", "")}</b>
          {JSON.stringify(predicate)
            .replace(/[{}\"]/g, " ")
            .trim()}
        </span>
      ))}
    </div>
  );
}

export function DashboardClient() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [lead, setLead] = useState(initialLead);
  const [result, setResult] = useState<RouteDecision | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [operator, setOperator] = useState<OperatorSummary | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [routing, setRouting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [copiedSchedule, setCopiedSchedule] = useState<string | null>(null);
  const [calendarAction, setCalendarAction] = useState<CalendarAction | null>(
    null,
  );
  const [calendarNotice, setCalendarNotice] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);
  const [activeSection, setActiveSection] = useState("overview");
  const reconciledInitialHash = useRef(false);

  const loadDashboard = useCallback(async () => {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    if (!response.ok)
      throw new Error("The routing workspace could not be loaded.");
    setDashboard((await response.json()) as Dashboard);
  }, []);

  const loadConnections = useCallback(async () => {
    const response = await fetch("/api/connections", { cache: "no-store" });
    if (!response.ok) throw new Error("Connection status could not be loaded.");
    setConnections((await response.json()) as Connection[]);
  }, []);

  const loadOperator = useCallback(async () => {
    const response = await fetch("/api/auth/session", { cache: "no-store" });
    if (!response.ok) throw new Error("Your operator session has expired.");
    const body = (await response.json()) as { operator: OperatorSummary };
    setOperator(body.operator);
    return body.operator;
  }, []);

  useEffect(() => {
    Promise.all([loadDashboard(), loadOperator()])
      .then(([, identity]) =>
        operatorCanAdmin(identity) ? loadConnections() : undefined,
      )
      .catch((caught: unknown) =>
        setError(
          caught instanceof Error ? caught.message : "Something went wrong.",
        ),
      )
      .finally(() => setLoading(false));
    const query = new URLSearchParams(window.location.search);
    const provider = query.get("connection") ?? query.get("repConnection");
    const status = query.get("status");
    if (provider && status) {
      const messages: Record<string, string> = {
        connected: `${providerName(provider)} connected successfully.`,
        "connected-needs-refresh": `${providerName(provider)} connected. Refresh its calendar list below to finish choosing which calendars block availability.`,
        "missing-config":
          "Add the provider credentials and encryption settings, then restart Hot Potato.",
        "invalid-state":
          "The connection expired or failed its security check. Start again.",
        denied: "Provider access was not granted.",
        failed:
          "The provider could not be connected. Check the server log for details.",
      };
      setConnectionNotice(messages[status] ?? "Connection status changed.");
    }
  }, [loadConnections, loadDashboard, loadOperator]);

  useEffect(() => {
    const syncActiveSection = () =>
      setActiveSection(window.location.hash.slice(1) || "overview");
    syncActiveSection();
    window.addEventListener("hashchange", syncActiveSection);
    return () => window.removeEventListener("hashchange", syncActiveSection);
  }, []);

  useEffect(() => {
    if (!dashboard || loading || reconciledInitialHash.current) return;
    reconciledInitialHash.current = true;
    const targetId = window.location.hash.slice(1);
    if (!targetId) return;
    window.requestAnimationFrame(() => {
      document.getElementById(targetId)?.scrollIntoView();
    });
  }, [dashboard, loading]);

  const connection = (provider: Connection["provider"]) =>
    connections.find((item) => item.provider === provider);
  const hubSpotRequiresReconnect = hubSpotConnectionNeedsReconnect(
    connection("hubspot"),
  );
  const canAdmin = operatorCanAdmin(operator);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRouting(true);
    setResult(null);
    setError(null);

    const response = await fetch("/api/route", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        externalId: crypto.randomUUID(),
        lead: {
          email: lead.email,
          company: {
            employee_count: Number(lead.employees),
            state: lead.state.toUpperCase(),
          },
        },
      }),
    });
    const body = (await response.json()) as RouteDecision | { error: string };

    if (!response.ok) {
      setError("error" in body ? body.error : "The lead could not be routed.");
      setRouting(false);
      return;
    }

    setResult(body as RouteDecision);
    await loadDashboard();
    setRouting(false);
  }

  async function copyScheduleLink(path: string) {
    try {
      await navigator.clipboard.writeText(
        new URL(path, window.location.origin).toString(),
      );
      setCopiedSchedule(path);
    } catch {
      setCopiedSchedule("copy-error");
    }
    window.setTimeout(() => setCopiedSchedule(null), 1800);
  }

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.assign("/login");
    }
  }

  async function updateRepCalendar(
    repId: string,
    provider: CalendarProvider,
    selectedCalendarIds: string[],
    makeActive = false,
  ) {
    const key = `${repId}:${provider}`;
    setCalendarAction({ key, kind: makeActive ? "activate" : "selection" });
    setCalendarNotice(null);
    try {
      const response = await fetch(
        `/api/settings/reps/${encodeURIComponent(repId)}/calendars/${provider}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            selectedCalendarIds,
            ...(makeActive ? { makeActive: true } : {}),
          }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setCalendarNotice({
          tone: "error",
          message: body.error ?? "The calendar setting could not be saved.",
        });
        return;
      }
      try {
        await loadDashboard();
      } catch {
        setCalendarNotice({
          tone: "success",
          message:
            "Calendar settings were saved, but the workspace could not refresh. Reload to see the latest choice.",
        });
        return;
      }
      setCalendarNotice({
        tone: "success",
        message: makeActive
          ? `${calendarProviderName(provider)} will receive new bookings. Your selected calendars will continue to block busy times.`
          : `${calendarProviderName(provider)} conflict calendars updated. New availability checks use this selection immediately.`,
      });
    } catch {
      setCalendarNotice({
        tone: "error",
        message:
          "The calendar setting could not be saved. Check the connection and try again.",
      });
    } finally {
      setCalendarAction(null);
    }
  }

  async function refreshRepCalendars(
    repId: string,
    provider: CalendarProvider,
  ) {
    const key = `${repId}:${provider}`;
    setCalendarAction({ key, kind: "refresh" });
    setCalendarNotice(null);
    try {
      const response = await fetch(
        `/api/settings/reps/${encodeURIComponent(repId)}/calendars/${provider}`,
        { method: "POST" },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) {
        setCalendarNotice({
          tone: "error",
          message: body.error ?? "The calendar list could not be refreshed.",
        });
        return;
      }
      try {
        await loadDashboard();
      } catch {
        setCalendarNotice({
          tone: "success",
          message:
            "Calendars were refreshed, but the workspace could not reload. Reload the page to see the latest list.",
        });
        return;
      }
      setCalendarNotice({
        tone: "success",
        message: `${calendarProviderName(provider)} calendars refreshed.`,
      });
    } catch {
      setCalendarNotice({
        tone: "error",
        message:
          "The calendar list could not be refreshed. Check the connection and try again.",
      });
    } finally {
      setCalendarAction(null);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#top" aria-label="Hot Potato workspace home">
          <img src="/hot-potato-mascot.png" alt="" />
          <span>HOT POTATO</span>
        </a>
        <nav className="sidebar-nav" aria-label="Workspace navigation">
          {[
            { id: "overview", icon: "⌁", label: "Overview" },
            { id: "reporting", icon: "▥", label: "Reporting" },
            { id: "people-access", icon: "●", label: "People & access" },
            {
              id: "connections",
              icon: "⊞",
              label: "Connections",
            },
            {
              id: "connection-hubspot",
              icon: "HS",
              label: "HubSpot",
              status: providerStatus(connection("hubspot")),
            },
            {
              id: "connection-google",
              icon: "31",
              label: "Google Calendar",
              status: providerStatus(connection("google")),
            },
            {
              id: "connection-microsoft",
              icon: "MS",
              label: "Microsoft 365",
              status: providerStatus(connection("microsoft")),
            },
            {
              id: "handoff-scheduler",
              icon: "↗",
              label: "Handoff scheduler",
            },
            { id: "my-calendar", icon: "31", label: "My calendar" },
            {
              id: "routing-api-tester",
              icon: "⌁",
              label: "Routing API tester",
            },
            {
              id: "routing-studio",
              icon: "◇",
              label: "Routing studio",
            },
            {
              id: "reps",
              icon: "◉",
              label: "Representatives",
            },
            {
              id: "pools",
              icon: "◎",
              label: "Routing pools",
            },
            {
              id: "rules",
              icon: "⌘",
              label: "Routing rules",
            },
            {
              id: "test-route",
              icon: "✓",
              label: "Test a route",
            },
            {
              id: "smart-links",
              icon: "↗",
              label: "Smart links",
            },
            {
              id: "form-bridges",
              icon: "⇢",
              label: "Existing forms",
            },
            {
              id: "calendar-readiness",
              icon: "31",
              label: "Calendar readiness",
            },
            {
              id: "email-tools",
              icon: "@",
              label: "Email scheduling",
            },
            {
              id: "meeting-types",
              icon: "◫",
              label: "Meeting types",
            },
            {
              id: "working-hours",
              icon: "◷",
              label: "Working hours",
            },
            { id: "activity", icon: "≡", label: "Recent routes" },
            { id: "personal-security", icon: "◇", label: "My security" },
          ]
            .filter((item) => canAdmin || !adminNavigationSections.has(item.id))
            .map((item) => (
              <a
                className={activeSection === item.id ? "active" : ""}
                href={`#${item.id}`}
                key={item.id}
                onClick={() => setActiveSection(item.id)}
              >
                <span>{item.icon}</span>
                <span className="nav-copy">
                  <b>{item.label}</b>
                  {item.status && <small>{item.status}</small>}
                </span>
              </a>
            ))}
        </nav>
        <a
          className="repo-link"
          href="https://github.com/harrisonoconnorhover/hot-potato"
          target="_blank"
          rel="noreferrer"
        >
          GitHub repository <span>↗</span>
        </a>
      </aside>

      <main id="top">
        <header className="topbar">
          <div>
            <span className="mobile-brand">HOT POTATO</span>
            <a className="mobile-calendar-link" href="#my-calendar">
              My calendar
            </a>
            <b>{dashboard?.organization.name ?? "Routing workspace"}</b>
            <span className="slash">/</span>
            <span>Overview</span>
          </div>
          <div className="topbar-actions">
            <span
              className={`system-status ${hubSpotRequiresReconnect ? "action-required" : ""}`}
            >
              <i />
              {hubSpotRequiresReconnect ? "Action required" : "Routing online"}
            </span>
            {canAdmin && (
              <a
                className="icon-button"
                href="#workspace-launchpad"
                aria-label="Open workspace launch guide"
              >
                ?
              </a>
            )}
            {operator && (
              <div className="operator-identity">
                <span className="avatar" aria-hidden="true">
                  {operatorInitials(operator.displayName)}
                </span>
                <span className="operator-copy">
                  <b>{operator.displayName}</b>
                  <small>{operator.role}</small>
                </span>
                <button
                  type="button"
                  onClick={() => void signOut()}
                  disabled={signingOut}
                >
                  {signingOut ? "Leaving…" : "Sign out"}
                </button>
              </div>
            )}
          </div>
        </header>

        <div className="workspace" id="overview">
          <section className="welcome-row">
            <div>
              <div className="eyebrow">
                <span /> LIVE ROUTING WORKSPACE
              </div>
              <h1>Keep every hot lead moving.</h1>
              <p>
                Qualify, assign, and explain every inbound handoff from one
                place.
              </p>
            </div>
            <div className="workspace-badge">
              <span>ENVIRONMENT</span>
              <b>Local workspace</b>
              <small>PostgreSQL connected</small>
            </div>
          </section>

          {canAdmin && dashboard && !loading && (
            <WorkspaceLaunchpad
              dashboard={dashboard}
              connections={connections}
            />
          )}

          <section className="stat-grid" aria-label="Routing summary">
            {[
              ["Routes today", dashboard?.stats.routesToday ?? "—", "↗"],
              ["Active reps", dashboard?.stats.activeReps ?? "—", "◎"],
              ["Active rules", dashboard?.stats.activeRules ?? "—", "⌘"],
              ["Pending jobs", dashboard?.stats.pendingJobs ?? "—", "◷"],
            ].map(([label, value, icon]) => (
              <article className="stat-card" key={label}>
                <span className="stat-icon">{icon}</span>
                <small>{label}</small>
                <strong>{value}</strong>
              </article>
            ))}
          </section>

          <ReportingDashboard />

          {canAdmin && operator && <PeopleAccess currentRole={operator.role} />}

          <section
            className="connections-card"
            id="connections"
            hidden={!canAdmin}
          >
            <div className="card-heading">
              <div>
                <span className="section-number">01</span>
                <div>
                  <h2>Connections</h2>
                  <p>Live availability in. Confirmed ownership out.</p>
                </div>
              </div>
              <span className="connection-count">
                {
                  connections.filter(
                    (item) =>
                      item.connected && !hubSpotConnectionNeedsReconnect(item),
                  ).length
                }
                /3 LIVE
              </span>
            </div>
            {connectionNotice && (
              <div className="connection-notice" role="status">
                {connectionNotice}
              </div>
            )}
            <div className="connection-grid">
              {(
                [
                  {
                    provider: "hubspot" as const,
                    mark: "HS",
                    name: "HubSpot",
                    copy: "Write the selected rep to the contact owner field after every route.",
                  },
                  {
                    provider: "google" as const,
                    mark: "31",
                    name: "Google Calendar",
                    copy: "Remove busy reps from the pool using a live 30-minute free/busy check.",
                  },
                  {
                    provider: "microsoft" as const,
                    mark: "MS",
                    name: "Microsoft 365",
                    copy: "Check Outlook availability through Microsoft Graph before assigning a lead.",
                  },
                ] as const
              ).map((item) => {
                const status = connection(item.provider);
                const reconnectRequired =
                  hubSpotConnectionNeedsReconnect(status);
                return (
                  <article
                    className="connection-card"
                    id={`connection-${item.provider}`}
                    key={item.provider}
                  >
                    <div className="connection-title">
                      <span
                        className={`connector-mark ${item.provider === "google" ? "calendar" : item.provider === "microsoft" ? "microsoft" : ""}`}
                      >
                        {item.mark}
                      </span>
                      <div>
                        <h3>{item.name}</h3>
                        <span
                          className={`connection-state ${reconnectRequired ? "reconnect-required" : status?.connected ? "connected" : ""}`}
                        >
                          <i />{" "}
                          {reconnectRequired
                            ? "RECONNECT REQUIRED"
                            : status?.connected
                              ? status.active
                                ? "CONNECTED · ACTIVE"
                                : "CONNECTED"
                              : "NOT CONNECTED"}
                        </span>
                      </div>
                    </div>
                    <p>{item.copy}</p>
                    {reconnectRequired ? (
                      <div className="connection-reconnect">
                        <p>
                          This connection is missing required CRM read access.
                          Reconnect it so Hot Potato can verify existing
                          ownership before assigning a lead.
                        </p>
                        {status?.configured ? (
                          <form
                            method="post"
                            action={`/api/connections/${item.provider}/start`}
                          >
                            <button type="submit">
                              Reconnect {item.name} <span>↗</span>
                            </button>
                          </form>
                        ) : (
                          <div className="setup-required">
                            <span>SETUP REQUIRED</span>
                            <b>
                              Restore OAuth credentials before reconnecting
                              HubSpot
                            </b>
                          </div>
                        )}
                      </div>
                    ) : status?.connected ? (
                      <div className="connected-account">
                        <span>AUTHORIZED ACCOUNT</span>
                        <b>
                          {status.accountName ??
                            status.accountId ??
                            "Connected"}
                        </b>
                      </div>
                    ) : status?.configured ? (
                      <form
                        method="post"
                        action={`/api/connections/${item.provider}/start`}
                      >
                        <button type="submit">
                          Connect {item.name} <span>↗</span>
                        </button>
                      </form>
                    ) : (
                      <div className="setup-required">
                        <span>SETUP REQUIRED</span>
                        <b>Add OAuth credentials to the environment</b>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>

          {dashboard && <HandoffScheduler dashboard={dashboard} />}

          <section className="router-card" id="routing-api-tester">
            <div className="card-heading">
              <div>
                <span className="section-number">02</span>
                <div>
                  <h2>Routing API tester</h2>
                  <p>Test immediate ownership and CRM writeback only.</p>
                </div>
              </div>
              <span className="live-pill">
                <i /> ENGINE READY
              </span>
            </div>
            <div className="connection-notice" role="note">
              This creates a real ownership decision for the lead at the current
              moment. It does not reserve a future time, invite the attendee, or
              write a calendar event. When HubSpot is connected, existing CRM
              ownership is resolved server-side. Use Handoff scheduler for real
              meetings.
            </div>

            <div className="router-grid">
              <form onSubmit={submit}>
                <div className="form-heading">
                  <span>RAW ROUTE REQUEST</span>
                  <small>CRM ownership is server-controlled</small>
                </div>
                <label>
                  Email
                  <input
                    type="email"
                    required
                    value={lead.email}
                    onChange={(event) =>
                      setLead({ ...lead, email: event.target.value })
                    }
                  />
                </label>
                <div className="field-row">
                  <label>
                    Employees
                    <input
                      type="number"
                      min="1"
                      required
                      value={lead.employees}
                      onChange={(event) =>
                        setLead({ ...lead, employees: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    State
                    <input
                      maxLength={2}
                      required
                      value={lead.state}
                      onChange={(event) =>
                        setLead({ ...lead, state: event.target.value })
                      }
                    />
                  </label>
                </div>
                <button
                  className="route-button"
                  type="submit"
                  disabled={routing}
                >
                  {routing ? "Routing…" : "Run ownership route"}
                  <span>↗</span>
                </button>
              </form>

              <div
                className={`route-outcome ${result ? "has-result" : ""}`}
                aria-live="polite"
              >
                {result ? (
                  <>
                    <div className="result-spark">↗</div>
                    <span className="result-label">OWNER ASSIGNED</span>
                    <h3>{result.repName}</h3>
                    <a href={`mailto:${result.repEmail}`}>{result.repEmail}</a>
                    <div className="decision-path">
                      <div>
                        <span>01</span>
                        <p>
                          <small>RULE MATCH</small>
                          <b>{result.ruleName}</b>
                        </p>
                        <i>✓</i>
                      </div>
                      <div>
                        <span>02</span>
                        <p>
                          <small>REP POOL</small>
                          <b>{result.poolName}</b>
                        </p>
                        <i>✓</i>
                      </div>
                      <div>
                        <span>03</span>
                        <p>
                          <small>AVAILABILITY</small>
                          <b>
                            {result.availabilitySource === "google_calendar"
                              ? "Google free/busy checked"
                              : result.availabilitySource ===
                                  "microsoft_calendar"
                                ? "Outlook free/busy checked"
                                : result.availabilitySource ===
                                    "connected_calendars"
                                  ? "Google + Outlook conflicts checked"
                                  : "Weekly schedule checked"}
                          </b>
                        </p>
                        <i>✓</i>
                      </div>
                      <div>
                        <span>04</span>
                        <p>
                          <small>ASSIGNMENT</small>
                          <b>
                            {result.reason === "owner_preserved"
                              ? "Owner preserved"
                              : "Weighted round robin"}
                          </b>
                        </p>
                        <i>✓</i>
                      </div>
                      <div>
                        <span>05</span>
                        <p>
                          <small>WRITEBACK</small>
                          <b>Queued for CRM adapter</b>
                        </p>
                        <i className="queued">◷</i>
                      </div>
                    </div>
                    <small className="decision-id">
                      DECISION {result.id.slice(0, 8).toUpperCase()}
                    </small>
                  </>
                ) : (
                  <div className="empty-result">
                    <img src="/hot-potato-mascot.png" alt="" />
                    <h3>Ready when the lead is.</h3>
                    <p>
                      The winning rule, pool, owner, and writeback job will
                      appear here. No meeting is created by this tester.
                    </p>
                  </div>
                )}
              </div>
            </div>
            {error && (
              <div className="error-banner" role="alert">
                {error}
              </div>
            )}
          </section>

          {canAdmin && dashboard && (
            <RoutingStudio dashboard={dashboard} onRefresh={loadDashboard} />
          )}

          {canAdmin && dashboard && (
            <SmartRouterSettings
              dashboard={dashboard}
              onRefresh={loadDashboard}
            />
          )}

          {canAdmin && dashboard && (
            <FormBridgeSettings
              dashboard={dashboard}
              onRefresh={loadDashboard}
            />
          )}

          <div className="detail-grid">
            <section className="detail-card" id="rule-summary">
              <div className="card-heading compact">
                <div>
                  <span className="section-number">09</span>
                  <div>
                    <h2>Active rules</h2>
                    <p>First match wins.</p>
                  </div>
                </div>
                <span className="count-badge">
                  {dashboard?.rules.filter((rule) => rule.active).length ?? 0}
                </span>
              </div>
              <div className="rule-list">
                {dashboard?.rules
                  .filter((rule) => rule.active)
                  .map((rule) => (
                    <article key={rule.id}>
                      <span className="priority">P{rule.priority}</span>
                      <div>
                        <h3>{rule.name}</h3>
                        <RuleConditions conditions={rule.conditions} />
                        <small>
                          Routes to <b>{rule.poolName}</b>
                        </small>
                      </div>
                      <span className="enabled">ACTIVE</span>
                    </article>
                  ))}
                {!dashboard && (
                  <div className="loading-line">
                    {loading ? "Loading rules…" : "No rules found"}
                  </div>
                )}
              </div>
            </section>

            <section
              className="detail-card"
              id="calendar-readiness"
              hidden={!canAdmin}
            >
              <div className="card-heading compact">
                <div>
                  <span className="section-number">10</span>
                  <div>
                    <h2>Calendar readiness</h2>
                    <p>
                      Check the rep&apos;s connected Google and Outlook
                      calendars, then choose the one that receives bookings.
                    </p>
                  </div>
                </div>
              </div>
              <div className="calendar-explainer">
                <b>One booking calendar. Both provider calendars.</b>
                <span>
                  Google and Outlook can both block a time. The booking calendar
                  is where Hot Potato creates the event and video link.
                </span>
              </div>
              {calendarNotice && (
                <p
                  className={`calendar-notice ${calendarNotice.tone}`}
                  role={calendarNotice.tone === "error" ? "alert" : "status"}
                >
                  {calendarNotice.message}
                </p>
              )}
              {!dashboard && (
                <div className="loading-line" role="status" aria-live="polite">
                  {loading
                    ? "Loading calendar readiness…"
                    : "Calendar readiness is unavailable."}
                </div>
              )}
              {dashboard?.pools.map((pool) => (
                <div className="pool" key={pool.id}>
                  <div className="pool-heading">
                    <div>
                      <h3>{pool.name}</h3>
                      <span>{pool.strategy.replaceAll("_", " ")}</span>
                    </div>
                    <b>{pool.members.length} reps</b>
                  </div>
                  <div className="rep-list">
                    {pool.members.map((rep) => (
                      <div key={rep.email}>
                        <span className="rep-avatar">
                          {rep.name
                            .split(" ")
                            .map((part) => part[0])
                            .join("")}
                        </span>
                        <p>
                          <b>{rep.name}</b>
                          <small>
                            {rep.assignments} assignments · {rep.weight}× weight
                          </small>
                          <small className="rep-calendar connected">
                            {selectedCalendarCount(rep)} calendar
                            {selectedCalendarCount(rep) === 1 ? "" : "s"}{" "}
                            selected
                          </small>
                        </p>
                        <div className="rep-controls">
                          <div
                            className="rep-calendar-settings"
                            aria-label={`${rep.name} calendar settings`}
                            role="group"
                          >
                            {(
                              [
                                {
                                  provider: "google" as const,
                                  label: "Google",
                                  calendar: rep.googleCalendar,
                                },
                                {
                                  provider: "microsoft" as const,
                                  label: "Outlook",
                                  calendar: rep.microsoftCalendar,
                                },
                              ] as const
                            ).map(({ provider, label, calendar }) => {
                              if (!calendar.connected) return null;
                              const active =
                                rep.activeCalendarProvider === provider;
                              const key = `${rep.id}:${provider}`;
                              const action =
                                calendarAction?.key === key
                                  ? calendarAction.kind
                                  : null;
                              const busy = calendarAction !== null;
                              const selectedIds = calendarSelectionIds(
                                calendar,
                                active,
                              );
                              const availableDefault = calendar.calendars.find(
                                (item) => item.isDefault && item.available,
                              );
                              return (
                                <div
                                  className={`rep-calendar-option${active ? " active" : ""}`}
                                  key={provider}
                                  aria-busy={action !== null}
                                  aria-label={`${label} calendar connection`}
                                  role="group"
                                >
                                  <div className="calendar-provider-header">
                                    <div className="calendar-provider-identity">
                                      <b>{label}</b>
                                      <small title={calendar.accountName ?? ""}>
                                        {calendar.accountName ?? "Connected"}
                                      </small>
                                    </div>
                                    <div className="calendar-provider-actions">
                                      {active ? (
                                        <span className="booking-provider-badge">
                                          Booking provider
                                        </span>
                                      ) : (
                                        <button
                                          className="booking-provider-action"
                                          type="button"
                                          disabled={
                                            busy ||
                                            !calendar.canSyncCalendars ||
                                            !availableDefault
                                          }
                                          onClick={() =>
                                            void updateRepCalendar(
                                              rep.id,
                                              provider,
                                              availableDefault
                                                ? [
                                                    ...new Set([
                                                      ...selectedIds,
                                                      availableDefault.calendarId,
                                                    ]),
                                                  ]
                                                : selectedIds,
                                              true,
                                            )
                                          }
                                        >
                                          {action === "activate"
                                            ? "Switching…"
                                            : "Use for bookings"}
                                        </button>
                                      )}
                                      {calendar.canSyncCalendars && (
                                        <button
                                          className="calendar-refresh-action"
                                          type="button"
                                          disabled={busy}
                                          onClick={() =>
                                            void refreshRepCalendars(
                                              rep.id,
                                              provider,
                                            )
                                          }
                                        >
                                          {action === "refresh"
                                            ? "Refreshing…"
                                            : "Refresh calendars"}
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                  <div className="calendar-catalog-meta">
                                    <span>{selectedIds.length} selected</span>
                                    <span aria-hidden="true">·</span>
                                    {calendar.calendarCatalogSyncedAt ? (
                                      <time
                                        dateTime={
                                          calendar.calendarCatalogSyncedAt
                                        }
                                      >
                                        {calendarSyncLabel(
                                          calendar.calendarCatalogSyncedAt,
                                        )}
                                      </time>
                                    ) : (
                                      <span>{calendarSyncLabel(null)}</span>
                                    )}
                                    {action && (
                                      <span
                                        className="calendar-action-status"
                                        role="status"
                                      >
                                        {action === "refresh"
                                          ? "Refreshing calendar list…"
                                          : action === "activate"
                                            ? "Changing booking provider…"
                                            : "Saving selection…"}
                                      </span>
                                    )}
                                  </div>
                                  {!calendar.canSyncCalendars && (
                                    <div
                                      className="calendar-reconnect-callout"
                                      role="status"
                                    >
                                      <p>
                                        <b>
                                          Reconnect {label} to sync named
                                          calendars.
                                        </b>
                                        <span>
                                          {provider === "google"
                                            ? "Google was connected without the calendar-list permission Hot Potato now needs. Reconnecting adds that permission without changing the rep’s booking link."
                                            : "Reconnect Outlook so Hot Potato can load and refresh this account’s calendar list."}
                                        </span>
                                      </p>
                                      <form
                                        className={`rep-connect-form calendar-reconnect-form${provider === "google" ? " google" : ""}`}
                                        method="post"
                                        action={`/api/reps/${rep.id}/connections/${provider}/start`}
                                      >
                                        <button type="submit">
                                          Reconnect {label}
                                        </button>
                                      </form>
                                    </div>
                                  )}
                                  {calendar.calendarCatalogError && (
                                    <p
                                      className="calendar-catalog-error"
                                      role="alert"
                                    >
                                      {calendar.calendarCatalogError}
                                    </p>
                                  )}
                                  <fieldset className="calendar-source-list">
                                    <legend>Conflict calendars</legend>
                                    {calendar.calendars.length === 0 ? (
                                      <p className="calendar-source-empty">
                                        {calendar.canSyncCalendars
                                          ? "No calendars loaded yet. Refresh to choose calendars."
                                          : "Reconnect this provider to load its calendars."}
                                      </p>
                                    ) : (
                                      calendar.calendars.map(
                                        (source, calendarIndex) => {
                                          const locked =
                                            active && source.isDefault;
                                          const selected =
                                            source.selected || locked;
                                          const unavailable = !source.available;
                                          const description = unavailable
                                            ? selected
                                              ? locked
                                                ? "Unavailable, but required while this is the booking provider. Reconnect it or choose another booking provider."
                                                : "Unavailable, but still selected. Uncheck it or reconnect the calendar."
                                              : "Unavailable in the connected account and cannot be selected."
                                            : locked
                                              ? "Required while this is the booking provider."
                                              : null;
                                          const descriptionId = description
                                            ? `calendar-state-${rep.id}-${provider}-${calendarIndex}`
                                            : undefined;
                                          return (
                                            <label
                                              className={`calendar-source-row${unavailable ? " unavailable" : ""}${locked ? " locked" : ""}${unavailable && !selected ? " disabled" : ""}`}
                                              key={source.calendarId}
                                            >
                                              <input
                                                type="checkbox"
                                                checked={selected}
                                                disabled={
                                                  busy ||
                                                  locked ||
                                                  (unavailable && !selected)
                                                }
                                                aria-describedby={descriptionId}
                                                onChange={(event) => {
                                                  const nextSelected = new Set(
                                                    selectedIds,
                                                  );
                                                  if (event.target.checked) {
                                                    nextSelected.add(
                                                      source.calendarId,
                                                    );
                                                  } else {
                                                    nextSelected.delete(
                                                      source.calendarId,
                                                    );
                                                  }
                                                  void updateRepCalendar(
                                                    rep.id,
                                                    provider,
                                                    [...nextSelected],
                                                  );
                                                }}
                                              />
                                              <span className="calendar-source-copy">
                                                <span className="calendar-source-title">
                                                  <b>
                                                    {source.name ||
                                                      source.calendarId}
                                                  </b>
                                                  {source.isDefault && (
                                                    <span>Default</span>
                                                  )}
                                                  {unavailable && (
                                                    <span className="warning">
                                                      Missing
                                                    </span>
                                                  )}
                                                </span>
                                                {description && (
                                                  <small id={descriptionId}>
                                                    {description}
                                                  </small>
                                                )}
                                              </span>
                                            </label>
                                          );
                                        },
                                      )
                                    )}
                                  </fieldset>
                                  {!active &&
                                    calendar.canSyncCalendars &&
                                    !availableDefault && (
                                      <p className="calendar-booking-hint">
                                        Refresh this provider before using it
                                        for bookings.
                                      </p>
                                    )}
                                </div>
                              );
                            })}
                          </div>
                          {rep.activeCalendarProvider && (
                            <div className="rep-actions">
                              <span className="rep-connected">✓ LIVE LINK</span>
                              <a
                                href={`/schedule/${dashboard.organization.slug}/${rep.schedulingSlug}`}
                                target="_blank"
                                rel="noreferrer"
                              >
                                Preview
                              </a>
                              <button
                                type="button"
                                onClick={() =>
                                  void copyScheduleLink(
                                    `/schedule/${dashboard.organization.slug}/${rep.schedulingSlug}`,
                                  )
                                }
                              >
                                {copiedSchedule ===
                                `/schedule/${dashboard.organization.slug}/${rep.schedulingSlug}`
                                  ? "Copied ✓"
                                  : copiedSchedule === "copy-error"
                                    ? "Copy failed"
                                    : "Copy link"}
                              </button>
                            </div>
                          )}
                          {!rep.googleCalendar.connected && (
                            <form
                              className="rep-connect-form google"
                              method="post"
                              action={`/api/reps/${rep.id}/connections/google/start`}
                            >
                              <button type="submit">Connect Google</button>
                            </form>
                          )}
                          {!rep.microsoftCalendar.connected && (
                            <form
                              className="rep-connect-form"
                              method="post"
                              action={`/api/reps/${rep.id}/connections/microsoft/start`}
                            >
                              <button type="submit">Connect Outlook</button>
                            </form>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          </div>

          {canAdmin && dashboard && (
            <EmailToolsSettings reps={dashboard.reps} />
          )}

          {canAdmin && dashboard && (
            <SchedulingSettings
              dashboard={dashboard}
              onRefresh={loadDashboard}
            />
          )}

          {operator && <MyCalendar login={operator.login} />}

          <section className="activity-card" id="activity">
            <div className="card-heading compact">
              <div>
                <span className="section-number">14</span>
                <div>
                  <h2>Recent routes</h2>
                  <p>A durable explanation for every assignment.</p>
                </div>
              </div>
              <button type="button" onClick={() => void loadDashboard()}>
                Refresh
              </button>
            </div>
            <div className="activity-table">
              <div className="table-head">
                <span>LEAD</span>
                <span>RULE</span>
                <span>OWNER</span>
                <span>WRITEBACK</span>
                <span>TIME</span>
              </div>
              {dashboard?.decisions.map((decision) => (
                <div className="table-row" key={decision.id}>
                  <span>
                    <b>{decision.leadEmail}</b>
                    <small>{decision.id.slice(0, 8)}</small>
                  </span>
                  <span>{decision.ruleName}</span>
                  <span>{decision.repName}</span>
                  <span>
                    <i className={`job-status ${decision.writebackStatus}`} />
                    {decision.writebackStatus}
                  </span>
                  <span>{formatTime(decision.createdAt)}</span>
                </div>
              ))}
              {dashboard?.decisions.length === 0 && (
                <div className="empty-table">
                  No routes yet. Send the first lead above.
                </div>
              )}
            </div>
          </section>

          {operator && (
            <AccountSecurity
              displayName={operator.displayName}
              login={operator.login}
            />
          )}

          <footer>
            <span>HOT POTATO / OPEN-SOURCE INBOUND ROUTING</span>
            <a
              href="https://github.com/harrisonoconnorhover/hot-potato"
              target="_blank"
              rel="noreferrer"
            >
              AGPL-3.0 · View source ↗
            </a>
          </footer>
        </div>
      </main>
    </div>
  );
}
