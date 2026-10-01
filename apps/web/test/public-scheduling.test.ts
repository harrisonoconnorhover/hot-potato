import type { PublicSchedule } from "@hot-potato/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  activeBookingCapacityStarts: vi.fn(),
  activeBookingIntervals: vi.fn(),
  combinedBusyIntervals: vi.fn(),
}));

vi.mock("../app/repository", () => ({
  repository: {
    activeBookingCapacityStarts: mocks.activeBookingCapacityStarts,
    activeBookingIntervals: mocks.activeBookingIntervals,
  },
}));

vi.mock("../app/rep-calendar-availability", () => ({
  combinedRepBusyIntervals: mocks.combinedBusyIntervals,
}));

import {
  availablePublicSlotOptions,
  cachedAvailablePublicSlots,
  scheduleView,
  withoutActiveBookingConflicts,
  withoutBookingCapacity,
  type PublicSlotOption,
} from "../app/public-scheduling";

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.activeBookingCapacityStarts.mockResolvedValue(new Map());
  mocks.activeBookingIntervals.mockResolvedValue(new Map());
  mocks.combinedBusyIntervals.mockResolvedValue([]);
});

function scheduleWithOverrides(
  availabilityOverrides: PublicSchedule["reps"][number]["availabilityOverrides"],
): PublicSchedule {
  return {
    meetingTypeId: "meeting-override",
    organizationName: "Acme",
    organizationSlug: "acme",
    schedulingSlug: "special-hours",
    meetingTitle: "Special hours",
    meetingDescription: "A focused conversation.",
    durationMinutes: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    minimumNoticeMinutes: 0,
    bookingWindowDays: 1,
    conferenceProvider: "none",
    zoomJoinUrl: null,
    reminderMinutes: 0,
    targetType: "rep",
    hostName: "Ada",
    requiredCohosts: [],
    cohostGroups: [],
    teamMembers: [],
    reps: [
      {
        id: "rep-special",
        name: "Ada",
        timezone: "UTC",
        weight: 1,
        availability: {},
        availabilityOverrides,
        dailyMeetingLimit: null,
        weeklyMeetingLimit: null,
        calendarProvider: "google",
        calendarExternalAccountId: "google-account",
        conflictCalendars: [
          {
            provider: "google",
            calendarExternalAccountId: "google-account",
            calendarId: "primary",
            available: true,
          },
        ],
      },
    ],
  };
}

const option: PublicSlotOption = {
  startsAt: "2026-09-02T15:00:00.000Z",
  endsAt: "2026-09-02T15:30:00.000Z",
  candidateQuotes: ["rep-a", "rep-b"].map((repId) => ({
    repId,
    calendarProvider: "google" as const,
    calendarExternalAccountId: `${repId}-account`,
    conflictCalendars: [
      {
        provider: "google" as const,
        calendarExternalAccountId: `${repId}-account`,
        calendarId: "primary",
      },
    ],
  })),
};

describe("active booking availability", () => {
  it("offers only times shared by the organizer and every required co-host", async () => {
    const schedule = scheduleWithOverrides({
      "2026-09-08": [{ start: "09:00", end: "10:00" }],
    });
    const organizer = schedule.reps[0]!;
    schedule.requiredCohosts = [
      {
        ...organizer,
        id: "rep-cohost",
        name: "Grace",
        availabilityOverrides: {
          "2026-09-08": [{ start: "09:30", end: "10:30" }],
        },
        calendarExternalAccountId: "cohost-account",
        conflictCalendars: [
          {
            provider: "microsoft",
            calendarExternalAccountId: "cohost-account",
            calendarId: "calendar",
            available: true,
          },
        ],
        calendarProvider: "microsoft",
      },
    ];
    schedule.teamMembers = [
      {
        repId: "rep-cohost",
        name: "Grace",
        requiredForAvailability: true,
      },
    ];

    const options = await availablePublicSlotOptions(
      schedule,
      new Date("2026-09-08T08:00:00.000Z"),
    );

    expect(options.map((option) => option.startsAt)).toEqual([
      "2026-09-08T09:30:00.000Z",
    ]);
    expect(options[0]?.candidateQuotes[0]?.requiredCohosts).toEqual([
      expect.objectContaining({
        repId: "rep-cohost",
        calendarProvider: "microsoft",
        calendarExternalAccountId: "cohost-account",
      }),
    ]);
    expect(mocks.combinedBusyIntervals).toHaveBeenCalledTimes(2);
    expect(mocks.activeBookingIntervals).toHaveBeenCalledWith(
      "acme",
      expect.arrayContaining(["rep-special", "rep-cohost"]),
      expect.any(Date),
      expect.any(Date),
      undefined,
    );
  });

  it("offers a time when at least one person in every required co-host pool is free", async () => {
    const schedule = scheduleWithOverrides({
      "2026-09-08": [{ start: "09:00", end: "10:00" }],
    });
    const organizer = schedule.reps[0]!;
    schedule.cohostGroups = [
      {
        poolId: "00000000-0000-4000-8000-000000000101",
        poolName: "Solutions engineering",
        requiredForAvailability: true,
        candidates: [
          {
            ...organizer,
            id: "rep-se-google",
            name: "Lin",
            availabilityOverrides: {
              "2026-09-08": [{ start: "09:00", end: "09:30" }],
            },
            calendarExternalAccountId: "se-google-account",
          },
          {
            ...organizer,
            id: "rep-se-outlook",
            name: "Grace",
            availabilityOverrides: {
              "2026-09-08": [{ start: "09:30", end: "10:00" }],
            },
            calendarProvider: "microsoft",
            calendarExternalAccountId: "se-outlook-account",
            conflictCalendars: [
              {
                provider: "microsoft",
                calendarExternalAccountId: "se-outlook-account",
                calendarId: "calendar",
                available: true,
              },
            ],
          },
        ],
      },
    ];

    const options = await availablePublicSlotOptions(
      schedule,
      new Date("2026-09-08T08:00:00.000Z"),
    );

    expect(options.map((candidate) => candidate.startsAt)).toEqual([
      "2026-09-08T09:00:00.000Z",
      "2026-09-08T09:30:00.000Z",
    ]);
    expect(
      options.map(
        (candidate) =>
          candidate.candidateQuotes[0]?.cohostGroups?.[0]?.candidateQuotes[0]
            ?.repId,
      ),
    ).toEqual(["rep-se-google", "rep-se-outlook"]);
    expect(
      options[1]?.candidateQuotes[0]?.cohostGroups?.[0]?.candidateQuotes[0],
    ).toEqual(
      expect.objectContaining({
        calendarProvider: "microsoft",
        calendarExternalAccountId: "se-outlook-account",
      }),
    );
  });

  it("keeps a pooled co-host slot when another eligible pool member is free", () => {
    const pooledOption: PublicSlotOption = {
      ...option,
      candidateQuotes: [
        {
          ...option.candidateQuotes[0]!,
          cohostGroups: [
            {
              poolId: "00000000-0000-4000-8000-000000000101",
              requiredForAvailability: true,
              candidateQuotes: [
                {
                  ...option.candidateQuotes[0]!,
                  repId: "rep-se-a",
                },
                {
                  ...option.candidateQuotes[0]!,
                  repId: "rep-se-b",
                },
              ],
            },
          ],
        },
      ],
    };

    const filtered = withoutActiveBookingConflicts(
      [pooledOption],
      new Map([
        [
          "rep-se-a",
          [
            {
              startsAt: new Date(option.startsAt),
              endsAt: new Date(option.endsAt),
            },
          ],
        ],
      ]),
    );

    expect(
      filtered[0]?.candidateQuotes[0]?.cohostGroups?.[0]?.candidateQuotes.map(
        (candidate) => candidate.repId,
      ),
    ).toEqual(["rep-se-b"]);
  });

  it("removes an organizer option when its required co-host is reserved", () => {
    const groupOption: PublicSlotOption = {
      ...option,
      candidateQuotes: [
        {
          ...option.candidateQuotes[0]!,
          requiredCohosts: [
            {
              repId: "rep-cohost",
              calendarProvider: "microsoft",
              calendarExternalAccountId: "cohost-account",
              conflictCalendars: [
                {
                  provider: "microsoft",
                  calendarExternalAccountId: "cohost-account",
                  calendarId: "calendar",
                },
              ],
            },
          ],
        },
      ],
    };

    expect(
      withoutActiveBookingConflicts(
        [groupOption],
        new Map([
          [
            "rep-cohost",
            [
              {
                startsAt: new Date("2026-09-02T15:00:00.000Z"),
                endsAt: new Date("2026-09-02T15:30:00.000Z"),
              },
            ],
          ],
        ]),
      ),
    ).toEqual([]);
  });

  it("uses date overrides in the shared public scheduling flow", async () => {
    const schedule = scheduleWithOverrides({
      "2026-09-08": [{ start: "09:00", end: "10:00" }],
    });

    const options = await availablePublicSlotOptions(
      schedule,
      new Date("2026-09-08T08:00:00.000Z"),
    );

    expect(options.map((candidate) => candidate.startsAt)).toEqual([
      "2026-09-08T09:00:00.000Z",
      "2026-09-08T09:30:00.000Z",
    ]);
    expect(mocks.combinedBusyIntervals).toHaveBeenCalledOnce();
    expect(mocks.activeBookingIntervals).toHaveBeenCalledOnce();
  });

  it("invalidates the short slot cache when date overrides change", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T08:00:00.000Z"));

    const first = await cachedAvailablePublicSlots(
      scheduleWithOverrides({
        "2026-09-08": [{ start: "09:00", end: "10:00" }],
      }),
    );
    const changed = await cachedAvailablePublicSlots(
      scheduleWithOverrides({
        "2026-09-08": [{ start: "10:00", end: "11:00" }],
      }),
    );

    expect(first[0]?.startsAt).toBe("2026-09-08T09:00:00.000Z");
    expect(changed[0]?.startsAt).toBe("2026-09-08T10:00:00.000Z");
    expect(mocks.combinedBusyIntervals).toHaveBeenCalledTimes(2);
  });

  it("keeps protective buffers internal to the availability engine", () => {
    const view = scheduleView({
      meetingTypeId: "meeting-1",
      organizationName: "Acme",
      organizationSlug: "acme",
      schedulingSlug: "demo",
      meetingTitle: "Demo",
      meetingDescription: "A focused conversation.",
      durationMinutes: 30,
      bufferBeforeMinutes: 15,
      bufferAfterMinutes: 20,
      minimumNoticeMinutes: 60,
      bookingWindowDays: 14,
      conferenceProvider: "none",
      zoomJoinUrl: null,
      reminderMinutes: 0,
      targetType: "rep",
      hostName: "Ada",
      reps: [],
      requiredCohosts: [],
      cohostGroups: [],
      teamMembers: [],
    } satisfies PublicSchedule);

    expect(view).not.toHaveProperty("bufferBeforeMinutes");
    expect(view).not.toHaveProperty("bufferAfterMinutes");
    expect(view).not.toHaveProperty("requiredCohosts");
    expect(view.durationMinutes).toBe(30);
  });

  it("shows pooled role labels without exposing candidate calendars", () => {
    const schedule = scheduleWithOverrides({});
    schedule.cohostGroups = [
      {
        poolId: "00000000-0000-4000-8000-000000000101",
        poolName: "Solutions engineering",
        requiredForAvailability: true,
        candidates: schedule.reps,
      },
    ];

    const view = scheduleView(schedule);

    expect(view.cohostGroups).toEqual([
      {
        poolId: "00000000-0000-4000-8000-000000000101",
        poolName: "Solutions engineering",
        requiredForAvailability: true,
      },
    ]);
    expect(view.cohostGroups[0]).not.toHaveProperty("candidates");
  });

  it("keeps a pool time when another representative remains free", () => {
    const filtered = withoutActiveBookingConflicts(
      [option],
      new Map([
        [
          "rep-a",
          [
            {
              startsAt: new Date("2026-09-02T14:45:00.000Z"),
              endsAt: new Date("2026-09-02T15:15:00.000Z"),
            },
          ],
        ],
      ]),
    );

    expect(filtered).toEqual([
      { ...option, candidateQuotes: [option.candidateQuotes[1]] },
    ]);
    expect(option.candidateQuotes.map((quote) => quote.repId)).toEqual([
      "rep-a",
      "rep-b",
    ]);
  });

  it("removes a time when every offered representative is booked", () => {
    const conflict = {
      startsAt: new Date("2026-09-02T15:10:00.000Z"),
      endsAt: new Date("2026-09-02T15:40:00.000Z"),
    };

    expect(
      withoutActiveBookingConflicts(
        [option],
        new Map([
          ["rep-a", [conflict]],
          ["rep-b", [conflict]],
        ]),
      ),
    ).toEqual([]);
  });

  it("treats adjacent half-open ranges as available", () => {
    const filtered = withoutActiveBookingConflicts(
      [{ ...option, candidateQuotes: [option.candidateQuotes[0]!] }],
      new Map([
        [
          "rep-a",
          [
            {
              startsAt: new Date("2026-09-02T14:30:00.000Z"),
              endsAt: new Date(option.startsAt),
            },
            {
              startsAt: new Date(option.endsAt),
              endsAt: new Date("2026-09-02T16:00:00.000Z"),
            },
          ],
        ],
      ]),
    );

    expect(filtered).toEqual([
      { ...option, candidateQuotes: [option.candidateQuotes[0]] },
    ]);
  });

  it("protects a new meeting buffer against a booked meeting range", () => {
    const filtered = withoutActiveBookingConflicts(
      [{ ...option, candidateQuotes: [option.candidateQuotes[0]!] }],
      new Map([
        [
          "rep-a",
          [
            {
              startsAt: new Date("2026-09-02T14:30:00.000Z"),
              endsAt: new Date("2026-09-02T14:50:00.000Z"),
            },
          ],
        ],
      ]),
      { beforeMinutes: 15, afterMinutes: 0 },
    );

    expect(filtered).toEqual([]);
  });

  it("keeps exact buffer boundaries available", () => {
    const filtered = withoutActiveBookingConflicts(
      [{ ...option, candidateQuotes: [option.candidateQuotes[0]!] }],
      new Map([
        [
          "rep-a",
          [
            {
              startsAt: new Date("2026-09-02T14:30:00.000Z"),
              endsAt: new Date("2026-09-02T14:45:00.000Z"),
            },
          ],
        ],
      ]),
      { beforeMinutes: 15, afterMinutes: 0 },
    );

    expect(filtered).toEqual([
      { ...option, candidateQuotes: [option.candidateQuotes[0]] },
    ]);
  });

  it("removes only the representative whose local day is at capacity", () => {
    const baseRep = scheduleWithOverrides({}).reps[0]!;
    const schedule: PublicSchedule = {
      ...scheduleWithOverrides({}),
      reps: [
        {
          ...baseRep,
          id: "rep-a",
          dailyMeetingLimit: 1,
        },
        {
          ...baseRep,
          id: "rep-b",
          dailyMeetingLimit: 1,
        },
      ],
    };

    expect(
      withoutBookingCapacity(
        [option],
        schedule,
        new Map([
          [
            "rep-a",
            [
              {
                bookingId: "booking-a",
                startsAt: new Date("2026-09-02T11:00:00.000Z"),
              },
            ],
          ],
        ]),
      ),
    ).toEqual([{ ...option, candidateQuotes: [option.candidateQuotes[1]] }]);
  });

  it("uses each representative's timezone for daily capacity", () => {
    const rep = {
      ...scheduleWithOverrides({}).reps[0]!,
      id: "rep-a",
      timezone: "America/Los_Angeles",
      dailyMeetingLimit: 1,
    };
    const midnightUtcOption = {
      ...option,
      startsAt: "2026-09-03T00:00:00.000Z",
      endsAt: "2026-09-03T00:30:00.000Z",
      candidateQuotes: [option.candidateQuotes[0]!],
    };

    expect(
      withoutBookingCapacity(
        [midnightUtcOption],
        { ...scheduleWithOverrides({}), reps: [rep] },
        new Map([
          [
            "rep-a",
            [
              {
                bookingId: "booking-a",
                startsAt: new Date("2026-09-02T23:30:00.000Z"),
              },
            ],
          ],
        ]),
      ),
    ).toEqual([]);
  });

  it("counts one rescheduling booking once inside the same local week", () => {
    const rep = {
      ...scheduleWithOverrides({}).reps[0]!,
      id: "rep-a",
      weeklyMeetingLimit: 2,
    };

    expect(
      withoutBookingCapacity(
        [{ ...option, candidateQuotes: [option.candidateQuotes[0]!] }],
        { ...scheduleWithOverrides({}), reps: [rep] },
        new Map([
          [
            "rep-a",
            [
              {
                bookingId: "booking-a",
                startsAt: new Date("2026-09-01T15:00:00.000Z"),
              },
              {
                bookingId: "booking-a",
                startsAt: new Date("2026-09-03T15:00:00.000Z"),
              },
            ],
          ],
        ]),
      ),
    ).toHaveLength(1);
  });

  it("removes a time when the representative's local week is full", () => {
    const rep = {
      ...scheduleWithOverrides({}).reps[0]!,
      id: "rep-a",
      weeklyMeetingLimit: 1,
    };

    expect(
      withoutBookingCapacity(
        [{ ...option, candidateQuotes: [option.candidateQuotes[0]!] }],
        { ...scheduleWithOverrides({}), reps: [rep] },
        new Map([
          [
            "rep-a",
            [
              {
                bookingId: "booking-a",
                startsAt: new Date("2026-09-01T15:00:00.000Z"),
              },
            ],
          ],
        ]),
      ),
    ).toEqual([]);
  });

  it("preserves a managed booking's capacity credit within its current week", () => {
    const rep = {
      ...scheduleWithOverrides({}).reps[0]!,
      id: "rep-a",
      weeklyMeetingLimit: 1,
    };
    const offered = {
      ...option,
      candidateQuotes: [option.candidateQuotes[0]!],
    };
    const existing = new Map([
      [
        "rep-a",
        [
          {
            bookingId: "another-booking",
            startsAt: new Date("2026-09-01T15:00:00.000Z"),
          },
        ],
      ],
    ]);

    expect(
      withoutBookingCapacity(
        [offered],
        { ...scheduleWithOverrides({}), reps: [rep] },
        existing,
        { repId: "rep-a", startsAt: new Date("2026-09-01T17:00:00.000Z") },
      ),
    ).toEqual([offered]);
  });
});
