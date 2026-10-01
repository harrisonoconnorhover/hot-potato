import { describe, expect, it, vi } from "vitest";
import {
  groupOutlookChoices,
  initialOutlookSchedulingSelection,
  officeInsert,
  OutlookRenderRequestError,
  rememberOutlookSchedulingChoice,
  requestFreshOutlookContent,
  runFreshOutlookMutation,
  toggleOutlookChoice,
  type OfficeRuntime,
} from "../components/outlook-email-composer";

const content = {
  html: '<p><a href="https://hot.example">Book</a></p>',
  text: "Book: https://hot.example",
};

const selectedStartsAt = ["2026-11-02T15:00:00.000Z"];

const freshRender = {
  content,
  slots: [
    {
      startsAt: selectedStartsAt[0]!,
      endsAt: "2026-11-02T15:30:00.000Z",
      label: "Monday at 10:00 AM",
      bookingUrl: "https://hot.example/?time=2026-11-02T15%3A00%3A00.000Z",
    },
  ],
};

const staleRender = {
  error: "Availability changed before insertion. Review the refreshed choices.",
  code: "stale_times",
  choices: [
    {
      startsAt: "2026-11-03T15:00:00.000Z",
      endsAt: "2026-11-03T15:30:00.000Z",
      label: "Tuesday at 10:00 AM",
      bookingUrl: "https://hot.example/?time=2026-11-03T15%3A00%3A00.000Z",
    },
  ],
  selectedStartsAt: ["2026-11-03T15:00:00.000Z"],
  timezone: "America/New_York",
  locale: "en-US",
};

function contentRequest() {
  return {
    accessKey: "hp_email_test",
    assetId: "850e8400-e29b-41d4-a716-446655440000",
    mode: "times" as const,
    timezone: "America/New_York",
    locale: "en-US",
    selectedStartsAt,
  };
}

function fakeOffice(input: {
  bodyType?: "html" | "text";
  getTypeSucceeds?: boolean;
  htmlSucceeds?: boolean;
  textSucceeds?: boolean;
}) {
  const calls: Array<{ data: string; coercionType: string }> = [];
  const succeeded = "succeeded";
  const runtime: OfficeRuntime = {
    onReady: () => undefined,
    AsyncResultStatus: { Succeeded: succeeded },
    CoercionType: { Html: "html", Text: "text" },
    context: {
      mailbox: {
        item: {
          body: {
            getTypeAsync: (callback) =>
              callback({
                status: input.getTypeSucceeds === false ? "failed" : succeeded,
                value: input.bodyType ?? "html",
                error: { message: "type failed" },
              }),
            setSelectedDataAsync: (data, options, callback) => {
              calls.push({ data, coercionType: options.coercionType });
              const ok =
                options.coercionType === "html"
                  ? input.htmlSucceeds !== false
                  : input.textSucceeds !== false;
              callback({
                status: ok ? succeeded : "failed",
                value: undefined,
                error: { message: `${options.coercionType} failed` },
              });
            },
          },
        },
      },
    },
  };
  return { runtime, calls };
}

describe("Outlook compose host", () => {
  it("records the last successful link or live-time choice without draft data", async () => {
    const request = vi.fn(
      async (_path: string, _key: string, _init?: RequestInit) =>
        new Response(null, { status: 200 }),
    );
    await expect(
      rememberOutlookSchedulingChoice(
        {
          accessKey: "hp_email_test",
          purpose: "link",
          assetId: "11111111-1111-4111-8111-111111111111",
        },
        request,
      ),
    ).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith(
      "/api/email-tools/preferences",
      "hp_email_test",
      {
        method: "POST",
        body: JSON.stringify({
          purpose: "link",
          assetId: "11111111-1111-4111-8111-111111111111",
        }),
      },
    );
    expect(String(request.mock.calls[0]?.[2]?.body)).not.toMatch(
      /draft|recipient|subject|attachment/i,
    );
  });

  it("reopens the last successful mode and never starts router links in live-time mode", () => {
    const meeting = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "meeting_type" as const,
      slug: "intro",
      title: "Intro",
      description: "",
      bookingUrl: "https://hot.example/schedule/acme/intro",
      hostName: "Ada",
      durationMinutes: 30,
    };
    const router = {
      id: "22222222-2222-4222-8222-222222222222",
      kind: "router_link" as const,
      slug: "sales",
      title: "Sales",
      description: "",
      bookingUrl: "https://hot.example/r/acme/sales",
      hostName: null,
      durationMinutes: null,
    };
    expect(
      initialOutlookSchedulingSelection({
        assets: [meeting, router],
        recentLinkAssetId: router.id,
        recentMeetingTypeId: meeting.id,
        recentPurpose: "link",
      }),
    ).toEqual({ assetId: router.id, mode: "link" });
    expect(
      initialOutlookSchedulingSelection({
        assets: [router, meeting],
        recentLinkAssetId: router.id,
        recentMeetingTypeId: meeting.id,
        recentPurpose: "times",
      }),
    ).toEqual({ assetId: meeting.id, mode: "times" });
    expect(
      initialOutlookSchedulingSelection({
        assets: [router],
        recentLinkAssetId: null,
        recentMeetingTypeId: null,
        recentPurpose: null,
      }),
    ).toEqual({ assetId: router.id, mode: "link" });
  });

  it("inserts matching HTML or plain text at the cursor", async () => {
    const html = fakeOffice({ bodyType: "html" });
    await expect(officeInsert(content, html.runtime)).resolves.toBe("html");
    expect(html.calls).toEqual([{ data: content.html, coercionType: "html" }]);

    const text = fakeOffice({ bodyType: "text" });
    await expect(officeInsert(content, text.runtime)).resolves.toBe("text");
    expect(text.calls).toEqual([{ data: content.text, coercionType: "text" }]);
  });

  it("reports the plain-text fallback and fails when Outlook rejects both formats", async () => {
    const fallback = fakeOffice({ bodyType: "html", htmlSucceeds: false });
    await expect(officeInsert(content, fallback.runtime)).resolves.toBe(
      "text_fallback",
    );
    expect(fallback.calls.map((call) => call.coercionType)).toEqual([
      "html",
      "text",
    ]);

    const failed = fakeOffice({
      bodyType: "html",
      htmlSucceeds: false,
      textSucceeds: false,
    });
    await expect(officeInsert(content, failed.runtime)).rejects.toThrow(
      "text failed",
    );
    await expect(officeInsert(content, undefined)).rejects.toThrow(
      "Open this pane from an Outlook message",
    );
  });

  it("groups choices in the sender locale and caps selection at five", () => {
    const choices = [
      "2026-11-02T15:00:00.000Z",
      "2026-11-02T16:00:00.000Z",
    ].map((startsAt) => ({
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
      label: startsAt,
      bookingUrl: `https://hot.example/?time=${encodeURIComponent(startsAt)}`,
    }));
    const groups = groupOutlookChoices(choices, "Europe/Paris", "fr-FR");
    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toMatch(/lundi/i);

    const five = Array.from({ length: 5 }, (_, index) => `slot-${index}`);
    expect(toggleOutlookChoice(five, "slot-5")).toEqual({
      selected: five,
      error: "Choose at most five times.",
    });
    expect(toggleOutlookChoice(five, "slot-2")).toEqual({
      selected: ["slot-0", "slot-1", "slot-3", "slot-4"],
      error: null,
    });
  });

  it.each(["insert", "copy"])(
    "rejects a cached preview when %s finds the selected time stale",
    async () => {
      let requestCount = 0;
      const request = vi.fn(
        async (
          _path: string,
          _key: string,
          _init?: RequestInit,
        ): Promise<Response> => {
          requestCount += 1;
          return requestCount === 1
            ? new Response(JSON.stringify(freshRender), { status: 200 })
            : new Response(JSON.stringify(staleRender), { status: 409 });
        },
      );
      const preview = await requestFreshOutlookContent(
        contentRequest(),
        request,
      );
      expect(preview.content).toEqual(content);

      const mutate = vi.fn(async () => undefined);
      const lock = { current: false };
      const caught = await runFreshOutlookMutation({
        lock,
        refresh: async () =>
          (await requestFreshOutlookContent(contentRequest(), request)).content,
        mutate,
      }).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(OutlookRenderRequestError);
      expect(caught).toMatchObject({
        status: 409,
        response: staleRender,
      });

      expect(request).toHaveBeenCalledTimes(2);
      expect(mutate).not.toHaveBeenCalled();
      expect(lock.current).toBe(false);
      const finalRequest = JSON.parse(
        String(request.mock.calls[1]?.[2]?.body),
      ) as Record<string, unknown>;
      expect(finalRequest).toMatchObject({
        mode: "times",
        selectedStartsAt,
        timezone: "America/New_York",
      });
    },
  );

  it("keeps insertion single-shot and locks only overlapping copy attempts", async () => {
    const insertLock = { current: false };
    const insert = vi.fn(async () => "html" as const);
    await expect(
      runFreshOutlookMutation({
        lock: insertLock,
        refresh: async () => content,
        mutate: insert,
        retainLockOnSuccess: true,
      }),
    ).resolves.toMatchObject({ executed: true, result: "html" });
    await expect(
      runFreshOutlookMutation({
        lock: insertLock,
        refresh: async () => content,
        mutate: insert,
        retainLockOnSuccess: true,
      }),
    ).resolves.toEqual({ executed: false });
    expect(insert).toHaveBeenCalledTimes(1);

    let finishCopy: (() => void) | undefined;
    const copyGate = new Promise<void>((resolve) => {
      finishCopy = resolve;
    });
    const copyLock = { current: false };
    const copy = vi.fn(async () => copyGate);
    const firstCopy = runFreshOutlookMutation({
      lock: copyLock,
      refresh: async () => content,
      mutate: copy,
    });
    await expect(
      runFreshOutlookMutation({
        lock: copyLock,
        refresh: async () => content,
        mutate: copy,
      }),
    ).resolves.toEqual({ executed: false });
    finishCopy?.();
    await expect(firstCopy).resolves.toMatchObject({ executed: true });
    await expect(
      runFreshOutlookMutation({
        lock: copyLock,
        refresh: async () => content,
        mutate: copy,
      }),
    ).resolves.toMatchObject({ executed: true });
    expect(copy).toHaveBeenCalledTimes(2);
  });
});
