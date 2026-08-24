import { describe, expect, it, vi } from "vitest";
import { GoogleCalendarAdapter } from "../src/index.js";

describe("Google Calendar free/busy", () => {
  it("returns only representatives with overlapping busy periods", async () => {
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        items: Array<{ id: string }>;
      };
      expect(body.items).toEqual([
        { id: "ada@acme.example" },
        { id: "marcus@acme.example" },
      ]);
      return Response.json({
        calendars: {
          "ada@acme.example": {
            busy: [
              {
                start: "2026-08-24T16:00:00Z",
                end: "2026-08-24T16:30:00Z",
              },
            ],
          },
          "marcus@acme.example": { busy: [] },
        },
      });
    });
    const adapter = new GoogleCalendarAdapter(
      async () => "access-token",
      request,
    );

    const busy = await adapter.busyRepEmails({
      repEmails: ["ada@acme.example", "marcus@acme.example"],
      startsAt: new Date("2026-08-24T16:00:00Z"),
      endsAt: new Date("2026-08-24T16:30:00Z"),
    });

    expect(busy).toEqual(["ada@acme.example"]);
  });

  it("fails closed when a calendar cannot be checked", async () => {
    const adapter = new GoogleCalendarAdapter(
      async () => "access-token",
      async () => Response.json({ calendars: {} }),
    );
    await expect(
      adapter.busyRepEmails({
        repEmails: ["ada@acme.example"],
        startsAt: new Date("2026-08-24T16:00:00Z"),
        endsAt: new Date("2026-08-24T16:30:00Z"),
      }),
    ).rejects.toThrow("could not verify availability");
  });
});
