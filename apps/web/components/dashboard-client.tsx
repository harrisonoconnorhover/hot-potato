"use client";

import type { Dashboard, RouteDecision } from "@hot-potato/db";
import { useCallback, useEffect, useState, type FormEvent } from "react";

type LeadForm = {
  email: string;
  employees: string;
  state: string;
  owner: string;
};

const initialLead: LeadForm = {
  email: "maya@northstarlabs.example",
  employees: "820",
  state: "NY",
  owner: "",
};

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
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
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [routing, setRouting] = useState(false);

  const loadDashboard = useCallback(async () => {
    const response = await fetch("/api/dashboard", { cache: "no-store" });
    if (!response.ok)
      throw new Error("The routing workspace could not be loaded.");
    setDashboard((await response.json()) as Dashboard);
  }, []);

  useEffect(() => {
    loadDashboard()
      .catch((caught: unknown) =>
        setError(
          caught instanceof Error ? caught.message : "Something went wrong.",
        ),
      )
      .finally(() => setLoading(false));
  }, [loadDashboard]);

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
          ...(lead.owner ? { current_owner_email: lead.owner } : {}),
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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#top" aria-label="Hot Potato workspace home">
          <img src="/hot-potato-mascot.png" alt="" />
          <span>HOT POTATO</span>
        </a>
        <nav aria-label="Workspace navigation">
          <a className="active" href="#overview">
            <span>⌁</span>Overview
          </a>
          <a href="#router">
            <span>↗</span>Router
          </a>
          <a href="#rules">
            <span>⌘</span>Rules
          </a>
          <a href="#pools">
            <span>◎</span>Rep pools
          </a>
          <a href="#activity">
            <span>≡</span>Route log
          </a>
        </nav>
        <div className="sidebar-section">
          <div className="sidebar-label">CONNECTIONS</div>
          <div className="connection">
            <span className="connector-mark">HS</span>
            <div>
              <b>HubSpot</b>
              <small>Not connected</small>
            </div>
          </div>
          <div className="connection">
            <span className="connector-mark calendar">31</span>
            <div>
              <b>Google Calendar</b>
              <small>Not connected</small>
            </div>
          </div>
        </div>
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
            <b>{dashboard?.organization.name ?? "Routing workspace"}</b>
            <span className="slash">/</span>
            <span>Overview</span>
          </div>
          <div className="topbar-actions">
            <span className="system-status">
              <i /> Routing online
            </span>
            <button type="button" className="icon-button" aria-label="Help">
              ?
            </button>
            <span className="avatar">HO</span>
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

          <section className="router-card" id="router">
            <div className="card-heading">
              <div>
                <span className="section-number">01</span>
                <div>
                  <h2>Route a lead</h2>
                  <p>Run a real decision through the configured rules.</p>
                </div>
              </div>
              <span className="live-pill">
                <i /> ENGINE READY
              </span>
            </div>

            <div className="router-grid">
              <form onSubmit={submit}>
                <div className="form-heading">
                  <span>INCOMING LEAD</span>
                  <small>All fields map to routing context</small>
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
                <label>
                  Current owner <em>optional</em>
                  <input
                    type="email"
                    placeholder="owner@acme.example"
                    value={lead.owner}
                    onChange={(event) =>
                      setLead({ ...lead, owner: event.target.value })
                    }
                  />
                </label>
                <button
                  className="route-button"
                  type="submit"
                  disabled={routing}
                >
                  {routing ? "Routing…" : "Run route"}
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
                    <span className="result-label">ROUTED SUCCESSFULLY</span>
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
                        <span>04</span>
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
                      The winning rule, pool, rep, and writeback job will appear
                      here.
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

          <div className="detail-grid">
            <section className="detail-card" id="rules">
              <div className="card-heading compact">
                <div>
                  <span className="section-number">02</span>
                  <div>
                    <h2>Active rules</h2>
                    <p>First match wins.</p>
                  </div>
                </div>
                <span className="count-badge">
                  {dashboard?.rules.length ?? 0}
                </span>
              </div>
              <div className="rule-list">
                {dashboard?.rules.map((rule) => (
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

            <section className="detail-card" id="pools">
              <div className="card-heading compact">
                <div>
                  <span className="section-number">03</span>
                  <div>
                    <h2>Rep pools</h2>
                    <p>Capacity at a glance.</p>
                  </div>
                </div>
              </div>
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
                        </p>
                        <i className={rep.active ? "available" : ""} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          </div>

          <section className="activity-card" id="activity">
            <div className="card-heading compact">
              <div>
                <span className="section-number">04</span>
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
