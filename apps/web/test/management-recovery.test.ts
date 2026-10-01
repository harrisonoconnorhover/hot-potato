import { describe, expect, it, vi } from "vitest";
import type { ManagedBookingView } from "../app/managed-booking";
import {
  managementChangeObserved,
  managementRejectionMayUnlock,
  submitManagementChange,
} from "../components/management-recovery";

const change = {
  action: "cancel",
  token: "fictional-management-token",
} as const;

describe("management response recovery", () => {
  it("keeps a rejected retry locked after an earlier ambiguous action", () => {
    const rejected = { accepted: false, uncertain: false };
    expect(managementRejectionMayUnlock(rejected, false)).toBe(true);
    expect(managementRejectionMayUnlock(rejected, true)).toBe(false);
    expect(
      managementRejectionMayUnlock({ accepted: false, uncertain: true }, false),
    ).toBe(false);
  });
  it("keeps a dropped response uncertain and preserves the same action for retry", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    expect(await submitManagementChange(change, send)).toMatchObject({
      accepted: false,
      uncertain: true,
    });
    expect(await submitManagementChange(change, send)).toEqual({
      accepted: true,
      uncertain: false,
      error: null,
    });
    const requests = send.mock.calls.map(([url, options]) => ({
      url,
      method: options?.method,
      body: options?.body,
    }));
    expect(requests[0]).toEqual(requests[1]);
  });

  it("uses a successful HTTP acknowledgement even if its body was interrupted", async () => {
    const response = new Response("{", { status: 202 });
    const send = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect(await submitManagementChange(change, send)).toEqual({
      accepted: true,
      uncertain: false,
      error: null,
    });
  });

  it.each([400, 404, 409])(
    "unlocks after an explicit %s rejection, even with a non-JSON error page",
    async (status) => {
      const send = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("Unavailable", { status }));
      expect(await submitManagementChange(change, send)).toMatchObject({
        accepted: false,
        uncertain: false,
      });
    },
  );

  it("keeps server failures uncertain because the write may have completed", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("Unavailable", { status: 503 }));
    expect(await submitManagementChange(change, send)).toMatchObject({
      accepted: false,
      uncertain: true,
    });
  });

  it("does not mistake the original confirmed time for a completed reschedule", () => {
    const reschedule = {
      ...change,
      action: "reschedule",
      startsAt: "2031-01-02T15:00:00.000Z",
    } as const;
    const before = {
      status: "confirmed",
      startsAt: "2031-01-01T15:00:00.000Z",
    } as ManagedBookingView;
    expect(managementChangeObserved(reschedule, before)).toBe(false);
    expect(
      managementChangeObserved(reschedule, {
        ...before,
        startsAt: reschedule.startsAt,
        status: "reschedule_pending",
      }),
    ).toBe(true);
    expect(
      managementChangeObserved(reschedule, {
        ...before,
        startsAt: reschedule.startsAt,
      }),
    ).toBe(true);
  });

  it("requires the cancellation to be observed before unlocking another action", () => {
    expect(
      managementChangeObserved(change, {
        status: "confirmed",
      } as ManagedBookingView),
    ).toBe(false);
    expect(
      managementChangeObserved(change, {
        status: "cancel_pending",
      } as ManagedBookingView),
    ).toBe(true);
    expect(
      managementChangeObserved(change, {
        status: "cancelled",
      } as ManagedBookingView),
    ).toBe(true);
  });
});
