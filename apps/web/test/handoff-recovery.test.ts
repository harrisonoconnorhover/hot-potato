import { describe, expect, it } from "vitest";
import {
  handoffRecoveryStorageKey,
  parseHandoffRecovery,
  serializeHandoffRecovery,
  shouldPreserveHandoffAcrossLinkRefresh,
  type HandoffRecoveryState,
} from "../components/handoff-scheduler";

const token = "a".repeat(48);
const recovery: HandoffRecoveryState = {
  version: 3,
  routerLinkId: "8f16495d-4df3-42c3-a370-8dc62de3bb71",
  routerSlug: "enterprise-demo",
  sessionToken: token,
  selectedSlot: {
    startsAt: "2026-09-01T15:00:00.000Z",
    endsAt: "2026-09-01T15:30:00.000Z",
  },
  bookingStarted: true,
  match: {
    expiresAt: "2026-09-01T14:30:00.000Z",
    meetingType: {
      slug: "discovery-call",
      title: "Discovery call",
      description: "A focused product conversation.",
      durationMinutes: 30,
      minimumNoticeMinutes: 60,
      bookingWindowDays: 14,
      conferenceProvider: "google_meet",
      reminderMinutes: 30,
    },
    matchedRuleName: "Enterprise inbound",
    poolName: "Enterprise AEs",
  },
};

describe("handoff session recovery", () => {
  it("round-trips only the safe recovery allowlist", () => {
    const unsafe = {
      ...recovery,
      attendeeName: "Private Person",
      attendeeEmail: "private@example.com",
      answers: { annual_revenue: "private answer" },
      match: {
        ...recovery.match,
        meetingType: {
          ...recovery.match.meetingType,
          attendeeEmail: "nested-private@example.com",
        },
      },
    };

    const serialized = serializeHandoffRecovery(unsafe);

    expect(serialized).not.toContain("Private Person");
    expect(serialized).not.toContain("private@example.com");
    expect(serialized).not.toContain("private answer");
    expect(serialized).not.toContain("nested-private@example.com");
    expect(
      parseHandoffRecovery(serialized, [
        { id: recovery.routerLinkId, slug: "enterprise-demo" },
      ]),
    ).toEqual(recovery);
  });

  it("rejects untrusted, malformed, and unknown recovery state", () => {
    const serialized = serializeHandoffRecovery(recovery);
    const malformedSlot = JSON.stringify({
      ...JSON.parse(serialized),
      selectedSlot: {
        startsAt: "2026-09-01T15:30:00.000Z",
        endsAt: "2026-09-01T15:00:00.000Z",
      },
    });
    const malformedToken = JSON.stringify({
      ...JSON.parse(serialized),
      sessionToken: "too-short",
    });
    const missingBookingMarker = JSON.stringify(
      Object.fromEntries(
        Object.entries(
          JSON.parse(serialized) as Record<string, unknown>,
        ).filter(([key]) => key !== "bookingStarted"),
      ),
    );

    expect(parseHandoffRecovery(serialized, [])).toBeNull();
    expect(
      parseHandoffRecovery(malformedSlot, [
        { id: recovery.routerLinkId, slug: "enterprise-demo" },
      ]),
    ).toBeNull();
    expect(
      parseHandoffRecovery(malformedToken, [
        { id: recovery.routerLinkId, slug: "enterprise-demo" },
      ]),
    ).toBeNull();
    expect(
      parseHandoffRecovery(missingBookingMarker, [
        { id: recovery.routerLinkId, slug: "enterprise-demo" },
      ]),
    ).toBeNull();
    expect(parseHandoffRecovery("not-json", [])).toBeNull();
  });

  it("resolves a renamed or unpublished link by stable id and upgrades older state", () => {
    const renamed = parseHandoffRecovery(serializeHandoffRecovery(recovery), [
      { id: recovery.routerLinkId, slug: "renamed-enterprise-demo" },
    ]);
    const legacy = { ...recovery, version: 1 } as Record<string, unknown>;
    delete legacy.routerLinkId;
    delete legacy.bookingStarted;
    const versionTwo = { ...recovery, version: 2 } as Record<string, unknown>;
    delete versionTwo.bookingStarted;

    expect(renamed).toEqual({
      ...recovery,
      routerSlug: "renamed-enterprise-demo",
    });
    expect(
      parseHandoffRecovery(JSON.stringify(legacy), [
        { id: recovery.routerLinkId, slug: "enterprise-demo" },
      ]),
    ).toEqual({ ...recovery, bookingStarted: false });
    expect(
      parseHandoffRecovery(JSON.stringify(versionTwo), [
        { id: recovery.routerLinkId, slug: "enterprise-demo" },
      ]),
    ).toEqual({ ...recovery, bookingStarted: false });
  });

  it("scopes storage per workspace and preserves a locked handoff on link edits", () => {
    expect(handoffRecoveryStorageKey("acme")).toBe("hot-potato:handoff:acme");
    expect(handoffRecoveryStorageKey("other-workspace")).not.toBe(
      handoffRecoveryStorageKey("acme"),
    );
    expect(
      shouldPreserveHandoffAcrossLinkRefresh(recovery, recovery.routerLinkId),
    ).toBe(true);
    expect(
      shouldPreserveHandoffAcrossLinkRefresh(recovery, "another-link-id"),
    ).toBe(false);
    expect(
      shouldPreserveHandoffAcrossLinkRefresh(null, "enterprise-demo"),
    ).toBe(false);
  });
});
