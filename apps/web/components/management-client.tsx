"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ManagedBookingView } from "../app/managed-booking";
import { bookingChangeIsOpen } from "../app/booking-change-policy";
import type { SerializedSchedulingSlot } from "../app/public-scheduling";
import { createBookingReadFence } from "./booking-read-fence";
import { fetchBookingJson } from "./booking-fetch";
import { bookingStatusIsProcessing } from "./booking-status";
import {
  managementChangeObserved,
  managementRejectionMayUnlock,
  submitManagementChange,
  type ManagementChange,
} from "./management-recovery";

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

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function ManagementClient({
  token,
  initialBooking,
}: {
  token: string;
  initialBooking: ManagedBookingView;
}) {
  const [booking, setBooking] = useState(initialBooking);
  const [slots, setSlots] = useState<SerializedSchedulingSlot[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localized, setLocalized] = useState(false);
  const [clock, setClock] = useState(0);
  const [pendingChange, setPendingChange] = useState<ManagementChange | null>(
    null,
  );
  const busyRef = useRef(false);
  const readFence = useRef(createBookingReadFence());
  const pendingChangeRef = useRef<ManagementChange | null>(null);

  function rememberChange(change: ManagementChange | null) {
    pendingChangeRef.current = change;
    setPendingChange(change);
  }

  const load = useCallback(async () => {
    const body = await readFence.current.run(
      async () => {
        const response = await fetchBookingJson<{
          booking?: ManagedBookingView;
          slots?: SerializedSchedulingSlot[];
          error?: string;
        }>(`/api/scheduling/manage?${new URLSearchParams({ token })}`, {
          cache: "no-store",
        });
        if (!response.ok || !response.body.booking)
          throw new Error(
            response.body.error ?? "The booking could not be loaded.",
          );
        return {
          booking: response.body.booking,
          slots: response.body.slots ?? [],
        };
      },
      (body) => {
        setBooking(body.booking);
        setSlots(body.slots);
        setError(body.booking.error);
        const change = pendingChangeRef.current;
        if (change && managementChangeObserved(change, body.booking))
          rememberChange(null);
      },
      (caught) => {
        setError(
          caught instanceof Error
            ? caught.message
            : "The booking could not be loaded.",
        );
      },
    );
    return body?.booking ?? null;
  }, [token]);

  useEffect(() => {
    setLocalized(true);
    setClock(Date.now());
    const policyTimer = window.setInterval(() => setClock(Date.now()), 15_000);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async (remaining: number) => {
      if (busyRef.current) return;
      const current = await load();
      if (
        !cancelled &&
        remaining > 0 &&
        current &&
        !current.error &&
        bookingStatusIsProcessing(current.status)
      ) {
        timer = setTimeout(() => void refresh(remaining - 1), 750);
      }
    };
    void refresh(20);
    return () => {
      cancelled = true;
      readFence.current.invalidate();
      window.clearInterval(policyTimer);
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  async function act(
    action:
      | "cancel"
      | "reschedule"
      | "retry_failed_router"
      | "close_failed_router",
  ) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    readFence.current.invalidate();
    const retryingUncertainChange = Boolean(pendingChangeRef.current);
    const startsAt =
      action === "reschedule" &&
      booking.status === "reschedule_pending" &&
      booking.error
        ? booking.startsAt
        : selected;
    const change = pendingChangeRef.current ?? {
      action,
      token,
      ...(action === "reschedule" ? { startsAt } : {}),
    };
    rememberChange(change);
    try {
      const result = await submitManagementChange(change);
      if (managementRejectionMayUnlock(result, retryingUncertainChange)) {
        rememberChange(null);
        setError(result.error);
        return;
      }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (attempt > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, 500));
        }
        const current = await load();
        if (
          !current ||
          current.error ||
          (!pendingChangeRef.current &&
            !bookingStatusIsProcessing(current.status))
        ) {
          break;
        }
      }
      if (pendingChangeRef.current)
        setError(
          result.error ??
            "Your change is still being verified. Check its status or retry the same change safely.",
        );
      else setSelected("");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function checkStatus() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await load();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const canRetryReschedule =
    booking.status === "reschedule_pending" && Boolean(booking.error);
  const policyNow = clock === 0 ? Number.NEGATIVE_INFINITY : clock;
  const reschedulingOpen = bookingChangeIsOpen(
    booking.rescheduleAllowedUntil,
    policyNow,
  );
  const cancellationOpen = bookingChangeIsOpen(
    booking.cancelAllowedUntil,
    policyNow,
  );
  const changing =
    booking.status === "cancel_pending" ||
    (booking.status === "reschedule_pending" && !canRetryReschedule);
  const canReschedule =
    (booking.status === "confirmed" && reschedulingOpen) || canRetryReschedule;
  const canCancel =
    (booking.status === "confirmed" && cancellationOpen) || canRetryReschedule;

  return (
    <main className="scheduler-shell">
      <div className="scheduler-brand" aria-label="Hot Potato">
        <img src="/hot-potato-mascot.png" alt="" />
        <b>HOT POTATO</b>
      </div>
      <section className="manage-card">
        <small>MANAGE MEETING</small>
        <h1>{booking.meetingTitle}</h1>
        {booking.status === "cancelled" ? (
          <div className="manage-result">
            <span className="confirmation-mark">✓</span>
            <h2>Your meeting is cancelled.</h2>
            <p>No further action is needed.</p>
          </div>
        ) : booking.failedRouterCreate && booking.status === "failed" ? (
          <div className="manage-result">
            <span className="confirmation-mark">!</span>
            <h2>The calendar write needs verification.</h2>
            <p>
              The representative and time remain reserved. Retry checks for the
              exact provider event before writing again. Close safely removes
              any matching event before the time is released.
            </p>
            <div className="manage-actions">
              <button
                type="button"
                disabled={busy || Boolean(pendingChange)}
                onClick={() => void act("retry_failed_router")}
              >
                {busy ? "Checking provider…" : "Retry same booking"}
              </button>
              <button
                type="button"
                disabled={busy || Boolean(pendingChange)}
                onClick={() => void act("close_failed_router")}
              >
                {busy ? "Checking provider…" : "Close failed booking"}
              </button>
            </div>
          </div>
        ) : booking.status === "pending" ? (
          <div className="manage-result">
            <span className="confirmation-mark">···</span>
            <h2>Your calendar write is being verified.</h2>
            <p>
              This page can be closed and reopened safely. The booking remains
              reserved while Hot Potato reconciles the provider result.
            </p>
          </div>
        ) : booking.status === "cancel_pending" ? (
          <div className="manage-result">
            <span className="confirmation-mark">···</span>
            <h2>The booking is being closed safely.</h2>
            <p>
              The time stays reserved until any matching provider event is
              removed or its absence is proven.
            </p>
          </div>
        ) : (
          <>
            <div className="manage-summary">
              <div>
                <span>WITH</span>
                <b>
                  {[
                    booking.repName,
                    ...booking.teamMembers.map((member) => member.name),
                  ].join(" · ")}
                </b>
                {booking.teamMembers.length > 0 && (
                  <small>Organizer and co-hosts</small>
                )}
              </div>
              <div>
                <span>WHEN</span>
                <b>
                  {localized
                    ? longDateTime(booking.startsAt)
                    : "Loading local time…"}
                </b>
              </div>
              <div>
                <span>INVITEE</span>
                <b>{booking.attendeeEmail}</b>
                {booking.additionalAttendeeEmails.length > 0 && (
                  <small>
                    +{booking.additionalAttendeeEmails.length} additional{" "}
                    {booking.additionalAttendeeEmails.length === 1
                      ? "guest"
                      : "guests"}
                  </small>
                )}
              </div>
            </div>
            {booking.conferenceUrl && (
              <a
                className="manage-join"
                href={booking.conferenceUrl}
                target="_blank"
                rel="noreferrer"
              >
                Join meeting ↗
              </a>
            )}
            <div className="manage-actions">
              <div>
                <h2>Choose a new time</h2>
                <p>
                  {canRetryReschedule
                    ? "Both the original and requested times remain reserved. Repair the calendar connection, then retry this exact change."
                    : !reschedulingOpen
                      ? `Rescheduling closed${booking.rescheduleAllowedUntil && localized ? ` ${longDateTime(booking.rescheduleAllowedUntil)}` : ""} to protect the host's calendar.`
                      : "The same representative stays assigned."}
                </p>
                <select
                  aria-label="New meeting time"
                  value={selected}
                  onChange={(event) => setSelected(event.target.value)}
                  disabled={
                    busy ||
                    Boolean(pendingChange) ||
                    changing ||
                    canRetryReschedule ||
                    !reschedulingOpen
                  }
                >
                  <option value="">Select an available time</option>
                  {slots.map((slot) => (
                    <option key={slot.startsAt} value={slot.startsAt}>
                      {localized ? timeLabel(slot.startsAt) : slot.startsAt}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={
                    busy ||
                    Boolean(pendingChange) ||
                    !canReschedule ||
                    (!canRetryReschedule && (!selected || changing))
                  }
                  onClick={() => void act("reschedule")}
                >
                  {canRetryReschedule
                    ? "Retry this reschedule"
                    : booking.status === "reschedule_pending"
                      ? "Rescheduling…"
                      : "Reschedule meeting"}
                </button>
              </div>
              <div className="cancel-panel">
                <h2>Need to cancel?</h2>
                <p>
                  {canRetryReschedule
                    ? "Cancel the meeting to release both reserved times."
                    : !cancellationOpen
                      ? `Cancellation closed${booking.cancelAllowedUntil && localized ? ` ${longDateTime(booking.cancelAllowedUntil)}` : ""}. Contact the organizer if plans changed.`
                      : "The calendar invitation will be removed for everyone."}
                </p>
                <button
                  type="button"
                  disabled={
                    busy || Boolean(pendingChange) || changing || !canCancel
                  }
                  onClick={() => void act("cancel")}
                >
                  Cancel meeting
                </button>
              </div>
            </div>
          </>
        )}
        {(pendingChange ||
          bookingStatusIsProcessing(booking.status) ||
          error) && (
          <div className="manage-actions" aria-live="polite">
            {pendingChange && (
              <p>
                Your original change is still being verified. Keep checking this
                meeting, or contact the organizer if it cannot be resolved.
              </p>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void checkStatus()}
            >
              {busy ? "Checking meeting…" : "Check meeting status"}
            </button>
            {pendingChange && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(pendingChange.action)}
              >
                Retry same change
              </button>
            )}
          </div>
        )}
        {error && (
          <p className="scheduler-error" role="alert">
            {error}
          </p>
        )}
      </section>
      <footer className="scheduler-footer">
        Open-source scheduling and routing by Hot Potato
      </footer>
    </main>
  );
}
