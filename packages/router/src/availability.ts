import type { Rep, WeeklyAvailability } from "./types.js";

type LocalTime = {
  weekday: keyof WeeklyAvailability;
  minutes: number;
  date: string;
};

function parseMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  if (hours === undefined || minutes === undefined) return -1;
  return hours * 60 + minutes;
}

function localTime(date: Date, timezone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const weekday = part("weekday")?.toLowerCase() as keyof WeeklyAvailability;
  const hours = Number(part("hour"));
  const minutes = Number(part("minute"));
  return {
    weekday,
    minutes: hours * 60 + minutes,
    date: `${part("year")}-${part("month")}-${part("day")}`,
  };
}

function rangesForLocalTime(rep: Rep, local: LocalTime) {
  if (
    rep.availabilityOverrides &&
    Object.prototype.hasOwnProperty.call(rep.availabilityOverrides, local.date)
  ) {
    return rep.availabilityOverrides[local.date] ?? [];
  }
  return rep.availability[local.weekday] ?? [];
}

export function isRepScheduledFor(
  rep: Rep,
  startsAt: Date,
  endsAt: Date,
): boolean {
  if (!rep.active || endsAt <= startsAt) return false;
  const start = localTime(startsAt, rep.timezone);
  const end = localTime(new Date(endsAt.getTime() - 1), rep.timezone);
  if (start.date !== end.date || start.weekday !== end.weekday) return false;
  return rangesForLocalTime(rep, start).some((range) => {
    const rangeStart = parseMinutes(range.start);
    const rangeEnd = parseMinutes(range.end);
    return rangeStart <= start.minutes && end.minutes < rangeEnd;
  });
}

export function isRepScheduled(rep: Rep, at: Date): boolean {
  if (!rep.active) return false;
  const local = localTime(at, rep.timezone);
  return rangesForLocalTime(rep, local).some((range) => {
    const start = parseMinutes(range.start);
    const end = parseMinutes(range.end);
    return start <= local.minutes && local.minutes < end;
  });
}
