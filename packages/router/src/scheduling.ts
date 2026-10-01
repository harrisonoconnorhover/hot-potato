import { isRepScheduledFor } from "./availability.js";
import type { Rep } from "./types.js";

export type SchedulingSlot = {
  startsAt: Date;
  endsAt: Date;
};

export type BusyInterval = SchedulingSlot;

function localMinutes(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  return part("hour") * 60 + part("minute");
}

function ceilToIncrement(date: Date, incrementMinutes: number): Date {
  const incrementMs = incrementMinutes * 60_000;
  return new Date(Math.ceil(date.getTime() / incrementMs) * incrementMs);
}

export function schedulingSlots(input: {
  rep: Rep;
  now: Date;
  durationMinutes: number;
  minNoticeMinutes: number;
  windowDays: number;
  incrementMinutes?: number;
}): SchedulingSlot[] {
  const incrementMinutes = input.incrementMinutes ?? 30;
  const earliest = new Date(
    input.now.getTime() + input.minNoticeMinutes * 60_000,
  );
  const latest = new Date(input.now.getTime() + input.windowDays * 86_400_000);
  const slots: SchedulingSlot[] = [];

  for (
    let startsAt = ceilToIncrement(earliest, 15);
    startsAt < latest;
    startsAt = new Date(startsAt.getTime() + 15 * 60_000)
  ) {
    if (localMinutes(startsAt, input.rep.timezone) % incrementMinutes !== 0) {
      continue;
    }
    const endsAt = new Date(
      startsAt.getTime() + input.durationMinutes * 60_000,
    );
    if (endsAt > latest) continue;
    if (isRepScheduledFor(input.rep, startsAt, endsAt)) {
      slots.push({ startsAt, endsAt });
    }
  }

  return slots;
}

export function withoutBusyIntervals(
  slots: SchedulingSlot[],
  busyIntervals: BusyInterval[],
  buffer: { beforeMinutes: number; afterMinutes: number } = {
    beforeMinutes: 0,
    afterMinutes: 0,
  },
): SchedulingSlot[] {
  const beforeMs = buffer.beforeMinutes * 60_000;
  const afterMs = buffer.afterMinutes * 60_000;
  return slots.filter(
    (slot) =>
      !busyIntervals.some(
        (busy) =>
          busy.startsAt.getTime() < slot.endsAt.getTime() + afterMs &&
          busy.endsAt.getTime() > slot.startsAt.getTime() - beforeMs,
      ),
  );
}

export function includesSchedulingSlot(
  slots: SchedulingSlot[],
  startsAt: Date,
): boolean {
  return slots.some((slot) => slot.startsAt.getTime() === startsAt.getTime());
}
