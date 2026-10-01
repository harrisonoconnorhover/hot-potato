import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const organizationId = "0a4e20d8-9692-4bf9-afd1-b0a017c02b17";
const operatorId = "d5cfd223-b78f-4497-b108-6bcdf93b8af4";
const repId = "8a90b1e8-f323-4f24-a19c-41b4a7766545";

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  origin: vi.fn(),
  rep: vi.fn(),
  saveSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../app/operator-session", () => ({
  operatorAdminForRequest: mocks.admin,
  requestHasOperatorOrigin: mocks.origin,
}));

vi.mock("../app/operator-rep-calendar", () => ({
  operatorRepCalendarForRequest: mocks.rep,
}));

vi.mock("../app/repository", () => ({
  repository: {
    updateOperatorRepWorkingHours: mocks.update,
    saveAvailabilitySchedule: mocks.saveSchedule,
    deleteAvailabilitySchedule: mocks.deleteSchedule,
  },
}));

import {
  DELETE as deleteSchedule,
  PUT as saveSchedule,
} from "../app/api/settings/availability-schedules/route";
import { PUT as updateAdminHours } from "../app/api/settings/working-hours/route";
import { PUT as updateScopedHours } from "../app/api/settings/reps/[repId]/working-hours/route";

function identity(role: "owner" | "operator" = "operator") {
  return {
    sessionId: "session-1",
    operatorId,
    organizationId,
    organizationSlug: "acme",
    login: "rep@example.com",
    displayName: "Routing Rep",
    role,
    expiresAt: new Date("2026-09-07T12:00:00.000Z"),
  };
}

function request(
  body: unknown,
  path = `reps/${repId}/working-hours`,
  method = "PUT",
) {
  return new Request(`https://schedule.example/api/settings/${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: "https://schedule.example",
    },
    body: JSON.stringify(body),
  });
}

const settings = {
  timezone: "America/New_York",
  availability: {
    monday: [
      { start: "13:00", end: "17:00" },
      { start: "09:00", end: "12:00" },
    ],
  },
  dailyMeetingLimit: 4,
  weeklyMeetingLimit: 18,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.origin.mockReturnValue(true);
  mocks.rep.mockResolvedValue({ identity: identity() });
  mocks.admin.mockResolvedValue({ identity: identity("owner") });
  mocks.update.mockResolvedValue(true);
  mocks.saveSchedule.mockResolvedValue("e3286140-0a87-4ee3-87ac-a2f7a85f5584");
  mocks.deleteSchedule.mockResolvedValue(true);
});

describe("scoped representative working-hours route", () => {
  it("normalizes settings and rechecks exact operator scope during the update", async () => {
    const response = await updateScopedHours(request(settings), {
      params: Promise.resolve({ repId }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.rep).toHaveBeenCalledWith(expect.any(Request), repId, true);
    expect(mocks.update).toHaveBeenCalledWith({
      organizationId,
      operatorId,
      repId,
      timezone: "America/New_York",
      availability: {
        monday: [
          { start: "09:00", end: "12:00" },
          { start: "13:00", end: "17:00" },
        ],
      },
      dailyMeetingLimit: 4,
      weeklyMeetingLimit: 18,
    });
  });

  it("normalizes date overrides before the atomic update", async () => {
    const response = await updateScopedHours(
      request({
        ...settings,
        availabilityOverrides: {
          "2026-09-08": [
            { start: "14:00", end: "17:00" },
            { start: "09:00", end: "12:00" },
          ],
          "2026-09-07": [],
        },
      }),
      { params: Promise.resolve({ repId }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        availabilityOverrides: {
          "2026-09-07": [],
          "2026-09-08": [
            { start: "09:00", end: "12:00" },
            { start: "14:00", end: "17:00" },
          ],
        },
      }),
    );
  });

  it("passes a reusable schedule assignment into the atomic update", async () => {
    const availabilityScheduleId = "e3286140-0a87-4ee3-87ac-a2f7a85f5584";
    const response = await updateScopedHours(
      request({ ...settings, availabilityScheduleId }),
      { params: Promise.resolve({ repId }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ availabilityScheduleId }),
    );
  });

  it("stops before parsing or mutation when friendly scope authorization fails", async () => {
    mocks.rep.mockResolvedValue({
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });
    const response = await updateScopedHours(request(settings), {
      params: Promise.resolve({ repId }),
    });

    expect(response.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("fails closed if access changes before the atomic update", async () => {
    mocks.update.mockResolvedValue(false);
    const response = await updateScopedHours(request(settings), {
      params: Promise.resolve({ repId }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "You no longer have access to update these working hours.",
    });
  });

  it("rejects overlap and oversized bodies before mutation", async () => {
    const overlap = await updateScopedHours(
      request({
        timezone: "UTC",
        availability: {
          monday: [
            { start: "09:00", end: "14:00" },
            { start: "13:00", end: "17:00" },
          ],
        },
      }),
      { params: Promise.resolve({ repId }) },
    );
    expect(overlap.status).toBe(400);

    const oversized = new Request(
      `https://schedule.example/api/settings/reps/${repId}/working-hours`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "content-length": "40000",
          origin: "https://schedule.example",
        },
        body: "{}",
      },
    );
    const tooLarge = await updateScopedHours(oversized, {
      params: Promise.resolve({ repId }),
    });
    expect(tooLarge.status).toBe(413);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects malformed representative identifiers before authorization", async () => {
    const response = await updateScopedHours(request(settings), {
      params: Promise.resolve({ repId: "not-a-rep" }),
    });
    expect(response.status).toBe(404);
    expect(mocks.rep).not.toHaveBeenCalled();
  });
});

describe("administrator working-hours route", () => {
  it("uses the authenticated workspace and atomic updater", async () => {
    const response = await updateAdminHours(
      request({ repId, ...settings }, "working-hours"),
    );

    expect(response.status).toBe(200);
    expect(mocks.admin).toHaveBeenCalledOnce();
    expect(mocks.origin).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, operatorId, repId }),
    );
  });

  it("requires an exact browser origin before mutation", async () => {
    mocks.origin.mockReturnValue(false);
    const response = await updateAdminHours(
      request({ repId, ...settings }, "working-hours"),
    );

    expect(response.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("administrator reusable-schedule route", () => {
  it("normalizes and saves a schedule inside the authenticated workspace", async () => {
    const response = await saveSchedule(
      request(
        {
          name: " Revenue team ",
          availability: {
            monday: [
              { start: "13:00", end: "17:00" },
              { start: "09:00", end: "12:00" },
            ],
          },
        },
        "availability-schedules",
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.saveSchedule).toHaveBeenCalledWith({
      organizationId,
      operatorId,
      name: "Revenue team",
      availability: {
        monday: [
          { start: "09:00", end: "12:00" },
          { start: "13:00", end: "17:00" },
        ],
      },
    });
  });

  it("requires admin origin checks and repeats access during delete", async () => {
    const scheduleId = "e3286140-0a87-4ee3-87ac-a2f7a85f5584";
    const response = await deleteSchedule(
      request({ id: scheduleId }, "availability-schedules", "DELETE"),
    );
    expect(response.status).toBe(200);
    expect(mocks.deleteSchedule).toHaveBeenCalledWith({
      organizationId,
      operatorId,
      id: scheduleId,
    });

    mocks.origin.mockReturnValue(false);
    const rejected = await saveSchedule(
      request({ name: "Blocked", availability: {} }, "availability-schedules"),
    );
    expect(rejected.status).toBe(403);
    expect(mocks.saveSchedule).not.toHaveBeenCalled();
  });

  it("maps duplicate names and access races without exposing internals", async () => {
    mocks.saveSchedule.mockRejectedValue({ code: "23505" });
    const duplicate = await saveSchedule(
      request(
        { name: "Revenue team", availability: {} },
        "availability-schedules",
      ),
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      error: "A reusable schedule already has that name.",
    });

    mocks.saveSchedule.mockResolvedValue(null);
    const forbidden = await saveSchedule(
      request(
        { name: "Revenue team", availability: {} },
        "availability-schedules",
      ),
    );
    expect(forbidden.status).toBe(403);
  });
});
