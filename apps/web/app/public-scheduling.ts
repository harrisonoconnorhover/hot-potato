import type {
  BookingCalendarQuote,
  BookingCandidateQuote,
  ManagedBooking,
  MeetingCohostGroup,
  PublicSchedule,
  RepBookingCapacityStart,
} from "@hot-potato/db";
import {
  schedulingSlots,
  withoutBusyIntervals,
  type Rep,
} from "@hot-potato/router";
import { repository } from "./repository";
import { combinedRepBusyIntervals } from "./rep-calendar-availability";

export type PublicScheduleView = Omit<
  PublicSchedule,
  | "reps"
  | "requiredCohosts"
  | "cohostGroups"
  | "zoomJoinUrl"
  | "bufferBeforeMinutes"
  | "bufferAfterMinutes"
> & {
  cohostGroups: Array<Omit<MeetingCohostGroup, "candidates">>;
};

export type SerializedSchedulingSlot = {
  startsAt: string;
  endsAt: string;
};

export type PublicSlotOption = SerializedSchedulingSlot & {
  candidateQuotes: BookingCandidateQuote[];
};

const calendarCheckConcurrency = 6;
const publicAvailabilityDeadlineMs = 20_000;
const publicAvailabilityCacheMs = 15_000;
const publicAvailabilityCache = new Map<
  string,
  { expiresAt: number; options: Promise<PublicSlotOption[]> }
>();

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  deadlineAt: number,
  map: (value: T, remainingMs: number) => Promise<R>,
): Promise<{
  results: Array<PromiseSettledResult<R> | undefined>;
  deadlineReached: boolean;
}> {
  const results: Array<PromiseSettledResult<R> | undefined> = new Array(
    values.length,
  );
  let nextIndex = 0;
  let deadlineReached = false;

  async function worker() {
    while (nextIndex < values.length) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        deadlineReached = true;
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = {
          status: "fulfilled",
          value: await map(values[index]!, remainingMs),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  if (nextIndex < values.length) deadlineReached = true;
  return { results, deadlineReached };
}

export function scheduleView(schedule: PublicSchedule): PublicScheduleView {
  const {
    reps: _reps,
    requiredCohosts: _requiredCohosts,
    cohostGroups,
    zoomJoinUrl: _zoomJoinUrl,
    bufferBeforeMinutes: _bufferBeforeMinutes,
    bufferAfterMinutes: _bufferAfterMinutes,
    ...view
  } = schedule;
  return {
    ...view,
    cohostGroups: cohostGroups.map(
      ({ candidates: _candidates, ...group }) => group,
    ),
  };
}

async function providerAvailablePublicSlotOptions(
  schedule: PublicSchedule,
  now = new Date(),
  onlyRepId?: string,
): Promise<PublicSlotOption[]> {
  const candidates = schedule.reps.filter(
    (candidate) => !onlyRepId || candidate.id === onlyRepId,
  );
  const participants = [
    ...new Map(
      [
        ...candidates,
        ...schedule.requiredCohosts,
        ...schedule.cohostGroups.flatMap((group) =>
          group.requiredForAvailability ? group.candidates : [],
        ),
      ].map((rep) => [rep.id, rep]),
    ).values(),
  ];
  const deadlineAt = Date.now() + publicAvailabilityDeadlineMs;
  const { results: settled, deadlineReached } = await mapWithConcurrency(
    participants,
    calendarCheckConcurrency,
    deadlineAt,
    async (candidate, remainingMs) => {
      const rep: Rep = {
        id: candidate.id,
        name: candidate.name,
        email: "private",
        timezone: candidate.timezone,
        weight: candidate.weight,
        active: true,
        availability: candidate.availability,
        availabilityOverrides: candidate.availabilityOverrides,
      };
      const slots = schedulingSlots({
        rep,
        now,
        durationMinutes: schedule.durationMinutes,
        minNoticeMinutes: schedule.minimumNoticeMinutes,
        windowDays: schedule.bookingWindowDays,
      });
      const calendarQuote = {
        repId: candidate.id,
        calendarProvider: candidate.calendarProvider,
        calendarExternalAccountId: candidate.calendarExternalAccountId,
        conflictCalendars: candidate.conflictCalendars
          .map(({ provider, calendarExternalAccountId, calendarId }) => ({
            provider,
            calendarExternalAccountId,
            calendarId,
          }))
          .sort(
            (left, right) =>
              left.provider.localeCompare(right.provider) ||
              left.calendarExternalAccountId.localeCompare(
                right.calendarExternalAccountId,
              ) ||
              left.calendarId.localeCompare(right.calendarId),
          ),
      };
      if (slots.length === 0) return { calendarQuote, slots: [] };

      const busy = await combinedRepBusyIntervals({
        organizationSlug: schedule.organizationSlug,
        repId: candidate.id,
        calendars: candidate.conflictCalendars,
        startsAt: new Date(
          slots[0]!.startsAt.getTime() - schedule.bufferBeforeMinutes * 60_000,
        ),
        endsAt: new Date(
          slots.at(-1)!.endsAt.getTime() + schedule.bufferAfterMinutes * 60_000,
        ),
        timeoutMs: remainingMs,
      });
      return {
        calendarQuote,
        slots: withoutBusyIntervals(slots, busy, {
          beforeMinutes: schedule.bufferBeforeMinutes,
          afterMinutes: schedule.bufferAfterMinutes,
        }),
      };
    },
  );

  const availableByRepId = new Map<
    string,
    {
      calendarQuote: BookingCalendarQuote;
      slots: Array<{ startsAt: Date; endsAt: Date }>;
    }
  >();
  settled.forEach((result, index) => {
    if (!result) return;
    if (result.status === "fulfilled") {
      availableByRepId.set(participants[index]!.id, result.value);
      return;
    }
    console.error(
      `Public calendar availability failed for rep ${participants[index]?.id ?? "unknown"}:`,
      result.reason instanceof Error ? result.reason.message : "Unknown error",
    );
  });
  const requiredCohostFailed = schedule.requiredCohosts.some(
    (cohost) => !availableByRepId.has(cohost.id),
  );
  if (candidates.length > 0 && requiredCohostFailed) {
    throw new Error("A required co-host calendar could not be checked.");
  }
  const requiredGroupFailed = schedule.cohostGroups.some(
    (group) =>
      group.requiredForAvailability &&
      group.candidates.every(
        (candidate) => !availableByRepId.has(candidate.id),
      ),
  );
  if (candidates.length > 0 && requiredGroupFailed) {
    throw new Error("A required co-host pool could not be checked.");
  }
  if (
    candidates.length > 0 &&
    candidates.every((candidate) => !availableByRepId.has(candidate.id)) &&
    (deadlineReached || settled.some((result) => result?.status === "rejected"))
  ) {
    throw new Error("No representative calendars could be checked.");
  }
  if (deadlineReached) {
    console.warn(
      `Public availability deadline reached after checking ${settled.filter(Boolean).length} of ${participants.length} participants.`,
    );
  }

  const fixedCohostIds = new Set(
    schedule.teamMembers.map((cohost) => cohost.repId),
  );
  const groupCandidateQuotesBySlot = new Map<
    string,
    Map<string, BookingCalendarQuote[]>
  >();
  for (const group of schedule.cohostGroups) {
    const quotesBySlot = new Map<string, BookingCalendarQuote[]>();
    if (group.requiredForAvailability) {
      for (const groupCandidate of group.candidates) {
        const availability = availableByRepId.get(groupCandidate.id);
        if (!availability) continue;
        for (const slot of availability.slots) {
          const slotKey = `${slot.startsAt.toISOString()}\u0000${slot.endsAt.toISOString()}`;
          const quotes = quotesBySlot.get(slotKey) ?? [];
          quotes.push(availability.calendarQuote);
          quotesBySlot.set(slotKey, quotes);
        }
      }
    }
    groupCandidateQuotesBySlot.set(group.poolId, quotesBySlot);
  }

  const options = new Map<string, PublicSlotOption>();
  for (const candidate of candidates) {
    const organizerAvailability = availableByRepId.get(candidate.id);
    if (!organizerAvailability) continue;
    const requiredCohostAvailability = schedule.requiredCohosts
      .filter((cohost) => cohost.id !== candidate.id)
      .map((cohost) => availableByRepId.get(cohost.id)!);
    const requiredSlotKeys = requiredCohostAvailability.map(
      (availability) =>
        new Set(
          availability.slots.map(
            (slot) =>
              `${slot.startsAt.toISOString()}\u0000${slot.endsAt.toISOString()}`,
          ),
        ),
    );
    for (const slot of organizerAvailability.slots) {
      const slotKey = `${slot.startsAt.toISOString()}\u0000${slot.endsAt.toISOString()}`;
      if (!requiredSlotKeys.every((keys) => keys.has(slotKey))) continue;
      const cohostGroups = schedule.cohostGroups.map((group) => ({
        poolId: group.poolId,
        requiredForAvailability: group.requiredForAvailability,
        candidateQuotes: group.requiredForAvailability
          ? (
              groupCandidateQuotesBySlot.get(group.poolId)?.get(slotKey) ?? []
            ).filter(
              (groupCandidate) =>
                groupCandidate.repId !== candidate.id &&
                !fixedCohostIds.has(groupCandidate.repId),
            )
          : [],
      }));
      if (
        cohostGroups.some(
          (group) =>
            group.requiredForAvailability && group.candidateQuotes.length === 0,
        )
      ) {
        continue;
      }
      const candidateQuote: BookingCandidateQuote = {
        ...organizerAvailability.calendarQuote,
        requiredCohosts: requiredCohostAvailability.map(
          (availability) => availability.calendarQuote,
        ),
        cohostGroups,
      };
      const startsAt = slot.startsAt.toISOString();
      const option = options.get(startsAt) ?? {
        startsAt,
        endsAt: slot.endsAt.toISOString(),
        candidateQuotes: [],
      };
      option.candidateQuotes.push(candidateQuote);
      options.set(startsAt, option);
    }
  }
  return [...options.values()].sort((left, right) =>
    left.startsAt.localeCompare(right.startsAt),
  );
}

type ActiveBookingInterval = { startsAt: Date; endsAt: Date };

const localDateFormatterByTimezone = new Map<string, Intl.DateTimeFormat>();

function localDateParts(
  date: Date,
  timezone: string,
): { year: number; month: number; day: number } {
  let formatter = localDateFormatterByTimezone.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    localDateFormatterByTimezone.set(timezone, formatter);
  }
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
  };
}

function localDayKey(date: Date, timezone: string): string {
  const { year, month, day } = localDateParts(date, timezone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function localWeekKey(date: Date, timezone: string): string {
  const { year, month, day } = localDateParts(date, timezone);
  const localDate = new Date(Date.UTC(year, month - 1, day));
  const daysSinceMonday = (localDate.getUTCDay() + 6) % 7;
  localDate.setUTCDate(localDate.getUTCDate() - daysSinceMonday);
  return localDate.toISOString().slice(0, 10);
}

export function withoutBookingCapacity(
  options: PublicSlotOption[],
  schedule: PublicSchedule,
  startsByRep: ReadonlyMap<string, RepBookingCapacityStart[]>,
  capacityCredit?: { repId: string; startsAt: Date },
): PublicSlotOption[] {
  const allParticipants = [
    ...new Map(
      [
        ...schedule.reps,
        ...schedule.requiredCohosts,
        ...schedule.cohostGroups.flatMap((group) => group.candidates),
      ].map((rep) => [rep.id, rep]),
    ).values(),
  ];
  const repsById = new Map(allParticipants.map((rep) => [rep.id, rep]));
  const countsByRep = new Map<
    string,
    { daily: Map<string, Set<string>>; weekly: Map<string, Set<string>> }
  >();

  for (const rep of allParticipants) {
    const daily = new Map<string, Set<string>>();
    const weekly = new Map<string, Set<string>>();
    for (const start of startsByRep.get(rep.id) ?? []) {
      const dayKey = localDayKey(start.startsAt, rep.timezone);
      const weekKey = localWeekKey(start.startsAt, rep.timezone);
      const dayBookings = daily.get(dayKey) ?? new Set<string>();
      dayBookings.add(start.bookingId);
      daily.set(dayKey, dayBookings);
      const weekBookings = weekly.get(weekKey) ?? new Set<string>();
      weekBookings.add(start.bookingId);
      weekly.set(weekKey, weekBookings);
    }
    countsByRep.set(rep.id, { daily, weekly });
  }

  return options.flatMap((option) => {
    const startsAt = new Date(option.startsAt);
    const hasCapacity = (repId: string) => {
      const rep = repsById.get(repId);
      if (!rep) return false;
      const counts = countsByRep.get(rep.id)!;
      const dailyCount =
        counts.daily.get(localDayKey(startsAt, rep.timezone))?.size ?? 0;
      const weeklyCount =
        counts.weekly.get(localWeekKey(startsAt, rep.timezone))?.size ?? 0;
      const hasDailyCredit =
        capacityCredit?.repId === rep.id &&
        localDayKey(capacityCredit.startsAt, rep.timezone) ===
          localDayKey(startsAt, rep.timezone);
      const hasWeeklyCredit =
        capacityCredit?.repId === rep.id &&
        localWeekKey(capacityCredit.startsAt, rep.timezone) ===
          localWeekKey(startsAt, rep.timezone);
      return (
        (rep.dailyMeetingLimit === null ||
          dailyCount < rep.dailyMeetingLimit ||
          hasDailyCredit) &&
        (rep.weeklyMeetingLimit === null ||
          weeklyCount < rep.weeklyMeetingLimit ||
          hasWeeklyCredit)
      );
    };
    const candidateQuotes = option.candidateQuotes.flatMap((quote) => {
      if (
        ![quote, ...(quote.requiredCohosts ?? [])].every((participant) =>
          hasCapacity(participant.repId),
        )
      ) {
        return [];
      }
      const cohostGroups = (quote.cohostGroups ?? []).map((group) => ({
        ...group,
        candidateQuotes: group.requiredForAvailability
          ? group.candidateQuotes.filter((candidate) =>
              hasCapacity(candidate.repId),
            )
          : group.candidateQuotes,
      }));
      if (
        cohostGroups.some(
          (group) =>
            group.requiredForAvailability && group.candidateQuotes.length === 0,
        )
      ) {
        return [];
      }
      return [
        quote.cohostGroups === undefined ? quote : { ...quote, cohostGroups },
      ];
    });
    return candidateQuotes.length > 0 ? [{ ...option, candidateQuotes }] : [];
  });
}

export function withoutActiveBookingConflicts(
  options: PublicSlotOption[],
  intervalsByRep: ReadonlyMap<string, ActiveBookingInterval[]>,
  buffer: { beforeMinutes: number; afterMinutes: number } = {
    beforeMinutes: 0,
    afterMinutes: 0,
  },
): PublicSlotOption[] {
  return options.flatMap((option) => {
    const startsAt = new Date(
      Date.parse(option.startsAt) - buffer.beforeMinutes * 60_000,
    );
    const endsAt = new Date(
      Date.parse(option.endsAt) + buffer.afterMinutes * 60_000,
    );
    const isFree = (repId: string) =>
      !intervalsByRep
        .get(repId)
        ?.some(
          (interval) =>
            interval.startsAt < endsAt && interval.endsAt > startsAt,
        );
    const candidateQuotes = option.candidateQuotes.flatMap((quote) => {
      if (
        ![quote, ...(quote.requiredCohosts ?? [])].every((participant) =>
          isFree(participant.repId),
        )
      ) {
        return [];
      }
      const cohostGroups = (quote.cohostGroups ?? []).map((group) => ({
        ...group,
        candidateQuotes: group.requiredForAvailability
          ? group.candidateQuotes.filter((candidate) => isFree(candidate.repId))
          : group.candidateQuotes,
      }));
      if (
        cohostGroups.some(
          (group) =>
            group.requiredForAvailability && group.candidateQuotes.length === 0,
        )
      ) {
        return [];
      }
      return [
        quote.cohostGroups === undefined ? quote : { ...quote, cohostGroups },
      ];
    });
    return candidateQuotes.length > 0 ? [{ ...option, candidateQuotes }] : [];
  });
}

async function subtractActiveBookings(
  schedule: PublicSchedule,
  options: PublicSlotOption[],
  excludeBookingExternalId?: string,
  capacityCredit?: { repId: string; startsAt: Date },
): Promise<PublicSlotOption[]> {
  if (options.length === 0) return [];
  const repIds = [
    ...new Set(
      options.flatMap((option) =>
        option.candidateQuotes.flatMap((quote) => [
          quote.repId,
          ...(quote.requiredCohosts ?? []).map((cohost) => cohost.repId),
          ...(quote.cohostGroups ?? []).flatMap((group) =>
            group.candidateQuotes.map((candidate) => candidate.repId),
          ),
        ]),
      ),
    ),
  ];
  const startsAt = new Date(
    Math.min(...options.map((option) => Date.parse(option.startsAt))) -
      schedule.bufferBeforeMinutes * 60_000,
  );
  const endsAt = new Date(
    Math.max(...options.map((option) => Date.parse(option.endsAt))) +
      schedule.bufferAfterMinutes * 60_000,
  );
  const capacityPaddingMs = 8 * 86_400_000;
  const [intervals, capacityStarts] = await Promise.all([
    repository.activeBookingIntervals(
      schedule.organizationSlug,
      repIds,
      startsAt,
      endsAt,
      excludeBookingExternalId,
    ),
    repository.activeBookingCapacityStarts(
      schedule.organizationSlug,
      repIds,
      new Date(startsAt.getTime() - capacityPaddingMs),
      new Date(endsAt.getTime() + capacityPaddingMs),
      excludeBookingExternalId,
    ),
  ]);
  return withoutBookingCapacity(
    withoutActiveBookingConflicts(options, intervals, {
      beforeMinutes: schedule.bufferBeforeMinutes,
      afterMinutes: schedule.bufferAfterMinutes,
    }),
    schedule,
    capacityStarts,
    capacityCredit,
  );
}

export async function availablePublicSlotOptions(
  schedule: PublicSchedule,
  now = new Date(),
  onlyRepId?: string,
  excludeBookingExternalId?: string,
  capacityCredit?: { repId: string; startsAt: Date },
): Promise<PublicSlotOption[]> {
  return subtractActiveBookings(
    schedule,
    await providerAvailablePublicSlotOptions(schedule, now, onlyRepId),
    excludeBookingExternalId,
    capacityCredit,
  );
}

export async function availablePublicSlots(
  schedule: PublicSchedule,
  now = new Date(),
  onlyRepId?: string,
): Promise<SerializedSchedulingSlot[]> {
  return (await availablePublicSlotOptions(schedule, now, onlyRepId)).map(
    ({ candidateQuotes: _candidateQuotes, ...slot }) => slot,
  );
}

export async function cachedAvailablePublicSlots(
  schedule: PublicSchedule,
  onlyRepId?: string,
): Promise<SerializedSchedulingSlot[]> {
  const calendarSignature = schedule.reps
    .concat(
      schedule.requiredCohosts,
      schedule.cohostGroups.flatMap((group) => group.candidates),
    )
    .map(
      (rep) =>
        `${rep.id}:${rep.timezone}:${JSON.stringify(rep.availability)}:${JSON.stringify(rep.availabilityOverrides)}:${rep.dailyMeetingLimit}:${rep.weeklyMeetingLimit}:${rep.calendarProvider}:${rep.calendarExternalAccountId}:${rep.conflictCalendars
          .map(
            (calendar) =>
              `${calendar.provider}:${calendar.calendarExternalAccountId}:${calendar.calendarId}:${calendar.available}`,
          )
          .sort()
          .join(",")}`,
    )
    .join("|");
  const groupSignature = schedule.cohostGroups
    .map(
      (group) =>
        `${group.poolId}:${group.requiredForAvailability}:${group.candidates
          .map((candidate) => candidate.id)
          .sort()
          .join(",")}`,
    )
    .join("|");
  const key = `${schedule.meetingTypeId}:${schedule.bufferBeforeMinutes}:${schedule.bufferAfterMinutes}:${onlyRepId ?? "pool"}:${groupSignature}:${calendarSignature}`;
  const now = Date.now();
  const cached = publicAvailabilityCache.get(key);
  if (cached && cached.expiresAt > now) {
    return (await subtractActiveBookings(schedule, await cached.options)).map(
      ({ candidateQuotes: _candidateQuotes, ...slot }) => slot,
    );
  }

  const options = providerAvailablePublicSlotOptions(
    schedule,
    new Date(now),
    onlyRepId,
  ).catch((error) => {
    publicAvailabilityCache.delete(key);
    throw error;
  });
  publicAvailabilityCache.set(key, {
    expiresAt: now + publicAvailabilityCacheMs,
    options,
  });
  if (publicAvailabilityCache.size > 250) {
    for (const [cacheKey, entry] of publicAvailabilityCache) {
      if (entry.expiresAt <= now) publicAvailabilityCache.delete(cacheKey);
    }
    while (publicAvailabilityCache.size > 250) {
      const oldestKey = publicAvailabilityCache.keys().next().value;
      if (!oldestKey) break;
      publicAvailabilityCache.delete(oldestKey);
    }
  }
  return (await subtractActiveBookings(schedule, await options)).map(
    ({ candidateQuotes: _candidateQuotes, ...slot }) => slot,
  );
}

export async function loadPublicSchedule(
  organizationSlug: string,
  schedulingSlug: string,
): Promise<PublicSchedule | null> {
  return repository.publicSchedule(organizationSlug, schedulingSlug);
}

export async function availableManagedSlots(
  booking: ManagedBooking,
  excludeBookingExternalId?: string,
): Promise<SerializedSchedulingSlot[]> {
  return (
    await availableManagedSlotOptions(booking, excludeBookingExternalId)
  ).map(({ candidateQuotes: _candidateQuotes, ...slot }) => slot);
}

export async function availableManagedSlotOptions(
  booking: ManagedBooking,
  excludeBookingExternalId?: string,
): Promise<PublicSlotOption[]> {
  if (!booking.rescheduleSchedule) return [];
  return availablePublicSlotOptions(
    booking.rescheduleSchedule,
    new Date(),
    booking.repId,
    excludeBookingExternalId,
    { repId: booking.repId, startsAt: new Date(booking.startsAt) },
  );
}
