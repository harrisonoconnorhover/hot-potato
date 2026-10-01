import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBookingJson } from "../components/booking-fetch";
import { submitManagementChange } from "../components/management-recovery";

afterEach(() => vi.useRealTimers());

describe("bounded booking requests", () => {
  it("releases a stalled transport even if it ignores abort", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise(() => {}));
    const result = fetchBookingJson("/api/scheduling/manage", {}, send);
    const assertion = expect(result).rejects.toThrow("did not respond");
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(send.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("also bounds a response whose headers arrive but whose body never completes", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new ReadableStream({ start() {} })));
    const result = fetchBookingJson("/api/scheduling/manage", {}, send);
    const assertion = expect(result).rejects.toThrow("did not respond");
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it("keeps a stalled mutation uncertain instead of allowing another change", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise(() => {}));
    const result = submitManagementChange(
      { action: "cancel", token: "fictional-token" },
      send,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toMatchObject({ accepted: false, uncertain: true });
  });

  it("clears the deadline after a completed response", async () => {
    vi.useFakeTimers();
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ status: "confirmed" }));
    expect(
      await fetchBookingJson("/api/scheduling/bookings", {}, send),
    ).toEqual({ ok: true, status: 200, body: { status: "confirmed" } });
    expect(vi.getTimerCount()).toBe(0);
  });
});
