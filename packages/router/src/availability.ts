import type { Rep, WeeklyAvailability } from "./types.js";

type LocalTime = {
  weekday: keyof WeeklyAvailability;
  minutes: number;
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
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  const weekday = part("weekday")?.toLowerCase() as keyof WeeklyAvailability;
  const hours = Number(part("hour"));
  const minutes = Number(part("minute"));
  return { weekday, minutes: hours * 60 + minutes };
}

export function isRepScheduled(rep: Rep, at: Date): boolean {
  if (!rep.active) return false;
  const local = localTime(at, rep.timezone);
  return (rep.availability[local.weekday] ?? []).some((range) => {
    const start = parseMinutes(range.start);
    const end = parseMinutes(range.end);
    return start <= local.minutes && local.minutes < end;
  });
}
