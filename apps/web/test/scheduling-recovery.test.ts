import { describe, expect, it, vi } from "vitest";
import {
  parseSchedulingRecovery,
  readSchedulingStatus,
  schedulingRecoveryKey,
  schedulingRejectionMayUnlock,
  submitSchedulingRequest,
  type SchedulingRecovery,
} from "../components/scheduling-recovery";

const recovery: SchedulingRecovery = {
  version: 1,
  submitted: true,
  request: {
    organizationSlug: "fictional",
    schedulingSlug: "demo",
    externalId: "c7107764-17a5-410e-93a5-043f124066e1",
    startsAt: "2031-01-01T15:00:00.000Z",
    attendeeName: "Fictional Visitor",
    attendeeEmail: "visitor@example.test",
    additionalAttendeeEmails: ["guest@example.test"],
    website: "",
  },
  endsAt: "2031-01-01T15:30:00.000Z",
};

describe("personal scheduling recovery", () => {
  it("restores the exact request after a reload so retries keep the same id and details", async () => {
    const restored = parseSchedulingRecovery(
      JSON.stringify(recovery),
      "fictional",
      "demo",
    );
    expect(restored).toEqual(recovery);
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    await expect(
      submitSchedulingRequest(recovery.request, send),
    ).rejects.toThrow("response lost");
    await submitSchedulingRequest(restored!.request, send);
    const requests = send.mock.calls.map(([url, options]) => ({
      url,
      method: options?.method,
      body: options?.body,
    }));
    expect(requests[0]).toEqual(requests[1]);
  });

  it("checking a missing booking only reads its status and never submits another booking", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 404 }));
    await readSchedulingStatus(recovery.request, send);
    expect(send).toHaveBeenCalledOnce();
    const [url, options] = send.mock.calls[0]!;
    expect(url).toContain(`externalId=${recovery.request.externalId}`);
    expect(options).toMatchObject({
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
  });

  it.each([404, 409, 422])(
    "only unlocks an explicitly rejected first request (%s)",
    (status) => {
      expect(
        schedulingRejectionMayUnlock({ ...recovery, submitted: false }, status),
      ).toBe(true);
      expect(schedulingRejectionMayUnlock(recovery, status)).toBe(false);
      const restored = parseSchedulingRecovery(
        JSON.stringify(recovery),
        "fictional",
        "demo",
      )!;
      expect(schedulingRejectionMayUnlock(restored, status)).toBe(false);
    },
  );

  it("scopes saved requests to the exact organization and scheduling link", () => {
    const raw = JSON.stringify(recovery);
    expect(parseSchedulingRecovery(raw, "another", "demo")).toBeNull();
    expect(parseSchedulingRecovery(raw, "fictional", "another")).toBeNull();
    expect(schedulingRecoveryKey("fictional", "demo")).not.toEqual(
      schedulingRecoveryKey("fictional", "another"),
    );
  });

  it.each([
    "not json",
    "null",
    "{}",
    JSON.stringify({ ...recovery, version: 2 }),
    JSON.stringify({ ...recovery, endsAt: recovery.request.startsAt }),
    JSON.stringify({
      ...recovery,
      request: { ...recovery.request, externalId: "bad" },
    }),
    JSON.stringify({
      ...recovery,
      request: { ...recovery.request, additionalAttendeeEmails: [null] },
    }),
  ])("rejects invalid or incompatible recovery data", (raw) => {
    expect(parseSchedulingRecovery(raw, "fictional", "demo")).toBeNull();
  });

  it("does not replay unexpected properties from browser storage", () => {
    const raw = JSON.stringify({
      ...recovery,
      request: { ...recovery.request, isAdmin: true },
    });
    expect(parseSchedulingRecovery(raw, "fictional", "demo")).toEqual(recovery);
  });
});
