"use client";

import type {
  PublicScheduleView,
  SerializedSchedulingSlot,
} from "../app/public-scheduling";
import { fetchBookingJson } from "./booking-fetch";
import { AdditionalGuests } from "./additional-guests";
import {
  bookingStatusIsProcessing,
  slotFromBookingStatus,
} from "./booking-status";
import {
  parseSchedulingRecovery,
  readSchedulingStatus,
  schedulingRecoveryKey,
  schedulingRejectionMayUnlock,
  submitSchedulingRequest,
  type SchedulingRecovery,
} from "./scheduling-recovery";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

type BookingStatus =
  | "attempting"
  | "pending"
  | "confirmed"
  | "reschedule_pending"
  | "cancel_pending"
  | "cancelled"
  | "failed";

function dateKey(value: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dayLabel(value: string): { weekday: string; date: string } {
  const date = new Date(value);
  return {
    weekday: new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
      date,
    ),
    date: new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(date),
  };
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function longDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

export function SchedulingClient({
  schedule,
  suggestedTime,
}: {
  schedule: PublicScheduleView;
  suggestedTime: string | null;
}) {
  const [slots, setSlots] = useState<SerializedSchedulingSlot[]>([]);
  const [activeDay, setActiveDay] = useState("");
  const [selected, setSelected] = useState<SerializedSchedulingSlot | null>(
    null,
  );
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [additionalAttendeeEmails, setAdditionalAttendeeEmails] = useState<
    string[]
  >([]);
  const [website, setWebsite] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState<BookingStatus | null>(null);
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [retryOriginal, setRetryOriginal] = useState(false);
  const requestRef = useRef<SchedulingRecovery | null>(null);
  const submittingRef = useRef(false);
  const recoveryKey = schedulingRecoveryKey(
    schedule.organizationSlug,
    schedule.schedulingSlug,
  );

  function rememberRequest(value: SchedulingRecovery | null) {
    requestRef.current = value;
    setBookingId(value?.request.externalId ?? null);
    try {
      if (value) sessionStorage.setItem(recoveryKey, JSON.stringify(value));
      else sessionStorage.removeItem(recoveryKey);
    } catch {
      // The current tab still keeps the same request when browser storage is unavailable.
    }
  }
  const [managePath, setManagePath] = useState<string | null>(null);
  const [conferenceUrl, setConferenceUrl] = useState<string | null>(null);
  const [bookedRepName, setBookedRepName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recipientTimezone, setRecipientTimezone] = useState("your timezone");
  const [suggestionNotice, setSuggestionNotice] = useState<
    "available" | "stale" | null
  >(null);
  const conferenceName =
    schedule.conferenceProvider === "google_meet"
      ? "Google Meet"
      : schedule.conferenceProvider === "microsoft_teams"
        ? "Microsoft Teams"
        : schedule.conferenceProvider === "zoom"
          ? "Zoom"
          : "Calendar invitation";

  const loadSlots = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        organization: schedule.organizationSlug,
        rep: schedule.schedulingSlug,
      });
      const response = await fetchBookingJson<{
        slots?: SerializedSchedulingSlot[];
        error?: string;
      }>(`/api/scheduling/availability?${query}`, { cache: "no-store" });
      const body = response.body;
      if (!response.ok || !body.slots) {
        throw new Error(body.error ?? "Available times could not be loaded.");
      }
      setSlots(body.slots);
      const suggested = suggestedTime
        ? body.slots.find((slot) => slot.startsAt === suggestedTime)
        : undefined;
      if (suggested) {
        setActiveDay(dateKey(suggested.startsAt));
        setSelected(suggested);
        setSuggestionNotice("available");
      } else if (suggestedTime) {
        setSelected(null);
        setSuggestionNotice("stale");
        if (body.slots[0]) setActiveDay(dateKey(body.slots[0].startsAt));
      } else if (body.slots[0]) {
        setActiveDay((current) => current || dateKey(body.slots![0]!.startsAt));
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Available times could not be loaded.",
      );
      setSlots([]);
    } finally {
      setLoading(false);
    }
  }, [schedule.organizationSlug, schedule.schedulingSlug, suggestedTime]);

  useEffect(() => {
    setRecipientTimezone(
      Intl.DateTimeFormat().resolvedOptions().timeZone || "your timezone",
    );
    let recovered: SchedulingRecovery | null = null;
    try {
      recovered = parseSchedulingRecovery(
        sessionStorage.getItem(recoveryKey),
        schedule.organizationSlug,
        schedule.schedulingSlug,
      );
    } catch {
      // Storage can be disabled without preventing a new booking.
    }
    if (recovered) {
      rememberRequest(recovered);
      setSelected({
        startsAt: recovered.request.startsAt,
        endsAt: recovered.endsAt,
      });
      setName(recovered.request.attendeeName);
      setEmail(recovered.request.attendeeEmail);
      setAdditionalAttendeeEmails(recovered.request.additionalAttendeeEmails);
      setLoading(false);
      void checkRequest(recovered, false);
    } else {
      void loadSlots();
    }
  }, [loadSlots, recoveryKey]);

  const days = useMemo(() => {
    const groups = new Map<string, SerializedSchedulingSlot[]>();
    for (const slot of slots) {
      const key = dateKey(slot.startsAt);
      const group = groups.get(key) ?? [];
      group.push(slot);
      groups.set(key, group);
    }
    return [...groups.entries()];
  }, [slots]);

  async function checkRequest(
    recovery: SchedulingRecovery,
    sendOriginal: boolean,
  ) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    setRetryOriginal(false);
    if (sendOriginal) rememberRequest({ ...recovery, submitted: true });
    try {
      const response = sendOriginal
        ? await submitSchedulingRequest(recovery.request)
        : await readSchedulingStatus(recovery.request);
      const body = response.body;
      if (!response.ok || !body.status) {
        if (!sendOriginal && response.status === 404) {
          setRetryOriginal(true);
          setError(
            "Your original request has not appeared yet. You can retry that exact request safely; the time and details stay unchanged.",
          );
        } else if (
          sendOriginal &&
          schedulingRejectionMayUnlock(recovery, response.status)
        ) {
          rememberRequest(null);
          setSelected(null);
          setStatus(null);
          await loadSlots();
          setError(
            body.error ??
              "That request could not be accepted. Choose an available time to continue.",
          );
        } else {
          setError(
            "The booking result is uncertain. Keep checking this same request, or contact the organizer if its status cannot be resolved.",
          );
        }
        return;
      }

      function applyStatus(value: typeof body) {
        if (value.status) setStatus(value.status);
        setManagePath(value.managePath ?? null);
        setConferenceUrl(value.conferenceUrl ?? null);
        setBookedRepName(value.repName ?? null);
        const authoritativeSlot = slotFromBookingStatus(value);
        if (authoritativeSlot) setSelected(authoritativeSlot);
        if (value.status === "failed") {
          setError(
            value.error ??
              "The calendar result is uncertain. Keep this booking and use its recovery link.",
          );
        }
      }
      let current = body.status;
      applyStatus(body);
      for (
        let attempt = 0;
        attempt < 20 && bookingStatusIsProcessing(current);
        attempt += 1
      ) {
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        const statusResponse = await readSchedulingStatus(recovery.request);
        if (!statusResponse.ok) break;
        const statusBody = statusResponse.body;
        if (!statusBody.status) break;
        current = statusBody.status;
        applyStatus(statusBody);
      }
      if (bookingStatusIsProcessing(current)) {
        setError(
          "Your calendar result is still being verified. Check this same booking again—Hot Potato will not create a duplicate.",
        );
      } else if (current === "cancelled") {
        rememberRequest(null);
        await loadSlots();
        setSelected(null);
        setStatus(null);
        setError(
          "This booking is safely closed. Choose a live time to schedule another meeting.",
        );
      }
    } catch {
      setError(
        "We lost contact while checking your booking. Your original request was kept; check its status before choosing another time.",
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || submittingRef.current) return;
    const existing = requestRef.current;
    const recovery: SchedulingRecovery = existing ?? {
      version: 1,
      submitted: false,
      request: {
        organizationSlug: schedule.organizationSlug,
        schedulingSlug: schedule.schedulingSlug,
        externalId: crypto.randomUUID(),
        startsAt: selected.startsAt,
        attendeeName: name,
        attendeeEmail: email,
        additionalAttendeeEmails: [...additionalAttendeeEmails],
        website,
      },
      endsAt: selected.endsAt,
    };
    rememberRequest(recovery);
    await checkRequest(recovery, !existing || retryOriginal);
  }

  if (status === "confirmed" && selected) {
    const meetingTeam = [
      bookedRepName ?? schedule.hostName,
      ...schedule.teamMembers.map((member) => member.name),
    ].filter((name, index, names) => names.indexOf(name) === index);
    return (
      <main className="scheduler-shell">
        <div className="scheduler-brand" aria-label="Hot Potato">
          <img src="/hot-potato-mascot.png" alt="" />
          <b>HOT POTATO</b>
        </div>
        <section className="scheduler-confirmation" aria-live="polite">
          <span className="confirmation-mark">✓</span>
          <small>YOU&apos;RE BOOKED</small>
          <h1>See you there.</h1>
          <p>
            Your meeting with <b>{meetingTeam.join(", ")}</b> is confirmed for{" "}
            {longDateTime(selected.startsAt)}.
          </p>
          <div>
            <span>Calendar invitation</span>
            <b>
              Sent to {email}
              {additionalAttendeeEmails.length > 0
                ? ` and ${additionalAttendeeEmails.length} ${additionalAttendeeEmails.length === 1 ? "guest" : "guests"}`
                : ""}
            </b>
          </div>
          {conferenceUrl && (
            <a href={conferenceUrl} target="_blank" rel="noreferrer">
              Join {conferenceName} ↗
            </a>
          )}
          {managePath && <a href={managePath}>Reschedule or cancel</a>}
        </section>
      </main>
    );
  }

  return (
    <main className="scheduler-shell">
      <div className="scheduler-brand" aria-label="Hot Potato">
        <img src="/hot-potato-mascot.png" alt="" />
        <b>HOT POTATO</b>
      </div>
      <section className="scheduler-card">
        <aside className="scheduler-summary">
          <span className="scheduler-avatar">
            {schedule.hostName
              .split(" ")
              .map((part) => part[0])
              .join("")
              .slice(0, 2)}
          </span>
          <small>{schedule.organizationName}</small>
          <h1>Meet with {schedule.hostName}</h1>
          <p>{schedule.meetingDescription}</p>
          {schedule.teamMembers.length + schedule.cohostGroups.length > 0 && (
            <div className="scheduler-team">
              <span>TEAM MEETING</span>
              <b>
                {[
                  ...schedule.teamMembers.map((member) => member.name),
                  ...schedule.cohostGroups.map(
                    (group) => `${group.poolName} · assigned at booking`,
                  ),
                ].join(" · ")}
              </b>
              <small>
                {schedule.teamMembers.some(
                  (member) => member.requiredForAvailability,
                ) ||
                schedule.cohostGroups.some(
                  (group) => group.requiredForAvailability,
                )
                  ? "Required calendars are checked together."
                  : "Co-hosts are assigned fairly and included on the invitation."}
              </small>
            </div>
          )}
          <dl>
            <div>
              <dt>◷</dt>
              <dd>{schedule.durationMinutes} minutes</dd>
            </div>
            <div>
              <dt>↗</dt>
              <dd>{conferenceName}</dd>
            </div>
            <div>
              <dt>◎</dt>
              <dd>{recipientTimezone.replaceAll("_", " ")}</dd>
            </div>
          </dl>
        </aside>

        <div className="scheduler-picker">
          <div className="picker-heading">
            <span>SELECT A TIME</span>
            <h2>{schedule.meetingTitle}</h2>
            <p>Times are shown in your timezone.</p>
          </div>
          {suggestionNotice === "available" && selected && !bookingId && (
            <p className="scheduler-suggestion available" role="status">
              Good news—this suggested time is still open. Add your details to
              confirm it.
            </p>
          )}
          {suggestionNotice === "stale" && (
            <p className="scheduler-suggestion stale" role="status">
              That suggested time was just taken. Here are the latest times from
              the team&apos;s calendars.
            </p>
          )}
          {bookingId && (
            <p className="scheduler-suggestion available" role="status">
              Your original time and details are saved in this tab while we
              verify the booking. Checking status keeps the same request.
            </p>
          )}
          {loading ? (
            <div className="scheduler-loading">Checking calendars…</div>
          ) : bookingId ? null : days.length === 0 ? (
            <div className="scheduler-loading">
              No times are currently open. Please check back soon.
            </div>
          ) : (
            <>
              <div className="scheduler-days" aria-label="Available dates">
                {days.map(([key, daySlots]) => {
                  const label = dayLabel(daySlots[0]!.startsAt);
                  return (
                    <button
                      key={key}
                      type="button"
                      className={activeDay === key ? "active" : ""}
                      disabled={submitting || Boolean(bookingId)}
                      onClick={() => {
                        setActiveDay(key);
                        setSelected(null);
                        setSuggestionNotice(null);
                        setBookingId(null);
                      }}
                    >
                      <span>{label.weekday}</span>
                      <b>{label.date}</b>
                    </button>
                  );
                })}
              </div>
              <div className="scheduler-times" aria-label="Available times">
                {(days.find(([key]) => key === activeDay)?.[1] ?? []).map(
                  (slot) => (
                    <button
                      key={slot.startsAt}
                      type="button"
                      aria-pressed={selected?.startsAt === slot.startsAt}
                      disabled={submitting || Boolean(bookingId)}
                      className={
                        selected?.startsAt === slot.startsAt ? "active" : ""
                      }
                      onClick={() => {
                        setSelected(slot);
                        setBookingId(null);
                        setStatus(null);
                        setSuggestionNotice(null);
                        setError(null);
                      }}
                    >
                      {timeLabel(slot.startsAt)}
                    </button>
                  ),
                )}
              </div>
            </>
          )}

          {selected && (
            <form className="scheduler-form" onSubmit={submit}>
              <div className="selected-time">
                <span>SELECTED</span>
                <b>{longDateTime(selected.startsAt)}</b>
              </div>
              <label>
                Your name
                <input
                  required
                  minLength={2}
                  maxLength={80}
                  autoComplete="name"
                  disabled={submitting || Boolean(bookingId)}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Work email
                <input
                  required
                  type="email"
                  autoComplete="email"
                  disabled={submitting || Boolean(bookingId)}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <AdditionalGuests
                value={additionalAttendeeEmails}
                onChange={setAdditionalAttendeeEmails}
                primaryEmail={email}
                disabled={submitting || Boolean(bookingId)}
              />
              <label className="scheduler-honeypot" aria-hidden="true">
                Website
                <input
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(event) => setWebsite(event.target.value)}
                />
              </label>
              <button type="submit" disabled={submitting}>
                {submitting
                  ? "Checking…"
                  : bookingId
                    ? retryOriginal
                      ? "Retry same request"
                      : "Check booking status"
                    : "Confirm meeting"}
                <span>↗</span>
              </button>
            </form>
          )}
          {error && (
            <p className="scheduler-error" role="alert">
              {error}
            </p>
          )}
          {status === "failed" && managePath && (
            <a className="manage-join" href={managePath}>
              Verify or recover this booking
            </a>
          )}
        </div>
      </section>
      <footer className="scheduler-footer">
        Open-source scheduling and routing by Hot Potato
      </footer>
    </main>
  );
}
