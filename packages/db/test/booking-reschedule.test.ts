import { describe, expect, it, vi } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import {
  BookingChangeCutoffError,
  CalendarSlotUnavailableError,
  HotPotatoRepository,
} from "../src/repository.js";

// SQL-boundary fixture for acknowledgement and fail-closed behavior. Actual
// PostgreSQL locking/concurrency is covered by the integration smoke suite.
function fixture(status = "reschedule_pending", jobStatus = "pending") {
  const booking = {
    id: "fictional-booking",
    repId: "fictional-rep",
    status,
    startsAt: "2031-01-01T15:00:00.000Z",
    endsAt: "2031-01-01T15:30:00.000Z",
    externalEventId: "fictional-event",
    calendarProvider: "google",
    calendarExternalAccountId: "fictional-account",
    rescheduleAllowed: true,
  };
  const job = { id: 10, status: jobStatus };
  const query = vi.fn(
    async (parts: TemplateStringsArray, ..._values: unknown[]) => {
      const statement = parts.join("?").replace(/\s+/g, " ").trim();
      if (statement.startsWith("SELECT id, rep_id FROM bookings"))
        return [{ id: booking.id, repId: booking.repId }];
      if (statement.startsWith("SELECT b.id, b.status"))
        return [{ ...booking }];
      if (statement.startsWith("SELECT id, status FROM jobs")) {
        // Completing a job takes the job lock before the booking lock. An
        // acknowledgement already holds the booking lock and must not take
        // the opposite lock order while a worker is completing this job.
        expect(statement).not.toContain("FOR UPDATE");
        return [{ ...job }];
      }
      if (statement.includes("FROM reps"))
        return [{ id: booking.repId, activeCalendarProvider: "google" }];
      if (statement.includes("FROM rep_calendar_connections"))
        return [{ externalAccountId: "fictional-account" }];
      if (statement.startsWith("UPDATE jobs SET status = 'pending'")) {
        job.status = "pending";
        return [];
      }
      if (statement.startsWith("UPDATE bookings SET last_error = null"))
        return [];
      throw new Error(`Unexpected fixture query: ${statement}`);
    },
  );
  const transaction = Object.assign(query, { json: (value: unknown) => value });
  const sql = {
    begin: (run: (transaction: TransactionSql) => Promise<unknown>) =>
      run(transaction as unknown as TransactionSql),
  };
  return {
    booking,
    job,
    query,
    repository: new HotPotatoRepository(sql as unknown as Sql),
    input: {
      manageToken: "fictional-manage-token",
      startsAt: new Date(booking.startsAt),
      endsAt: new Date(booking.endsAt),
      reminderMinutes: 0,
    },
  };
}

describe("booking reschedule acknowledgements", () => {
  it.each(["pending", "processing"])(
    "acknowledges an accepted %s update without another job or provider quote",
    async (jobStatus) => {
      const { repository, booking, input, query } = fixture(
        "reschedule_pending",
        jobStatus,
      );
      booking.rescheduleAllowed = false;
      booking.calendarExternalAccountId = "";
      await expect(repository.requestBookingReschedule(input)).resolves.toBe(
        "reschedule_pending",
      );
      await expect(repository.requestBookingReschedule(input)).resolves.toBe(
        "reschedule_pending",
      );
      expect(query).toHaveBeenCalledTimes(6);
    },
  );

  it("reports completion after a lost response even after the cutoff or disconnection", async () => {
    const { repository, booking, input, query } = fixture("confirmed");
    booking.rescheduleAllowed = false;
    booking.calendarExternalAccountId = "";
    await expect(repository.requestBookingReschedule(input)).resolves.toBe(
      "confirmed",
    );
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("does not acknowledge a different pending target", async () => {
    const { repository, input } = fixture();
    await expect(
      repository.requestBookingReschedule({
        ...input,
        startsAt: new Date("2031-01-02T15:00:00Z"),
        endsAt: new Date("2031-01-02T15:30:00Z"),
      }),
    ).rejects.toThrow("A different reschedule is already pending.");
  });

  it("requires provider proof if the accepted update has since failed", async () => {
    const { repository, input, job } = fixture("reschedule_pending", "failed");
    await expect(repository.requestBookingReschedule(input)).rejects.toThrow(
      "Provider event location proof is required",
    );
    expect(job.status).toBe("failed");
  });

  it("requires fresh availability if an uncertain provider event stayed at its original time", async () => {
    const { repository, input, job } = fixture("reschedule_pending", "failed");
    await expect(
      repository.requestBookingReschedule({
        ...input,
        providerEventAtRequested: false,
      }),
    ).rejects.toBeInstanceOf(CalendarSlotUnavailableError);
    expect(job.status).toBe("failed");
  });

  it("still retries an uncertain update with proof it reached the reserved target", async () => {
    const { repository, input, job } = fixture("reschedule_pending", "failed");
    await expect(
      repository.requestBookingReschedule({
        ...input,
        providerEventAtRequested: true,
      }),
    ).resolves.toBe("reschedule_pending");
    expect(job.status).toBe("pending");
  });

  it("enforces the cutoff for a new target", async () => {
    const { repository, booking, input } = fixture("confirmed");
    booking.rescheduleAllowed = false;
    await expect(
      repository.requestBookingReschedule({
        ...input,
        startsAt: new Date("2031-01-02T15:00:00Z"),
        endsAt: new Date("2031-01-02T15:30:00Z"),
      }),
    ).rejects.toBeInstanceOf(BookingChangeCutoffError);
  });

  it.each(["cancel_pending", "cancelled", "failed", "pending"])(
    "does not revive a %s booking",
    async (status) => {
      const { repository, input } = fixture(status);
      await expect(repository.requestBookingReschedule(input)).rejects.toThrow(
        "Only confirmed meetings can be rescheduled.",
      );
    },
  );
});
