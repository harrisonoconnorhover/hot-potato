const bookingRequestDeadlineMs = 15_000;

/** Bound both the connection and response body, even if a transport ignores abort. */
export async function fetchBookingJson<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  send: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number; body: T }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new Error(
          "The booking service did not respond. Check the same request again.",
        ),
      );
    }, bookingRequestDeadlineMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await send(input, {
          ...init,
          signal: controller.signal,
        });
        const raw = await response.text();
        let body: unknown = {};
        try {
          body = JSON.parse(raw);
        } catch {
          /* An incomplete response is handled by the caller. */
        }
        return {
          ok: response.ok,
          status: response.status,
          body: (typeof body === "object" && body !== null ? body : {}) as T,
        };
      })(),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
