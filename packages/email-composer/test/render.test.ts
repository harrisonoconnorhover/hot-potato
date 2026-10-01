import { describe, expect, it } from "vitest";
import {
  createEmailTimeChoices,
  emailTimezoneLabel,
  emailTimezoneOptions,
  formatSuggestedSlot,
  revalidateEmailTimeSelection,
  renderBookingLink,
  renderSuggestedTimes,
  safeBookingUrl,
  selectSuggestedSlots,
  type EmailComposerAsset,
} from "../src/index.js";

const asset: EmailComposerAsset = {
  id: "meeting-1",
  kind: "meeting_type",
  slug: "product-tour",
  title: "Product tour",
  description: "See Hot Potato",
  bookingUrl: "https://hot.example/schedule/acme/product-tour",
  hostName: "Revenue team",
  durationMinutes: 30,
};

describe("email rendering", () => {
  it("offers a stable cross-client timezone list and preserves uncommon valid zones", () => {
    const common = emailTimezoneOptions("America/New_York");
    expect(
      common.find((option) => option.value === "America/New_York"),
    ).toEqual({ value: "America/New_York", label: "Eastern — New York" });
    expect(common.some((option) => option.value === "Asia/Tokyo")).toBe(true);

    const uncommon = emailTimezoneOptions("Pacific/Honolulu");
    expect(uncommon[0]).toEqual({
      value: "Pacific/Honolulu",
      label: "Pacific / Honolulu",
    });
    expect(emailTimezoneOptions("Mars/Olympus_Mons")[0]?.value).toBe("UTC");
    expect(emailTimezoneLabel("Europe/Paris")).toBe("Paris");
  });

  it("escapes database labels and URL attributes", () => {
    const rendered = renderBookingLink({
      ...asset,
      title: '<img src=x onerror="alert(1)">',
      bookingUrl: "https://hot.example/schedule/acme/product-tour?a=1&b=2",
    });
    expect(rendered.html).not.toContain("<img");
    expect(rendered.html).toContain("&lt;img");
    expect(rendered.html).toContain("a=1&amp;b=2");
  });

  it("rejects unsafe scheduling URL schemes and credentials", () => {
    expect(() => safeBookingUrl("javascript:alert(1)")).toThrow();
    expect(() => safeBookingUrl("https://user:pass@hot.example/x")).toThrow();
  });

  it("renders email-safe HTML and an equivalent plain-text fallback", () => {
    const rendered = renderSuggestedTimes({
      asset,
      timezone: "America/New_York",
      slots: [
        {
          startsAt: "2026-11-02T15:00:00.000Z",
          endsAt: "2026-11-02T15:30:00.000Z",
          label: "Monday, November 2 at 10:00 AM EST",
          bookingUrl:
            "https://hot.example/schedule/acme/product-tour?time=2026-11-02T15%3A00%3A00.000Z",
        },
      ],
    });
    expect(rendered.html).toContain("<ul><li><a href=");
    expect(rendered.html).toContain("America/New York");
    expect(rendered.text).toContain("Monday, November 2 at 10:00 AM EST");
    expect(rendered.text).toContain("See more times for Product tour");
  });

  it("does not render suggested times for a Smart Router Link", () => {
    expect(() =>
      renderSuggestedTimes({
        asset: { ...asset, kind: "router_link" },
        timezone: "UTC",
        slots: [
          {
            startsAt: "2026-09-02T14:00:00.000Z",
            endsAt: "2026-09-02T14:30:00.000Z",
            label: "Wednesday, September 2 at 2:00 PM UTC",
            bookingUrl: asset.bookingUrl,
          },
        ],
      }),
    ).toThrow("only be inserted as links");
  });
});

describe("suggested slots", () => {
  it("spreads the first choices across local days before filling early slots", () => {
    const slots = [
      ["2026-09-01T13:00:00.000Z", "2026-09-01T13:30:00.000Z"],
      ["2026-09-01T14:00:00.000Z", "2026-09-01T14:30:00.000Z"],
      ["2026-09-02T13:00:00.000Z", "2026-09-02T13:30:00.000Z"],
      ["2026-09-03T13:00:00.000Z", "2026-09-03T13:30:00.000Z"],
    ].map(([startsAt, endsAt]) => ({ startsAt: startsAt!, endsAt: endsAt! }));
    expect(selectSuggestedSlots(slots, 3, "America/New_York")).toEqual([
      slots[0],
      slots[2],
      slots[3],
    ]);
    expect(selectSuggestedSlots(slots, 5, "America/New_York")).toEqual([
      slots[0],
      slots[2],
      slots[3],
      slots[1],
    ]);
  });

  it("formats DST-aware timezone labels and rejects unknown zones", () => {
    expect(
      formatSuggestedSlot("2026-11-02T15:00:00.000Z", "America/New_York"),
    ).toContain("EST");
    expect(() => selectSuggestedSlots([], 3, "Mars/Olympus_Mons")).toThrow(
      "valid timezone",
    );
  });

  it("builds twelve fresh choices and preselects three diverse local days", () => {
    const slotsPerDay = 16;
    const available = Array.from({ length: slotsPerDay * 4 }, (_, index) => {
      const startsAt = new Date(
        Date.UTC(
          2026,
          8,
          1 + Math.floor(index / slotsPerDay),
          8 + Math.floor((index % slotsPerDay) / 2),
          (index % 2) * 30,
        ),
      );
      return {
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
      };
    });
    const choices = createEmailTimeChoices({
      asset,
      available: [available[0]!, ...available, available[2]!],
      timezone: "America/New_York",
      locale: "en-us",
    });

    expect(choices.choices).toHaveLength(12);
    expect(choices.selectedStartsAt).toEqual([
      available[0]!.startsAt,
      available[slotsPerDay]!.startsAt,
      available[slotsPerDay * 2]!.startsAt,
    ]);
    expect(
      choices.choices.reduce<Record<string, number>>((counts, choice) => {
        const day = choice.startsAt.slice(0, 10);
        counts[day] = (counts[day] ?? 0) + 1;
        return counts;
      }, {}),
    ).toEqual({
      "2026-09-01": 4,
      "2026-09-02": 4,
      "2026-09-03": 4,
    });
    expect(choices.locale).toBe("en-US");
    expect(choices.choices[0]?.bookingUrl).toContain(
      `time=${encodeURIComponent(available[0]!.startsAt)}`,
    );
  });

  it("revalidates one to five distinct live choices and rejects malformed or stale choices", () => {
    const choices = createEmailTimeChoices({
      asset,
      available: [
        {
          startsAt: "2026-09-01T13:00:00.000Z",
          endsAt: "2026-09-01T13:30:00.000Z",
        },
        {
          startsAt: "2026-09-02T13:00:00.000Z",
          endsAt: "2026-09-02T13:30:00.000Z",
        },
      ],
      timezone: "UTC",
    }).choices;

    expect(
      revalidateEmailTimeSelection({
        choices,
        selectedStartsAt: choices.map((choice) => choice.startsAt),
      }),
    ).toMatchObject({ ok: true, slots: choices });
    for (const selectedStartsAt of [
      [],
      [choices[0]!.startsAt, choices[0]!.startsAt],
      [
        "2026-09-01T13:00:00.000Z",
        "2026-09-02T13:00:00.000Z",
        "2026-09-03T13:00:00.000Z",
        "2026-09-04T13:00:00.000Z",
        "2026-09-05T13:00:00.000Z",
        "2026-09-06T13:00:00.000Z",
      ],
      ["not-a-date"],
    ]) {
      expect(
        revalidateEmailTimeSelection({ choices, selectedStartsAt }),
      ).toEqual({ ok: false, reason: "invalid_selection" });
    }
    expect(
      revalidateEmailTimeSelection({
        choices,
        selectedStartsAt: ["2026-09-03T13:00:00.000Z"],
      }),
    ).toEqual({ ok: false, reason: "stale_selection" });
  });

  it("formats choices in the sender locale and rejects invalid locales", () => {
    expect(
      formatSuggestedSlot("2026-11-02T15:00:00.000Z", "Europe/Paris", "fr-FR"),
    ).toMatch(/lundi/i);
    expect(() =>
      formatSuggestedSlot("2026-11-02T15:00:00.000Z", "UTC", "not a locale"),
    ).toThrow("valid locale");
  });
});
