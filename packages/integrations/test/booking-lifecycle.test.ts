import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GoogleRepCalendarAdapter,
  MicrosoftRepCalendarAdapter,
  type CalendarEventInput,
} from "../src/index.js";

type Provider = "google" | "microsoft";
type EventRecord = {
  id: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees: unknown[];
  [key: string]: unknown;
};

// This provider simulation deliberately keeps state across requests. It models
// Google ID conflicts and Graph transactionId deduplication; it does not prove
// real provider behavior, invite delivery, OAuth, or conference provisioning.
function fictionalCalendar(provider: Provider, missingStatus: 404 | 410) {
  const events = new Map<string, EventRecord>();
  const transactions = new Map<string, string>();
  const responsesToLose = new Set<string>();
  const applied = { creates: 0, updates: 0, deletes: 0 };
  const eventsPath =
    provider === "google"
      ? "/calendar/v3/calendars/primary/events"
      : "/v1.0/me/events";

  const loseResponseAfterWrite = (method: string) => {
    if (responsesToLose.delete(method)) {
      throw new TypeError(`Fictional ${method} response lost after write`);
    }
  };
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe(
      provider === "google"
        ? "https://www.googleapis.com"
        : "https://graph.microsoft.com",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer fictional-lifecycle-token",
    );
    const method = init?.method ?? "GET";
    const body = init?.body
      ? (JSON.parse(String(init.body)) as EventRecord)
      : undefined;

    if (method === "POST" && url.pathname === eventsPath && body) {
      const transactionId = String(body.transactionId);
      const id =
        provider === "google"
          ? body.id
          : (transactions.get(transactionId) ??
            `fictional-event-${transactions.size + 1}`);
      const existing = events.get(id);
      if (existing) {
        return provider === "google"
          ? new Response("Duplicate event ID", { status: 409 })
          : Response.json(existing);
      }
      const event = {
        ...body,
        id,
        ...(provider === "google"
          ? { status: "confirmed" }
          : { isCancelled: false }),
      };
      events.set(id, event);
      transactions.set(transactionId, id);
      applied.creates += 1;
      loseResponseAfterWrite(method);
      return Response.json(event, { status: 201 });
    }

    if (
      provider === "microsoft" &&
      method === "GET" &&
      url.pathname === "/v1.0/me/calendarView"
    ) {
      return Response.json({ value: [...events.values()] });
    }

    expect(url.pathname.startsWith(`${eventsPath}/`)).toBe(true);
    const id = decodeURIComponent(url.pathname.slice(eventsPath.length + 1));
    const event = events.get(id);
    if (!event) return new Response("Event absent", { status: missingStatus });
    if (method === "GET") return Response.json(event);
    if (method === "PATCH" && body) {
      // Rescheduling must keep the existing agenda and attendee roster.
      expect(Object.keys(body).sort()).toEqual(["end", "start"]);
      const updated = { ...event, ...body };
      events.set(id, updated);
      applied.updates += 1;
      loseResponseAfterWrite(method);
      return Response.json(updated);
    }
    if (method === "DELETE") {
      events.delete(id);
      applied.deletes += 1;
      loseResponseAfterWrite(method);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fictional provider request: ${method} ${url}`);
  });

  return { events, responsesToLose, applied, request };
}

function adapterFor(provider: Provider, request: typeof fetch) {
  const token = async () => "fictional-lifecycle-token";
  return provider === "google"
    ? new GoogleRepCalendarAdapter(token, request)
    : new MicrosoftRepCalendarAdapter(token, request);
}

const booking: CalendarEventInput = {
  subject: "Fictional potato planning session",
  startsAt: new Date("2026-10-05T16:00:00Z"),
  endsAt: new Date("2026-10-05T16:30:00Z"),
  attendeeEmail: "buyer@example.test",
  attendeeName: "Fictional Buyer",
  additionalAttendeeEmails: ["guest@example.test"],
  description: "Fictional local rehearsal only",
  transactionId: "fictional-booking-lifecycle",
  conferenceProvider: "none",
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Real network is forbidden in the lifecycle rehearsal");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe.each(["google", "microsoft"] as const)(
  "%s booking lifecycle with an in-memory provider",
  (provider) => {
    it.each([404, 410] as const)(
      "recovers lost responses and repeated submissions, including cancellation retry %s",
      async (missingStatus) => {
        const fake = fictionalCalendar(provider, missingStatus);
        const adapter = adapterFor(provider, fake.request);

        fake.responsesToLose.add("POST");
        await expect(adapter.createEvent(booking)).rejects.toThrow(
          "POST response lost after write",
        );
        expect(fake.events.size).toBe(1);
        const eventId = [...fake.events.keys()][0]!;
        await expect(
          adapter.findEventByTransactionId(booking),
        ).resolves.toMatchObject({ externalEventId: eventId });

        const recovered = await adapter.createEvent(booking);
        expect(recovered.externalEventId).toBe(eventId);
        await expect(adapter.createEvent(booking)).resolves.toEqual(recovered);
        expect(fake.applied.creates).toBe(1);
        expect([...fake.events.keys()]).toEqual([eventId]);
        const original = structuredClone(fake.events.get(eventId)!);
        expect(original.attendees).toHaveLength(2);

        const rescheduled = {
          ...booking,
          startsAt: new Date("2026-10-06T17:00:00Z"),
          endsAt: new Date("2026-10-06T17:30:00Z"),
        };
        fake.responsesToLose.add("PATCH");
        await expect(adapter.updateEvent(eventId, rescheduled)).rejects.toThrow(
          "PATCH response lost after write",
        );
        await expect(
          adapter.updateEvent(eventId, rescheduled),
        ).resolves.toMatchObject({ externalEventId: eventId });
        expect([...fake.events.keys()]).toEqual([eventId]);
        expect(fake.events.get(eventId)).toMatchObject({
          ...original,
          start: {
            dateTime:
              provider === "google"
                ? "2026-10-06T17:00:00.000Z"
                : "2026-10-06T17:00:00",
            timeZone: "UTC",
          },
          end: {
            dateTime:
              provider === "google"
                ? "2026-10-06T17:30:00.000Z"
                : "2026-10-06T17:30:00",
            timeZone: "UTC",
          },
        });
        await expect(
          adapter.findEventByTransactionId(rescheduled),
        ).resolves.toMatchObject({ externalEventId: eventId });

        fake.responsesToLose.add("DELETE");
        await expect(adapter.cancelEvent(eventId)).rejects.toThrow(
          "DELETE response lost after write",
        );
        expect(fake.events.size).toBe(0);
        await expect(adapter.cancelEvent(eventId)).resolves.toBeUndefined();
        await expect(adapter.cancelEvent(eventId)).resolves.toBeUndefined();
        await expect(
          adapter.findEventByTransactionId(rescheduled),
        ).resolves.toBeNull();
        expect(fake.events.size).toBe(0);
        expect(fake.applied).toEqual({ creates: 1, updates: 2, deletes: 1 });
        expect(globalThis.fetch).not.toHaveBeenCalled();
      },
    );

    it.each(["create", "reschedule", "cancel"] as const)(
      "does not write when interrupted during %s token acquisition",
      async (operation) => {
        const controller = new AbortController();
        const token = vi.fn(async () => {
          controller.abort();
          return "fictional-lifecycle-token";
        });
        const request = vi.fn<typeof fetch>();
        const adapter =
          provider === "google"
            ? new GoogleRepCalendarAdapter(token, request)
            : new MicrosoftRepCalendarAdapter(token, request);
        const input = { ...booking, signal: controller.signal };
        const pending =
          operation === "create"
            ? adapter.createEvent(input)
            : operation === "reschedule"
              ? adapter.updateEvent("fictional-event", input)
              : adapter.cancelEvent("fictional-event", controller.signal);

        await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        expect(token).toHaveBeenCalledOnce();
        expect(request).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
      },
    );
  },
);
