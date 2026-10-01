"use client";

import type { AvailabilitySchedule } from "@hot-potato/db";
import type { TimeRange, WeeklyAvailability } from "@hot-potato/router";
import { useEffect, useState } from "react";
import {
  availabilityScheduleInputSchema,
  type WorkingHoursDay,
  workingHoursDays,
} from "../app/working-hours";
import styles from "./availability-schedule-library.module.css";

type ScheduleDraft = AvailabilitySchedule & { id: string };

const dayLabels: Record<WorkingHoursDay, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

const defaultWeek: WeeklyAvailability = {
  monday: [{ start: "09:00", end: "17:00" }],
  tuesday: [{ start: "09:00", end: "17:00" }],
  wednesday: [{ start: "09:00", end: "17:00" }],
  thursday: [{ start: "09:00", end: "17:00" }],
  friday: [{ start: "09:00", end: "17:00" }],
};

function cloneAvailability(value: WeeklyAvailability): WeeklyAvailability {
  return Object.fromEntries(
    workingHoursDays.flatMap((day) =>
      value[day]?.length
        ? [[day, value[day]!.map((range) => ({ ...range }))]]
        : [],
    ),
  );
}

function cloneSchedule(schedule: AvailabilitySchedule): ScheduleDraft {
  return {
    ...schedule,
    availability: cloneAvailability(schedule.availability),
  };
}

function minutes(value: string): number {
  const [hours = "0", minute = "0"] = value.split(":");
  return Number(hours) * 60 + Number(minute);
}

function timeValue(value: number): string {
  const bounded = Math.max(0, Math.min(value, 23 * 60 + 59));
  return `${Math.floor(bounded / 60)
    .toString()
    .padStart(2, "0")}:${(bounded % 60).toString().padStart(2, "0")}`;
}

function nextRange(ranges: TimeRange[]): TimeRange | null {
  if (!ranges.length) return { start: "09:00", end: "17:00" };
  const sorted = [...ranges].sort((left, right) =>
    left.start.localeCompare(right.start),
  );
  let cursor = 9 * 60;
  for (const range of sorted) {
    const start = minutes(range.start);
    if (start - cursor >= 30) {
      return {
        start: timeValue(cursor),
        end: timeValue(Math.min(cursor + 60, start)),
      };
    }
    cursor = Math.max(cursor, minutes(range.end));
  }
  if (23 * 60 + 59 - cursor < 30) return null;
  return {
    start: timeValue(cursor),
    end: timeValue(Math.min(cursor + 60, 23 * 60 + 59)),
  };
}

function summary(availability: WeeklyAvailability) {
  let days = 0;
  let totalMinutes = 0;
  for (const day of workingHoursDays) {
    const ranges = availability[day] ?? [];
    if (ranges.length) days += 1;
    for (const range of ranges) {
      totalMinutes += Math.max(0, minutes(range.end) - minutes(range.start));
    }
  }
  return { days, hours: totalMinutes / 60 };
}

async function responseMessage(response: Response, fallback: string) {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

export function AvailabilityScheduleLibrary({
  schedules,
  onRefresh,
}: {
  schedules: AvailabilitySchedule[];
  onRefresh: () => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<ScheduleDraft[]>(() =>
    schedules.map(cloneSchedule),
  );
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => setDrafts(schedules.map(cloneSchedule)), [schedules]);

  function updateDraft(
    id: string,
    update: (draft: ScheduleDraft) => ScheduleDraft,
  ) {
    setNotice(null);
    setConfirmDeleteId(null);
    setDrafts((current) =>
      current.map((draft) => (draft.id === id ? update(draft) : draft)),
    );
  }

  function updateAvailability(
    id: string,
    update: (availability: WeeklyAvailability) => void,
  ) {
    updateDraft(id, (draft) => {
      const availability = cloneAvailability(draft.availability);
      update(availability);
      return { ...draft, availability };
    });
  }

  function addSchedule() {
    if (drafts.some((draft) => draft.id === "new")) return;
    setNotice(null);
    setExpandedIds((current) => new Set(current).add("new"));
    setDrafts((current) => [
      ...current,
      {
        id: "new",
        name: "New schedule",
        availability: cloneAvailability(defaultWeek),
        assignedRepCount: 0,
      },
    ]);
  }

  function toggleExpanded(id: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleDay(id: string, day: WorkingHoursDay, enabled: boolean) {
    updateAvailability(id, (availability) => {
      if (!enabled) {
        delete availability[day];
        return;
      }
      const monday = availability.monday?.[0];
      availability[day] = [{ ...(monday ?? { start: "09:00", end: "17:00" }) }];
    });
  }

  function updateRange(
    id: string,
    day: WorkingHoursDay,
    index: number,
    field: keyof TimeRange,
    value: string,
  ) {
    updateAvailability(id, (availability) => {
      const ranges = availability[day];
      if (!ranges?.[index]) return;
      ranges[index] = { ...ranges[index], [field]: value };
    });
  }

  function addRange(id: string, day: WorkingHoursDay) {
    updateAvailability(id, (availability) => {
      const ranges = availability[day] ?? [];
      if (ranges.length >= 4) return;
      const range = nextRange(ranges);
      if (range) availability[day] = [...ranges, range];
    });
  }

  function removeRange(id: string, day: WorkingHoursDay, index: number) {
    updateAvailability(id, (availability) => {
      const ranges = availability[day] ?? [];
      const next = ranges.filter((_, current) => current !== index);
      if (next.length) availability[day] = next;
      else delete availability[day];
    });
  }

  function copyMonday(id: string, target: "weekdays" | "all") {
    updateAvailability(id, (availability) => {
      const monday = availability.monday;
      if (!monday?.length) return;
      const targets =
        target === "weekdays"
          ? workingHoursDays.slice(1, 5)
          : workingHoursDays.slice(1);
      for (const day of targets) {
        availability[day] = monday.map((range) => ({ ...range }));
      }
    });
  }

  async function save(draft: ScheduleDraft) {
    const parsed = availabilityScheduleInputSchema.safeParse({
      ...(draft.id !== "new" ? { id: draft.id } : {}),
      name: draft.name,
      availability: draft.availability,
    });
    if (!parsed.success) {
      setNotice({
        tone: "error",
        message:
          parsed.error.issues[0]?.message ?? "Check the reusable schedule.",
      });
      return;
    }
    setBusy(draft.id);
    setNotice(null);
    try {
      const response = await fetch("/api/settings/availability-schedules", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (!response.ok) {
        throw new Error(
          await responseMessage(response, "The schedule could not be saved."),
        );
      }
      await onRefresh();
      setNotice({
        tone: "success",
        message:
          draft.assignedRepCount > 0
            ? `Schedule saved. ${draft.assignedRepCount} assigned ${draft.assignedRepCount === 1 ? "rep was" : "reps were"} updated immediately.`
            : "Reusable schedule saved.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The schedule could not be saved.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function remove(draft: ScheduleDraft) {
    if (draft.id === "new") {
      setDrafts((current) => current.filter((item) => item.id !== "new"));
      setExpandedIds((current) => {
        const next = new Set(current);
        next.delete("new");
        return next;
      });
      return;
    }
    if (confirmDeleteId !== draft.id) {
      setConfirmDeleteId(draft.id);
      setNotice({
        tone: "error",
        message:
          draft.assignedRepCount > 0
            ? `${draft.assignedRepCount} assigned ${draft.assignedRepCount === 1 ? "rep keeps" : "reps keep"} the current hours as custom availability. Select confirm remove to continue.`
            : "Select confirm remove to delete this reusable schedule.",
      });
      return;
    }
    setBusy(`delete:${draft.id}`);
    try {
      const response = await fetch("/api/settings/availability-schedules", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: draft.id }),
      });
      if (!response.ok) {
        throw new Error(
          await responseMessage(response, "The schedule could not be removed."),
        );
      }
      setConfirmDeleteId(null);
      await onRefresh();
      setNotice({
        tone: "success",
        message:
          "Reusable schedule removed. Assigned reps kept its last hours.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "The schedule could not be removed.",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className={styles.library}
      aria-labelledby="schedule-library-title"
    >
      <div className={styles.heading}>
        <div>
          <span>REUSABLE SCHEDULES</span>
          <h3 id="schedule-library-title">One week, shared across a team</h3>
          <p>
            Build a named week once, assign it below, and update every linked
            rep atomically. Each rep keeps their own timezone and date
            overrides.
          </p>
        </div>
        <button
          type="button"
          disabled={drafts.some((draft) => draft.id === "new")}
          onClick={addSchedule}
        >
          + New schedule
        </button>
      </div>

      {drafts.length === 0 && (
        <div className={styles.empty}>
          <b>No reusable schedules yet</b>
          <span>
            Representatives can keep custom hours, or you can create a shared
            week for teams with the same coverage pattern.
          </span>
        </div>
      )}

      <div className={styles.list}>
        {drafts.map((draft) => {
          const totals = summary(draft.availability);
          const saved = schedules.find((schedule) => schedule.id === draft.id);
          const dirty =
            draft.id === "new" ||
            JSON.stringify(draft) !==
              JSON.stringify(saved && cloneSchedule(saved));
          const expanded = expandedIds.has(draft.id);
          return (
            <article className={styles.card} key={draft.id}>
              <div className={styles.cardHeading}>
                <label>
                  <span>Schedule name</span>
                  <input
                    value={draft.name}
                    maxLength={80}
                    onChange={(event) =>
                      updateDraft(draft.id, (current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                  />
                </label>
                <div className={styles.cardControls}>
                  <div className={styles.metrics}>
                    <span>{draft.assignedRepCount} assigned</span>
                    <span>{totals.days} days</span>
                    <span>
                      {Number.isInteger(totals.hours)
                        ? totals.hours
                        : totals.hours.toFixed(1)}{" "}
                      hrs
                    </span>
                  </div>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`schedule-week-${draft.id}`}
                    onClick={() => toggleExpanded(draft.id)}
                  >
                    {expanded ? "Hide week" : "Edit week"}
                  </button>
                </div>
              </div>

              {expanded && (
                <>
                  <div className={styles.copyBar}>
                    <span>Copy Monday</span>
                    <button
                      type="button"
                      disabled={!draft.availability.monday?.length}
                      onClick={() => copyMonday(draft.id, "weekdays")}
                    >
                      To weekdays
                    </button>
                    <button
                      type="button"
                      disabled={!draft.availability.monday?.length}
                      onClick={() => copyMonday(draft.id, "all")}
                    >
                      To every day
                    </button>
                  </div>

                  <fieldset
                    className={styles.days}
                    id={`schedule-week-${draft.id}`}
                  >
                    <legend>
                      Weekly hours for {draft.name || "this schedule"}
                    </legend>
                    {workingHoursDays.map((day) => {
                      const ranges = draft.availability[day] ?? [];
                      const enabled = ranges.length > 0;
                      return (
                        <div className={styles.day} key={day}>
                          <label className={styles.dayToggle}>
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={(event) =>
                                toggleDay(draft.id, day, event.target.checked)
                              }
                            />
                            <span>{dayLabels[day]}</span>
                          </label>
                          <div className={styles.periods}>
                            {!enabled && <span>Unavailable</span>}
                            {ranges.map((range, index) => (
                              <div
                                className={styles.period}
                                key={`${day}-${index}`}
                              >
                                <input
                                  type="time"
                                  aria-label={`${draft.name} ${dayLabels[day]} period ${index + 1} start`}
                                  value={range.start}
                                  onChange={(event) =>
                                    updateRange(
                                      draft.id,
                                      day,
                                      index,
                                      "start",
                                      event.target.value,
                                    )
                                  }
                                />
                                <span>to</span>
                                <input
                                  type="time"
                                  aria-label={`${draft.name} ${dayLabels[day]} period ${index + 1} end`}
                                  value={range.end}
                                  onChange={(event) =>
                                    updateRange(
                                      draft.id,
                                      day,
                                      index,
                                      "end",
                                      event.target.value,
                                    )
                                  }
                                />
                                <button
                                  type="button"
                                  aria-label={`Remove ${draft.name} ${dayLabels[day]} period ${index + 1}`}
                                  onClick={() =>
                                    removeRange(draft.id, day, index)
                                  }
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                          </div>
                          <button
                            type="button"
                            className={styles.addPeriod}
                            disabled={
                              !enabled ||
                              ranges.length >= 4 ||
                              !nextRange(ranges)
                            }
                            onClick={() => addRange(draft.id, day)}
                          >
                            + Add period
                          </button>
                        </div>
                      );
                    })}
                  </fieldset>
                </>
              )}

              <div className={styles.footer}>
                <p>
                  {draft.assignedRepCount > 0
                    ? `Saving updates ${draft.assignedRepCount} assigned ${draft.assignedRepCount === 1 ? "rep" : "reps"} immediately.`
                    : "Assign this schedule from any representative’s availability card below."}
                </p>
                <div>
                  <button
                    type="button"
                    className={styles.removeSchedule}
                    disabled={busy !== null}
                    onClick={() => void remove(draft)}
                  >
                    {confirmDeleteId === draft.id
                      ? "Confirm remove"
                      : draft.id === "new"
                        ? "Discard"
                        : "Remove"}
                  </button>
                  <button
                    type="button"
                    className={styles.save}
                    disabled={busy !== null || !dirty}
                    onClick={() => void save(draft)}
                  >
                    {busy === draft.id
                      ? "Saving…"
                      : dirty
                        ? "Save schedule"
                        : "Saved"}
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      {notice && (
        <p
          className={`${styles.notice} ${styles[notice.tone]}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.message}
        </p>
      )}
    </section>
  );
}
