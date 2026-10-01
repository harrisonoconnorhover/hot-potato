import { beforeEach, describe, expect, it, vi } from "vitest";

const repositoryMocks = vi.hoisted(() => ({
  reporting: vi.fn(),
  recordBookingAttendance: vi.fn(),
}));

vi.mock("../app/repository", () => ({
  repository: repositoryMocks,
}));

import { PUT } from "../app/api/reporting/attendance/route";
import { GET } from "../app/api/reporting/route";

const bookingId = "3dc7de9f-10bb-476d-84dc-7607abbe8ef3";

describe("reporting API", () => {
  beforeEach(() => {
    repositoryMocks.reporting.mockReset();
    repositoryMocks.recordBookingAttendance.mockReset();
  });

  it("falls back to the seven-day report for unsupported ranges", async () => {
    repositoryMocks.reporting.mockResolvedValue({ rangeDays: 7 });

    const response = await GET(
      new Request("https://schedule.example/api/reporting?days=365"),
    );

    expect(response.status).toBe(200);
    expect(repositoryMocks.reporting).toHaveBeenCalledWith("acme", 7);
    await expect(response.json()).resolves.toEqual({ rangeDays: 7 });
  });

  it("rejects invalid attendance updates before touching the repository", async () => {
    const response = await PUT(
      new Request("https://schedule.example/api/reporting/attendance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookingId: "not-a-booking", outcome: "late" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(repositoryMocks.recordBookingAttendance).not.toHaveBeenCalled();
  });

  it("rejects a null JSON body without escaping validation", async () => {
    const response = await PUT(
      new Request("https://schedule.example/api/reporting/attendance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "null",
      }),
    );

    expect(response.status).toBe(400);
    expect(repositoryMocks.recordBookingAttendance).not.toHaveBeenCalled();
  });

  it("records a scoped no-show and reports ineligible meetings safely", async () => {
    repositoryMocks.recordBookingAttendance
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const request = () =>
      new Request("https://schedule.example/api/reporting/attendance", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookingId, outcome: "no_show" }),
      });

    const updated = await PUT(request());
    const ineligible = await PUT(request());

    expect(updated.status).toBe(200);
    expect(ineligible.status).toBe(409);
    expect(repositoryMocks.recordBookingAttendance).toHaveBeenCalledWith({
      organizationSlug: "acme",
      bookingId,
      outcome: "no_show",
    });
  });
});
