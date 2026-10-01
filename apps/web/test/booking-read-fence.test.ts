import { describe, expect, it, vi } from "vitest";
import { createBookingReadFence } from "../components/booking-read-fence";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("management read ordering", () => {
  it("does not let an earlier confirmed read overwrite a later cancellation", async () => {
    const fence = createBookingReadFence();
    const old = deferred<string>();
    const apply = vi.fn();
    const fail = vi.fn();
    const initial = fence.run(() => old.promise, apply, fail);
    fence.invalidate(); // User starts a cancellation while initial GET is still in flight.
    await fence.run(async () => "cancelled", apply, fail);
    old.resolve("confirmed");
    expect(await initial).toBeNull();
    expect(apply.mock.calls).toEqual([["cancelled"]]);
    expect(fail).not.toHaveBeenCalled();
  });

  it("does not let an old network failure replace the latest successful status", async () => {
    const fence = createBookingReadFence();
    const old = deferred<string>();
    const apply = vi.fn();
    const fail = vi.fn();
    const initial = fence.run(() => old.promise, apply, fail);
    await fence.run(async () => "reschedule_pending", apply, fail);
    old.reject(new TypeError("offline"));
    expect(await initial).toBeNull();
    expect(apply.mock.calls).toEqual([["reschedule_pending"]]);
    expect(fail).not.toHaveBeenCalled();
  });

  it("discards a pre-mutation view even before the new status check begins", async () => {
    const fence = createBookingReadFence();
    const old = deferred<string>();
    const apply = vi.fn();
    const fail = vi.fn();
    const initial = fence.run(() => old.promise, apply, fail);
    fence.invalidate();
    old.resolve("confirmed");
    expect(await initial).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });
});
