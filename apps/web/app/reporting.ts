import type {
  BookingAttendanceOutcome,
  ReportingRangeDays,
} from "@hot-potato/db";

export const reportingRanges = [1, 7, 30, 90] as const;

export function parseReportingRangeDays(
  value: string | null,
): ReportingRangeDays {
  const parsed = Number(value ?? 7);
  return reportingRanges.includes(parsed as ReportingRangeDays)
    ? (parsed as ReportingRangeDays)
    : 7;
}

export function parseAttendanceOutcome(
  value: unknown,
): BookingAttendanceOutcome | null {
  return value === "unknown" || value === "attended" || value === "no_show"
    ? value
    : null;
}
