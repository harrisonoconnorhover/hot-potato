import { describe, expect, it, vi } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import {
  BookingChangeCutoffError,
  CalendarAccountIdentityError,
  HotPotatoRepository,
} from "../src/repository.js";

// This fixture models committed rows at the SQL boundary. It does not model
// PostgreSQL locking; provider behavior is rehearsed separately.
function fixture(status = "confirmed") {
  const booking = {
    id: "fictional-booking",
    status,
    lastError: null as string | null,
    externalEventId: "fictional-event",
    calendarProvider: "google",
    calendarExternalAccountId: "fictional-account",
    cancelAllowed: true,
    externalId: "fictional-transaction",
    organizationSlug: "fictional-team",
    repId: "fictional-rep",
  };
  const jobs: Record<string, unknown>[] = [];
  const query = vi.fn(
    async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const statement = parts.join("?").replace(/\s+/g, " ").trim();
      if (statement.startsWith("SELECT b.id, b.status"))
        return [{ ...booking }];
      if (statement.includes("FROM reps")) {
        return [{ id: "fictional-rep", activeCalendarProvider: "google" }];
      }
      if (statement.includes("FROM rep_calendar_connections")) {
        return [{ externalAccountId: "fictional-account" }];
      }
      if (
        statement.startsWith("UPDATE bookings SET status = 'cancel_pending'")
      ) {
        booking.status = "cancel_pending";
        return [];
      }
      if (statement.startsWith("UPDATE jobs SET status = 'cancelled'"))
        return [];
      if (statement.startsWith("INSERT INTO jobs")) {
        jobs.push(values[0] as Record<string, unknown>);
        return [];
      }
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
    jobs,
    query,
    repository: new HotPotatoRepository(sql as unknown as Sql),
  };
}

describe("booking cancellation retries", () => {
  it("returns the queued cancellation after the first response is lost, without another job", async () => {
    const { repository, booking, jobs } = fixture();
    // The first transaction commits, but its response never reaches the buyer.
    await repository.requestBookingCancellation("fictional-manage-token");
    expect(booking.status).toBe("cancel_pending");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      bookingId: "fictional-booking",
      externalEventId: "fictional-event",
      calendarExternalAccountId: "fictional-account",
    });

    await expect(
      repository.requestBookingCancellation("fictional-manage-token"),
    ).resolves.toBe("cancel_pending");
    expect(jobs).toHaveLength(1);

    // Model the worker having completed the one queued cancellation.
    booking.status = "cancelled";
    await expect(
      repository.requestBookingCancellation("fictional-manage-token"),
    ).resolves.toBe("cancelled");
    expect(jobs).toHaveLength(1);
  });

  it.each(["cancel_pending", "cancelled"])(
    "reports %s without rechecking a cutoff or disconnected account",
    async (status) => {
      const { repository, booking, query, jobs } = fixture(status);
      booking.cancelAllowed = false;
      booking.calendarExternalAccountId = "";
      await expect(
        repository.requestBookingCancellation("fictional-manage-token"),
      ).resolves.toBe(status);
      expect(query).toHaveBeenCalledOnce();
      expect(jobs).toHaveLength(0);
    },
  );

  it("returns pending after a new eligible cancellation is committed", async () => {
    const { repository, jobs } = fixture();
    await expect(
      repository.requestBookingCancellation("fictional-manage-token"),
    ).resolves.toBe("cancel_pending");
    expect(jobs).toHaveLength(1);
  });

  it("still rejects a new cancellation after its cutoff", async () => {
    const { repository, booking, jobs } = fixture();
    booking.cancelAllowed = false;
    await expect(
      repository.requestBookingCancellation("fictional-manage-token"),
    ).rejects.toBeInstanceOf(BookingChangeCutoffError);
    expect(jobs).toHaveLength(0);
    expect(booking.status).toBe("confirmed");
  });

  it("still rejects a new cancellation against a different calendar account", async () => {
    const { repository, booking, jobs } = fixture();
    booking.calendarExternalAccountId = "replacement-account";
    await expect(
      repository.requestBookingCancellation("fictional-manage-token"),
    ).rejects.toBeInstanceOf(CalendarAccountIdentityError);
    expect(jobs).toHaveLength(0);
    expect(booking.status).toBe("confirmed");
  });

  it.each(["pending", "failed", "reschedule_pending"])(
    "still rejects an ineligible %s booking",
    async (status) => {
      const { repository, jobs } = fixture(status);
      await expect(
        repository.requestBookingCancellation("fictional-manage-token"),
      ).rejects.toThrow("Only confirmed meetings can be cancelled.");
      expect(jobs).toHaveLength(0);
    },
  );
});
