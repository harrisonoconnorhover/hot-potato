"use client";

import type { AvailabilitySchedule, DashboardRep } from "@hot-potato/db";
import {
  emailTimezoneLabel,
  emailTimezoneOptions,
} from "@hot-potato/email-composer";
import type {
  DateAvailabilityOverrides,
  TimeRange,
  WeeklyAvailability,
} from "@hot-potato/router";
import { useEffect, useMemo, useState } from "react";
import {
  type WorkingHoursDay,
  workingHoursDays,
  workingHoursSettingsSchema,
} from "../app/working-hours";
import styles from "./availability-editor.module.css";

type Draft = {
  timezone: string;
  availability: WeeklyAvailability;
  availabilityOverrides: DateAvailabilityOverrides;
  availabilityScheduleId: string | null;
  dailyMeetingLimit: number | null;
  weeklyMeetingLimit: number | null;
};

const dayLabels: Record<WorkingHoursDay, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
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

function cloneAvailabilityOverrides(
  value: DateAvailabilityOverrides,
): DateAvailabilityOverrides {
  return Object.fromEntries(
    Object.entries(value).map(([date, ranges]) => [
      date,
      ranges.map((range) => ({ ...range })),
    ]),
  );
}

function draftFromRep(rep: DashboardRep): Draft {
  return {
    timezone: rep.timezone,
    availability: cloneAvailability(rep.availability),
    availabilityOverrides: cloneAvailabilityOverrides(
      rep.availabilityOverrides,
    ),
    availabilityScheduleId: rep.availabilityScheduleId,
    dailyMeetingLimit: rep.dailyMeetingLimit,
    weeklyMeetingLimit: rep.weeklyMeetingLimit,
  };
}

function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function calendarDateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function weekdayForDate(value: string): WorkingHoursDay | null {
  if (!calendarDate(value)) return null;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC",
  })
    .format(new Date(`${value}T12:00:00.000Z`))
    .toLowerCase() as WorkingHoursDay;
}

function calendarDateLabel(value: string): string {
  if (!calendarDate(value)) return value;
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00.000Z`));
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
    const rangeStart = minutes(range.start);
    if (rangeStart - cursor >= 30) {
      return {
        start: timeValue(cursor),
        end: timeValue(Math.min(cursor + 60, rangeStart)),
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

function scheduleSummary(availability: WeeklyAvailability): {
  days: number;
  hours: number;
} {
  let days = 0;
  let minutesTotal = 0;
  for (const day of workingHoursDays) {
    const ranges = availability[day] ?? [];
    if (ranges.length) days += 1;
    for (const range of ranges) {
      minutesTotal += Math.max(0, minutes(range.end) - minutes(range.start));
    }
  }
  return { days, hours: minutesTotal / 60 };
}

function responseMessage(response: Response, fallback: string) {
  return response
    .json()
    .catch(() => ({}))
    .then((body: { error?: string }) => body.error ?? fallback);
}

export function AvailabilityEditor({
  rep,
  onSaved,
  availabilitySchedules = [],
  showIdentity = false,
}: {
  rep: DashboardRep;
  onSaved: () => Promise<void>;
  availabilitySchedules?: AvailabilitySchedule[];
  showIdentity?: boolean;
}) {
  const [draft, setDraft] = useState<Draft>(() => draftFromRep(rep));
  const [overrideDate, setOverrideDate] = useState("");
  const [today, setToday] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => setDraft(draftFromRep(rep)), [rep]);
  useEffect(() => {
    const date = calendarDateInTimezone(new Date(), draft.timezone);
    setToday(date);
    setOverrideDate((current) => current || date);
  }, [draft.timezone]);

  const timezoneOptions = useMemo(
    () => emailTimezoneOptions(draft.timezone),
    [draft.timezone],
  );
  const summary = useMemo(
    () => scheduleSummary(draft.availability),
    [draft.availability],
  );
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFromRep(rep));
  const namedSchedule = availabilitySchedules.find(
    (schedule) => schedule.id === draft.availabilityScheduleId,
  );
  const weeklyScheduleLocked = Boolean(namedSchedule);

  function selectWeeklySchedule(scheduleId: string) {
    setNotice(null);
    const schedule = availabilitySchedules.find(
      (candidate) => candidate.id === scheduleId,
    );
    setDraft((current) => ({
      ...current,
      availabilityScheduleId: schedule?.id ?? null,
      availability: schedule
        ? cloneAvailability(schedule.availability)
        : cloneAvailability(current.availability),
    }));
  }

  function setAvailability(update: (value: WeeklyAvailability) => void) {
    setNotice(null);
    setDraft((current) => {
      const availability = cloneAvailability(current.availability);
      update(availability);
      return { ...current, availability };
    });
  }

  function setAvailabilityOverrides(
    update: (value: DateAvailabilityOverrides) => void,
  ) {
    setNotice(null);
    setDraft((current) => {
      const availabilityOverrides = cloneAvailabilityOverrides(
        current.availabilityOverrides,
      );
      update(availabilityOverrides);
      return { ...current, availabilityOverrides };
    });
  }

  function defaultOverrideRanges(date: string): TimeRange[] {
    const weekday = weekdayForDate(date);
    const weekly = weekday ? draft.availability[weekday] : undefined;
    return (weekly?.length ? weekly : [{ start: "09:00", end: "17:00" }]).map(
      (range) => ({ ...range }),
    );
  }

  function addOverride(mode: "unavailable" | "custom") {
    if (!calendarDate(overrideDate)) {
      setNotice({ tone: "error", message: "Choose a real calendar date." });
      return;
    }
    if (
      Object.prototype.hasOwnProperty.call(
        draft.availabilityOverrides,
        overrideDate,
      )
    ) {
      setNotice({
        tone: "error",
        message: "That date already has an override. Edit it below.",
      });
      return;
    }
    if (Object.keys(draft.availabilityOverrides).length >= 120) {
      setNotice({
        tone: "error",
        message: "Remove an override before adding another one.",
      });
      return;
    }
    setAvailabilityOverrides((overrides) => {
      overrides[overrideDate] =
        mode === "unavailable" ? [] : defaultOverrideRanges(overrideDate);
    });
  }

  function setOverrideMode(date: string, mode: "unavailable" | "custom") {
    setAvailabilityOverrides((overrides) => {
      overrides[date] =
        mode === "unavailable" ? [] : defaultOverrideRanges(date);
    });
  }

  function updateOverrideRange(
    date: string,
    index: number,
    field: keyof TimeRange,
    value: string,
  ) {
    setAvailabilityOverrides((overrides) => {
      const ranges = overrides[date];
      if (!ranges?.[index]) return;
      ranges[index] = { ...ranges[index], [field]: value };
    });
  }

  function addOverrideRange(date: string) {
    setAvailabilityOverrides((overrides) => {
      const ranges = overrides[date] ?? [];
      if (ranges.length >= 4) return;
      const candidate = nextRange(ranges);
      if (candidate) overrides[date] = [...ranges, candidate];
    });
  }

  function removeOverrideRange(date: string, index: number) {
    setAvailabilityOverrides((overrides) => {
      const ranges = overrides[date] ?? [];
      overrides[date] = ranges.filter((_, rangeIndex) => rangeIndex !== index);
    });
  }

  function removeOverride(date: string) {
    setAvailabilityOverrides((overrides) => delete overrides[date]);
  }

  function toggleDay(day: WorkingHoursDay, enabled: boolean) {
    setAvailability((availability) => {
      if (!enabled) {
        delete availability[day];
        return;
      }
      const monday = availability.monday?.[0];
      availability[day] = [{ ...(monday ?? { start: "09:00", end: "17:00" }) }];
    });
  }

  function updateRange(
    day: WorkingHoursDay,
    index: number,
    field: keyof TimeRange,
    value: string,
  ) {
    setAvailability((availability) => {
      const ranges = availability[day];
      if (!ranges?.[index]) return;
      ranges[index] = { ...ranges[index], [field]: value };
    });
  }

  function addRange(day: WorkingHoursDay) {
    setAvailability((availability) => {
      const ranges = availability[day] ?? [];
      if (ranges.length >= 4) return;
      const candidate = nextRange(ranges);
      if (candidate) availability[day] = [...ranges, candidate];
    });
  }

  function removeRange(day: WorkingHoursDay, index: number) {
    setAvailability((availability) => {
      const ranges = availability[day] ?? [];
      const next = ranges.filter((_, rangeIndex) => rangeIndex !== index);
      if (next.length) availability[day] = next;
      else delete availability[day];
    });
  }

  function copyMonday(target: "weekdays" | "all") {
    const monday = draft.availability.monday;
    if (!monday?.length) return;
    setAvailability((availability) => {
      const targets =
        target === "weekdays"
          ? workingHoursDays.slice(1, 5)
          : workingHoursDays.slice(1);
      for (const day of targets) {
        availability[day] = monday.map((range) => ({ ...range }));
      }
    });
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice(null);
    const parsed = workingHoursSettingsSchema.safeParse(draft);
    if (!parsed.success) {
      setNotice({
        tone: "error",
        message:
          parsed.error.issues[0]?.message ?? "Check the availability schedule.",
      });
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(
        `/api/settings/reps/${encodeURIComponent(rep.id)}/working-hours`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parsed.data),
        },
      );
      if (!response.ok) {
        throw new Error(
          await responseMessage(response, "Working hours could not be saved."),
        );
      }
      setDraft({
        timezone: parsed.data.timezone,
        availability: cloneAvailability(parsed.data.availability),
        availabilityOverrides: cloneAvailabilityOverrides(
          parsed.data.availabilityOverrides ?? {},
        ),
        availabilityScheduleId: parsed.data.availabilityScheduleId ?? null,
        dailyMeetingLimit: parsed.data.dailyMeetingLimit ?? null,
        weeklyMeetingLimit: parsed.data.weeklyMeetingLimit ?? null,
      });
      setNotice({
        tone: "success",
        message: "Availability saved. New booking times use it immediately.",
      });
      try {
        await onSaved();
      } catch {
        setNotice({
          tone: "success",
          message:
            "Availability saved. Refresh this page to reload the latest schedule.",
        });
      }
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof Error
            ? error.message
            : "Working hours could not be saved.",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={styles.editor} onSubmit={(event) => void save(event)}>
      <div className={styles.heading}>
        <div className={styles.titleGroup}>
          {showIdentity && (
            <span className={styles.avatar} aria-hidden="true">
              {rep.name
                .split(/\s+/)
                .slice(0, 2)
                .map((part) => part[0]?.toUpperCase())
                .join("")}
            </span>
          )}
          <div>
            <span className={styles.eyebrow}>
              {showIdentity ? "REP AVAILABILITY" : "DEFAULT AVAILABILITY"}
            </span>
            <h3>{showIdentity ? rep.name : "When can people book you?"}</h3>
            <p>
              {showIdentity
                ? rep.email
                : "Used by Smart Links, Handoff, Gmail, Outlook, and your personal link."}
            </p>
          </div>
        </div>
        <div
          className={styles.summary}
          aria-label="Weekly availability summary"
        >
          <span>{summary.days} days</span>
          <span>
            {Number.isInteger(summary.hours)
              ? summary.hours
              : summary.hours.toFixed(1)}{" "}
            hrs
          </span>
        </div>
      </div>

      <div className={styles.tools}>
        <label>
          <span>Timezone</span>
          <select
            value={draft.timezone}
            onChange={(event) => {
              setNotice(null);
              setDraft((current) => ({
                ...current,
                timezone: event.target.value,
              }));
            }}
          >
            {timezoneOptions.map((option) => (
              <option value={option.value} key={option.value}>
                {option.label} · {option.value}
              </option>
            ))}
          </select>
          <small>
            Times below are in {emailTimezoneLabel(draft.timezone)}.
          </small>
        </label>
        <label>
          <span>Weekly schedule</span>
          <select
            value={draft.availabilityScheduleId ?? ""}
            onChange={(event) => selectWeeklySchedule(event.target.value)}
          >
            <option value="">Custom for this representative</option>
            {availabilitySchedules.map((schedule) => (
              <option value={schedule.id} key={schedule.id}>
                {schedule.name}
              </option>
            ))}
          </select>
          <small>
            {namedSchedule
              ? `${namedSchedule.name} is shared; date overrides below stay personal.`
              : "Custom hours belong only to this representative."}
          </small>
        </label>
        <div className={styles.copyTools}>
          <span>Copy Monday</span>
          <div>
            <button
              type="button"
              disabled={
                weeklyScheduleLocked || !draft.availability.monday?.length
              }
              onClick={() => copyMonday("weekdays")}
            >
              To weekdays
            </button>
            <button
              type="button"
              disabled={
                weeklyScheduleLocked || !draft.availability.monday?.length
              }
              onClick={() => copyMonday("all")}
            >
              To every day
            </button>
          </div>
        </div>
      </div>

      {namedSchedule && (
        <p className={styles.scheduleNotice}>
          <b>{namedSchedule.name}</b> controls the normal week for this rep.
          Choose “Custom for this representative” to detach without changing the
          current hours. Administrators edit shared schedules in the library
          above.
        </p>
      )}

      <fieldset
        className={`${styles.days} ${weeklyScheduleLocked ? styles.locked : ""}`}
        disabled={weeklyScheduleLocked}
      >
        <legend className={styles.legendVisuallyHidden}>
          Weekly working hours
        </legend>
        {workingHoursDays.map((day) => {
          const ranges = draft.availability[day] ?? [];
          const enabled = ranges.length > 0;
          const canAddPeriod = ranges.length < 4 && Boolean(nextRange(ranges));
          return (
            <div
              className={`${styles.day} ${enabled ? styles.enabled : ""}`}
              key={day}
            >
              <label className={styles.dayToggle}>
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(event) => toggleDay(day, event.target.checked)}
                />
                <span>{dayLabels[day]}</span>
              </label>
              <div className={styles.periods}>
                {!enabled && (
                  <span className={styles.unavailable}>Unavailable</span>
                )}
                {ranges.map((range, index) => (
                  <div className={styles.period} key={`${day}-${index}`}>
                    <input
                      type="time"
                      aria-label={`${dayLabels[day]} period ${index + 1} start`}
                      value={range.start}
                      onChange={(event) =>
                        updateRange(day, index, "start", event.target.value)
                      }
                    />
                    <span>to</span>
                    <input
                      type="time"
                      aria-label={`${dayLabels[day]} period ${index + 1} end`}
                      value={range.end}
                      onChange={(event) =>
                        updateRange(day, index, "end", event.target.value)
                      }
                    />
                    <button
                      type="button"
                      className={styles.remove}
                      aria-label={`Remove ${dayLabels[day]} period ${index + 1}`}
                      onClick={() => removeRange(day, index)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className={styles.add}
                disabled={!enabled || !canAddPeriod}
                onClick={() => addRange(day)}
              >
                + Add period
              </button>
            </div>
          );
        })}
      </fieldset>

      <section
        className={styles.capacity}
        aria-labelledby={`${rep.id}-capacity`}
      >
        <div className={styles.capacityHeading}>
          <span className={styles.eyebrow}>MEETING CAPACITY</span>
          <h4 id={`${rep.id}-capacity`}>Protect focus time automatically</h4>
          <p>
            Once a limit is reached, the rest of that day or Monday–Sunday week
            disappears everywhere this rep can be booked.
          </p>
        </div>
        <div className={styles.capacityFields}>
          <label>
            <span>Daily maximum</span>
            <input
              type="number"
              min="1"
              max="100"
              step="1"
              inputMode="numeric"
              placeholder="Unlimited"
              value={draft.dailyMeetingLimit ?? ""}
              onChange={(event) => {
                setNotice(null);
                setDraft((current) => ({
                  ...current,
                  dailyMeetingLimit:
                    event.target.value === ""
                      ? null
                      : Number(event.target.value),
                }));
              }}
            />
            <small>Resets at local midnight.</small>
          </label>
          <label>
            <span>Weekly maximum</span>
            <input
              type="number"
              min="1"
              max="500"
              step="1"
              inputMode="numeric"
              placeholder="Unlimited"
              value={draft.weeklyMeetingLimit ?? ""}
              onChange={(event) => {
                setNotice(null);
                setDraft((current) => ({
                  ...current,
                  weeklyMeetingLimit:
                    event.target.value === ""
                      ? null
                      : Number(event.target.value),
                }));
              }}
            />
            <small>Runs Monday through Sunday in this timezone.</small>
          </label>
        </div>
        <p className={styles.capacityScope}>
          Applies to Smart Links, Router embeds, Handoff, Gmail, Outlook, and
          personal links. Leave a field blank for unlimited.
        </p>
      </section>

      <section
        className={styles.overrides}
        aria-labelledby={`${rep.id}-overrides`}
      >
        <div className={styles.overrideHeading}>
          <div>
            <span className={styles.eyebrow}>DATE OVERRIDES</span>
            <h4 id={`${rep.id}-overrides`}>Change hours for a specific date</h4>
            <p>
              Block vacation days or open special hours without changing your
              normal week.
            </p>
          </div>
          <span className={styles.overrideCount}>
            {Object.keys(draft.availabilityOverrides).length} / 120
          </span>
        </div>

        <div className={styles.overrideAdd}>
          <label>
            <span>Override date</span>
            <input
              type="date"
              value={overrideDate}
              onChange={(event) => {
                setNotice(null);
                setOverrideDate(event.target.value);
              }}
            />
          </label>
          <button type="button" onClick={() => addOverride("unavailable")}>
            Block date
          </button>
          <button type="button" onClick={() => addOverride("custom")}>
            Use custom hours
          </button>
        </div>

        {Object.keys(draft.availabilityOverrides).length === 0 ? (
          <p className={styles.noOverrides}>
            No date overrides yet. Your weekly hours apply every week.
          </p>
        ) : (
          <div className={styles.overrideList}>
            {Object.entries(draft.availabilityOverrides)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([date, ranges]) => {
                const unavailable = ranges.length === 0;
                const canAddPeriod =
                  ranges.length < 4 && Boolean(nextRange(ranges));
                return (
                  <article className={styles.overrideCard} key={date}>
                    <div className={styles.overrideMeta}>
                      <div>
                        <strong>{calendarDateLabel(date)}</strong>
                        <span>{date}</span>
                      </div>
                      <div className={styles.overrideBadges}>
                        {today && date < today && <span>Past</span>}
                        <span className={unavailable ? styles.blocked : ""}>
                          {unavailable ? "Unavailable" : "Custom hours"}
                        </span>
                      </div>
                    </div>

                    {!unavailable && (
                      <div className={styles.overridePeriods}>
                        {ranges.map((range, index) => (
                          <div
                            className={styles.period}
                            key={`${date}-${index}`}
                          >
                            <input
                              type="time"
                              aria-label={`${calendarDateLabel(date)} period ${index + 1} start`}
                              value={range.start}
                              onChange={(event) =>
                                updateOverrideRange(
                                  date,
                                  index,
                                  "start",
                                  event.target.value,
                                )
                              }
                            />
                            <span>to</span>
                            <input
                              type="time"
                              aria-label={`${calendarDateLabel(date)} period ${index + 1} end`}
                              value={range.end}
                              onChange={(event) =>
                                updateOverrideRange(
                                  date,
                                  index,
                                  "end",
                                  event.target.value,
                                )
                              }
                            />
                            <button
                              type="button"
                              className={styles.remove}
                              aria-label={`Remove ${calendarDateLabel(date)} period ${index + 1}`}
                              onClick={() => removeOverrideRange(date, index)}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    <div className={styles.overrideActions}>
                      {unavailable ? (
                        <button
                          type="button"
                          onClick={() => setOverrideMode(date, "custom")}
                        >
                          Use custom hours
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={!canAddPeriod}
                            onClick={() => addOverrideRange(date)}
                          >
                            + Add period
                          </button>
                          <button
                            type="button"
                            onClick={() => setOverrideMode(date, "unavailable")}
                          >
                            Make unavailable
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className={styles.deleteOverride}
                        onClick={() => removeOverride(date)}
                      >
                        Remove override
                      </button>
                    </div>
                  </article>
                );
              })}
          </div>
        )}
      </section>

      {summary.days === 0 && (
        <p className={styles.warning} role="status">
          Every day is unavailable. Booking links will show no times until at
          least one day is enabled.
        </p>
      )}
      {notice && (
        <p
          className={`${styles.notice} ${styles[notice.tone]}`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          {notice.message}
        </p>
      )}
      <div className={styles.footer}>
        <p>
          Connected calendars still block busy events inside these hours. Date
          overrides take priority over the normal week. Adjacent periods are
          okay; overlapping periods are not.
        </p>
        <button type="submit" disabled={saving || !dirty}>
          {saving ? "Saving…" : dirty ? "Save availability" : "Saved"}
        </button>
      </div>
    </form>
  );
}
