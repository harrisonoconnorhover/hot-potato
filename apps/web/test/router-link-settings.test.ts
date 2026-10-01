import { describe, expect, it } from "vitest";
import { PUT } from "../app/api/settings/router-links/route";

describe("Smart Router Link settings", () => {
  it("rejects attendee_name as a configurable qualification question", async () => {
    const response = await PUT(
      new Request("https://schedule.example/api/settings/router-links", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Reserved identity field",
          slug: "reserved-identity-field",
          title: "Find the right meeting",
          description: "A draft link used to validate its questions.",
          buttonLabel: "Find my time",
          noMatchMessage: "Our team will follow up.",
          accentColor: "#ff5d2e",
          active: false,
          questions: [
            {
              field: "attendee_name",
              label: "Attendee name",
              type: "text",
              required: true,
              placeholder: "Your name",
              helpText: "",
              options: [],
            },
          ],
          destinations: [],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "That identity field is supplied by the public form.",
    });
  });

  it("rejects unsafe or credential-bearing post-booking redirects", async () => {
    const base = {
      name: "Unsafe redirect",
      slug: "unsafe-redirect",
      title: "Find the right meeting",
      description: "A draft link used to validate its redirect.",
      buttonLabel: "Find my time",
      noMatchMessage: "Our team will follow up.",
      successRedirectDelaySeconds: 5,
      accentColor: "#ff5d2e",
      active: false,
      questions: [],
      destinations: [],
    };
    for (const successRedirectUrl of [
      "http://customer.example/thank-you",
      "https://user:secret@customer.example/thank-you",
      "https://customer.example/thank-you#private",
    ]) {
      const response = await PUT(
        new Request("https://schedule.example/api/settings/router-links", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...base, successRedirectUrl }),
        }),
      );
      expect(response.status).toBe(400);
    }
  });

  it("rejects a redirect delay that skips or overstays confirmation", async () => {
    for (const successRedirectDelaySeconds of [0, 31, 2.5]) {
      const response = await PUT(
        new Request("https://schedule.example/api/settings/router-links", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "Invalid redirect delay",
            slug: "invalid-redirect-delay",
            title: "Find the right meeting",
            description: "A draft link used to validate its redirect delay.",
            buttonLabel: "Find my time",
            noMatchMessage: "Our team will follow up.",
            successRedirectUrl: null,
            successRedirectDelaySeconds,
            accentColor: "#ff5d2e",
            active: false,
            questions: [],
            destinations: [],
          }),
        }),
      );
      expect(response.status).toBe(400);
    }
  });
});
