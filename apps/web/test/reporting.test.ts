import type { ReportingSnapshot } from "@hot-potato/db";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  parseAttendanceOutcome,
  parseReportingRangeDays,
} from "../app/reporting";
import { ReportingView } from "../components/reporting-dashboard";

const snapshot: ReportingSnapshot = {
  rangeDays: 7,
  startsAt: "2026-08-24T12:00:00.000Z",
  generatedAt: "2026-08-31T12:00:00.000Z",
  funnel: {
    submissions: 20,
    qualified: 15,
    noMatch: 5,
    bookings: 12,
    conversionRate: 60,
  },
  bookingHealth: {
    total: 14,
    confirmed: 11,
    inProgress: 1,
    cancelled: 1,
    failed: 1,
    noShows: 2,
  },
  routerLinks: [
    {
      id: "router-1",
      name: "Enterprise inbound",
      active: true,
      submissions: 20,
      qualified: 15,
      bookings: 12,
      conversionRate: 60,
      lastActivityAt: "2026-08-31T11:00:00.000Z",
    },
  ],
  reps: [
    {
      id: "rep-1",
      name: "Alex Rivera",
      active: true,
      routes: 8,
      routeShare: 66.7,
      meetings: 7,
      confirmed: 6,
      cancelled: 1,
      noShows: 2,
    },
  ],
  calendarDelivery: [
    {
      provider: "google",
      total: 8,
      confirmed: 7,
      inProgress: 0,
      failed: 1,
      cancelled: 0,
    },
    {
      provider: "microsoft",
      total: 6,
      confirmed: 4,
      inProgress: 1,
      failed: 0,
      cancelled: 1,
    },
  ],
  recentMeetings: [
    {
      id: "meeting-1",
      attendeeName: "Morgan Lee",
      attendeeEmail: "morgan@example.com",
      meetingTitle: "Enterprise introduction",
      repName: "Alex Rivera",
      calendarProvider: "microsoft",
      status: "confirmed",
      attendanceOutcome: "no_show",
      startsAt: "2026-08-30T15:00:00.000Z",
      endsAt: "2026-08-30T15:30:00.000Z",
      source: "smart_router",
    },
  ],
};

describe("operator reporting", () => {
  it("accepts only supported ranges and attendance outcomes", () => {
    expect(parseReportingRangeDays("1")).toBe(1);
    expect(parseReportingRangeDays("90")).toBe(90);
    expect(parseReportingRangeDays("365")).toBe(7);
    expect(parseReportingRangeDays(null)).toBe(7);
    expect(parseAttendanceOutcome("attended")).toBe("attended");
    expect(parseAttendanceOutcome("no_show")).toBe("no_show");
    expect(parseAttendanceOutcome("cancelled")).toBeNull();
  });

  it("renders conversion, rep distribution, both providers, and attendance actions", () => {
    const onAttendance = vi.fn();
    const markup = renderToStaticMarkup(
      createElement(ReportingView, {
        snapshot,
        updatingBookingId: null,
        onAttendance,
      }),
    );

    expect(markup).toContain("60%");
    expect(markup).toContain("Enterprise inbound");
    expect(markup).toContain("Alex Rivera");
    expect(markup).toContain("Google Calendar");
    expect(markup).toContain("Outlook");
    expect(markup).toContain("Smart Router / Handoff");
    expect(markup).toContain("Morgan Lee");
    expect(markup).toContain("No-show");
    expect(markup).toContain("Attended");
    expect(markup).not.toContain("Outcome available after meeting");
  });
});
