"use client";

import type {
  BookingAttendanceOutcome,
  ReportingRangeDays,
  ReportingSnapshot,
} from "@hot-potato/db";
import { useCallback, useEffect, useState } from "react";
import { reportingRanges } from "../app/reporting";

function formatMoment(value: string | null): string {
  if (!value) return "No activity yet";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function rangeLabel(days: ReportingRangeDays): string {
  if (days === 1) return "24 hours";
  return `${days} days`;
}

function providerLabel(provider: "google" | "microsoft"): string {
  return provider === "google" ? "Google Calendar" : "Outlook";
}

function sourceLabel(
  source: ReportingSnapshot["recentMeetings"][number]["source"],
): string {
  if (source === "smart_router") return "Smart Router / Handoff";
  if (source === "routing_api") return "Routing API";
  return "Scheduling link";
}

function attendanceLabel(outcome: BookingAttendanceOutcome): string {
  if (outcome === "no_show") return "No-show";
  if (outcome === "attended") return "Attended";
  return "Not recorded";
}

export function ReportingView({
  snapshot,
  updatingBookingId,
  onAttendance,
}: {
  snapshot: ReportingSnapshot;
  updatingBookingId: string | null;
  onAttendance: (bookingId: string, outcome: BookingAttendanceOutcome) => void;
}) {
  const attentionCount =
    snapshot.bookingHealth.failed + snapshot.bookingHealth.inProgress;
  const generatedAt = new Date(snapshot.generatedAt).getTime();

  return (
    <>
      <div className="reporting-summary" aria-label="Conversion summary">
        <article className="reporting-kpi featured">
          <span>ROUTER CONVERSION</span>
          <strong>{snapshot.funnel.conversionRate}%</strong>
          <small>
            {snapshot.funnel.bookings} booked from {snapshot.funnel.submissions}{" "}
            submissions
          </small>
        </article>
        <article className="reporting-kpi">
          <span>QUALIFIED</span>
          <strong>{snapshot.funnel.qualified}</strong>
          <small>{snapshot.funnel.noMatch} did not match a route</small>
        </article>
        <article className="reporting-kpi">
          <span>ALL MEETINGS</span>
          <strong>{snapshot.bookingHealth.total}</strong>
          <small>{snapshot.bookingHealth.confirmed} confirmed</small>
        </article>
        <article
          className={`reporting-kpi${attentionCount > 0 ? " warning" : ""}`}
        >
          <span>DELIVERY WATCH</span>
          <strong>{attentionCount}</strong>
          <small>
            {snapshot.bookingHealth.failed} failed ·{" "}
            {snapshot.bookingHealth.inProgress} in progress
          </small>
        </article>
      </div>

      <div className="reporting-funnel" aria-label="Smart Router funnel">
        {[
          ["Submitted", snapshot.funnel.submissions, 100],
          [
            "Qualified",
            snapshot.funnel.qualified,
            snapshot.funnel.submissions > 0
              ? (snapshot.funnel.qualified / snapshot.funnel.submissions) * 100
              : 0,
          ],
          [
            "Booked",
            snapshot.funnel.bookings,
            snapshot.funnel.submissions > 0
              ? (snapshot.funnel.bookings / snapshot.funnel.submissions) * 100
              : 0,
          ],
        ].map(([label, value, width]) => (
          <div className="funnel-step" key={label}>
            <span>
              <b>{label}</b>
              <strong>{value}</strong>
            </span>
            <i>
              <span style={{ width: `${Math.max(Number(width), 2)}%` }} />
            </i>
          </div>
        ))}
      </div>

      <div className="reporting-grid">
        <section className="reporting-panel">
          <div className="reporting-panel-heading">
            <div>
              <span>SMART LINK PERFORMANCE</span>
              <h3>Where qualified buyers convert</h3>
            </div>
          </div>
          <div className="reporting-table router-report-table">
            <div className="reporting-table-head">
              <span>ROUTER</span>
              <span>SUBMITTED</span>
              <span>QUALIFIED</span>
              <span>BOOKED</span>
              <span>CONVERSION</span>
            </div>
            {snapshot.routerLinks.map((router) => (
              <div className="reporting-table-row" key={router.id}>
                <span>
                  <b>{router.name}</b>
                  <small>
                    {router.active ? "Live" : "Paused"} ·{" "}
                    {formatMoment(router.lastActivityAt)}
                  </small>
                </span>
                <span>{router.submissions}</span>
                <span>{router.qualified}</span>
                <span>{router.bookings}</span>
                <span>
                  <b>{router.conversionRate}%</b>
                </span>
              </div>
            ))}
            {snapshot.routerLinks.length === 0 && (
              <p className="reporting-empty">
                Publish a Smart Router Link to begin measuring conversion.
              </p>
            )}
          </div>
        </section>

        <section className="reporting-panel">
          <div className="reporting-panel-heading">
            <div>
              <span>REP DISTRIBUTION</span>
              <h3>Routing share and meeting outcomes</h3>
            </div>
          </div>
          <div className="reporting-table rep-report-table">
            <div className="reporting-table-head">
              <span>REP</span>
              <span>ROUTES</span>
              <span>SHARE</span>
              <span>MEETINGS</span>
              <span>OUTCOMES</span>
            </div>
            {snapshot.reps.map((rep) => (
              <div className="reporting-table-row" key={rep.id}>
                <span>
                  <b>{rep.name}</b>
                  <small>{rep.active ? "Active" : "Inactive"}</small>
                </span>
                <span>{rep.routes}</span>
                <span>{rep.routeShare}%</span>
                <span>{rep.meetings}</span>
                <span>
                  <b>{rep.confirmed} confirmed</b>
                  <small>
                    {rep.cancelled} cancelled · {rep.noShows} no-show
                  </small>
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="delivery-panel">
        <div className="reporting-panel-heading">
          <div>
            <span>CALENDAR DELIVERY</span>
            <h3>Google and Outlook lifecycle health</h3>
          </div>
          <small>Current state of meetings created in this range</small>
        </div>
        <div className="delivery-grid">
          {snapshot.calendarDelivery.map((delivery) => (
            <article className="delivery-card" key={delivery.provider}>
              <div>
                <span className={`provider-orb ${delivery.provider}`}>
                  {delivery.provider === "google" ? "31" : "MS"}
                </span>
                <p>
                  <b>{providerLabel(delivery.provider)}</b>
                  <small>{delivery.total} meeting records</small>
                </p>
              </div>
              <dl>
                <div>
                  <dt>Confirmed</dt>
                  <dd>{delivery.confirmed}</dd>
                </div>
                <div>
                  <dt>In progress</dt>
                  <dd>{delivery.inProgress}</dd>
                </div>
                <div className={delivery.failed > 0 ? "danger" : ""}>
                  <dt>Failed</dt>
                  <dd>{delivery.failed}</dd>
                </div>
                <div>
                  <dt>Cancelled</dt>
                  <dd>{delivery.cancelled}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <section className="meeting-activity-panel">
        <div className="reporting-panel-heading">
          <div>
            <span>MEETING ACTIVITY</span>
            <h3>Recent bookings and attendance</h3>
          </div>
          <small>{snapshot.bookingHealth.noShows} no-shows in range</small>
        </div>
        <div className="meeting-activity-list">
          {snapshot.recentMeetings.map((meeting) => {
            const canRecordAttendance =
              meeting.status === "confirmed" &&
              new Date(meeting.endsAt).getTime() <= generatedAt;
            const busy = updatingBookingId === meeting.id;
            return (
              <article className="meeting-activity-row" key={meeting.id}>
                <div className="meeting-identity">
                  <span className={`meeting-status ${meeting.status}`}>
                    {meeting.status.replaceAll("_", " ")}
                  </span>
                  <p>
                    <b>{meeting.meetingTitle}</b>
                    <small>
                      {meeting.attendeeName} · {meeting.attendeeEmail}
                    </small>
                  </p>
                </div>
                <div className="meeting-owner">
                  <b>{meeting.repName}</b>
                  <small>
                    {providerLabel(meeting.calendarProvider)} ·{" "}
                    {sourceLabel(meeting.source)}
                  </small>
                </div>
                <div className="meeting-time">
                  <b>{formatMoment(meeting.startsAt)}</b>
                  <small>{attendanceLabel(meeting.attendanceOutcome)}</small>
                </div>
                <div className="attendance-actions">
                  {canRecordAttendance ? (
                    <>
                      <button
                        type="button"
                        disabled={busy}
                        aria-pressed={meeting.attendanceOutcome === "attended"}
                        onClick={() => onAttendance(meeting.id, "attended")}
                      >
                        Attended
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        aria-pressed={meeting.attendanceOutcome === "no_show"}
                        onClick={() => onAttendance(meeting.id, "no_show")}
                      >
                        No-show
                      </button>
                      {meeting.attendanceOutcome !== "unknown" && (
                        <button
                          className="clear-attendance"
                          type="button"
                          disabled={busy}
                          onClick={() => onAttendance(meeting.id, "unknown")}
                        >
                          Clear
                        </button>
                      )}
                    </>
                  ) : (
                    <span>
                      {busy ? "Saving…" : "Outcome available after meeting"}
                    </span>
                  )}
                </div>
              </article>
            );
          })}
          {snapshot.recentMeetings.length === 0 && (
            <p className="reporting-empty">
              No meetings were created in this range.
            </p>
          )}
        </div>
      </section>
    </>
  );
}

export function ReportingDashboard() {
  const [rangeDays, setRangeDays] = useState<ReportingRangeDays>(7);
  const [snapshot, setSnapshot] = useState<ReportingSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updatingBookingId, setUpdatingBookingId] = useState<string | null>(
    null,
  );

  const loadReport = useCallback(async (days: ReportingRangeDays) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/reporting?days=${days}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as
        | ReportingSnapshot
        | { error: string };
      if (!response.ok) {
        throw new Error(
          "error" in body ? body.error : "Reporting could not be loaded.",
        );
      }
      setSnapshot(body as ReportingSnapshot);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Reporting could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadReport(rangeDays);
  }, [loadReport, rangeDays]);

  async function updateAttendance(
    bookingId: string,
    outcome: BookingAttendanceOutcome,
  ) {
    setUpdatingBookingId(bookingId);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/reporting/attendance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookingId, outcome }),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? "Attendance could not be updated.");
      }
      setNotice(
        outcome === "unknown" ? "Attendance cleared." : "Attendance saved.",
      );
      await loadReport(rangeDays);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Attendance could not be updated.",
      );
    } finally {
      setUpdatingBookingId(null);
    }
  }

  return (
    <section className="reporting-card" id="reporting">
      <div className="card-heading reporting-heading">
        <div>
          <span className="section-number">R1</span>
          <div>
            <h2>Routing &amp; meeting reporting</h2>
            <p>
              Conversion, distribution, delivery, and outcomes in one place.
            </p>
          </div>
        </div>
        <div className="reporting-range" aria-label="Reporting timeframe">
          {reportingRanges.map((days) => (
            <button
              type="button"
              key={days}
              aria-pressed={rangeDays === days}
              onClick={() => setRangeDays(days)}
            >
              {rangeLabel(days)}
            </button>
          ))}
        </div>
      </div>
      {notice && (
        <div className="reporting-notice success" role="status">
          {notice}
        </div>
      )}
      {loading && snapshot && (
        <div className="reporting-notice refreshing" role="status">
          Refreshing the {rangeLabel(rangeDays)} view…
        </div>
      )}
      {error && (
        <div className="reporting-notice error" role="alert">
          {error}
        </div>
      )}
      {loading && !snapshot ? (
        <div className="reporting-loading">Building the reporting view…</div>
      ) : snapshot ? (
        <ReportingView
          snapshot={snapshot}
          updatingBookingId={updatingBookingId}
          onAttendance={(bookingId, outcome) =>
            void updateAttendance(bookingId, outcome)
          }
        />
      ) : null}
    </section>
  );
}
