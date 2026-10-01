import { describe, expect, it } from "vitest";
import {
  createSmartRouterRecovery,
  parseSmartRouterRecovery,
  reopenSmartRouterAvailability,
  serializeSmartRouterRecovery,
  smartRouterAssignmentLocked,
  smartRouterRecoveryStorageKey,
  type SmartRouterLinkIdentity,
} from "../components/smart-router-recovery";

const identity: SmartRouterLinkIdentity = {
  organizationSlug: "acme",
  routerLinkId: "8f16495d-4df3-42c3-a370-8dc62de3bb71",
  routerSlug: "enterprise-demo",
};

const meetingType = {
  slug: "discovery-call",
  title: "Discovery call",
  description: "A focused product conversation.",
  durationMinutes: 30,
  minimumNoticeMinutes: 60,
  bookingWindowDays: 14,
  conferenceProvider: "google_meet" as const,
  reminderMinutes: 30,
};

describe("public Smart Router recovery", () => {
  it("round-trips only the safe recovery allowlist", () => {
    const recovery = {
      ...createSmartRouterRecovery(identity, "a".repeat(48), meetingType),
      selectedSlot: {
        startsAt: "2026-09-01T15:00:00.000Z",
        endsAt: "2026-09-01T15:30:00.000Z",
      },
      attendeeName: "Private Person",
      attendeeEmail: "private@example.com",
      answers: { revenue: "private answer" },
      meetingType: {
        ...meetingType,
        attendeeEmail: "nested-private@example.com",
      },
    };

    const serialized = serializeSmartRouterRecovery(recovery);

    expect(serialized).not.toContain("Private Person");
    expect(serialized).not.toContain("private@example.com");
    expect(serialized).not.toContain("private answer");
    expect(serialized).not.toContain("nested-private@example.com");
    expect(parseSmartRouterRecovery(serialized, identity)).toEqual({
      version: 1,
      ...identity,
      sessionToken: "a".repeat(48),
      selectedSlot: recovery.selectedSlot,
      meetingType,
      bookingStarted: false,
    });
  });

  it("uses stable link identity across a slug rename", () => {
    const recovery = createSmartRouterRecovery(
      identity,
      "b".repeat(48),
      meetingType,
    );
    const renamed = { ...identity, routerSlug: "renamed-enterprise-demo" };

    expect(smartRouterRecoveryStorageKey(renamed)).toBe(
      smartRouterRecoveryStorageKey(identity),
    );
    expect(
      parseSmartRouterRecovery(serializeSmartRouterRecovery(recovery), renamed),
    ).toEqual({ ...recovery, routerSlug: "renamed-enterprise-demo" });
  });

  it("rejects malformed, cross-workspace, and wrong-link state", () => {
    const serialized = serializeSmartRouterRecovery(
      createSmartRouterRecovery(identity, "c".repeat(48), meetingType),
    );
    const malformed = JSON.stringify({
      ...JSON.parse(serialized),
      attendeeEmail: "must-not-be-accepted@example.com",
    });

    expect(
      parseSmartRouterRecovery(serialized, {
        ...identity,
        organizationSlug: "another-workspace",
      }),
    ).toBeNull();
    expect(
      parseSmartRouterRecovery(serialized, {
        ...identity,
        routerLinkId: "another-link-id",
      }),
    ).toBeNull();
    expect(parseSmartRouterRecovery(malformed, identity)).toBeNull();
    expect(parseSmartRouterRecovery("not-json", identity)).toBeNull();
  });

  it("locks assignment only once booking has started", () => {
    const recovery = createSmartRouterRecovery(
      identity,
      "d".repeat(48),
      meetingType,
    );

    expect(smartRouterAssignmentLocked(recovery)).toBe(false);
    expect(
      smartRouterAssignmentLocked({ ...recovery, bookingStarted: true }),
    ).toBe(true);
    expect(smartRouterAssignmentLocked(null)).toBe(false);
  });

  it("unlocks only after status 404 is followed by valid availability", () => {
    const started = {
      ...createSmartRouterRecovery(identity, "e".repeat(48), meetingType),
      selectedSlot: {
        startsAt: "2026-09-01T15:00:00.000Z",
        endsAt: "2026-09-01T15:30:00.000Z",
      },
      bookingStarted: true,
    };

    expect(reopenSmartRouterAvailability(started)).toEqual({
      ...started,
      selectedSlot: null,
      bookingStarted: false,
    });
    expect(smartRouterAssignmentLocked(started)).toBe(true);
    expect(
      smartRouterAssignmentLocked(reopenSmartRouterAvailability(started)),
    ).toBe(false);
  });
});
