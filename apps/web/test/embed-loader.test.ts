import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const loaderSource = readFileSync(
  new URL("../public/embed/v1.js", import.meta.url),
  "utf8",
);
const bridgeId = "11111111-1111-4111-8111-111111111111";
const pageOrigin = "https://customer.example";
const loaderOrigin = "https://meet.example";

type Listener = (event: FakeEvent) => void;

class FakeEventTarget {
  listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: FakeEvent) {
    if (!event.target) event.target = this;
    for (const listener of this.listeners.get(event.type) ?? [])
      listener(event);
    return !event.defaultPrevented;
  }
}

class FakeEvent {
  type: string;
  bubbles = false;
  detail: unknown;
  target: unknown = null;
  origin = "";
  source: unknown = null;
  data: unknown = null;
  key = "";
  shiftKey = false;
  defaultPrevented = false;

  constructor(
    type: string,
    options: { bubbles?: boolean; cancelable?: boolean; detail?: unknown } = {},
  ) {
    this.type = type;
    this.bubbles = options.bubbles ?? false;
    this.detail = options.detail;
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
}

class FakeElement extends FakeEventTarget {
  nodeType = 1;
  tagName: string;
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  ownerDocument: FakeDocument;
  style: Record<string, string> = {};
  hidden = false;
  textContent = "";
  id = "";
  src = "";
  href = "";
  target = "";
  rel = "";
  title = "";
  type = "";
  loading = "";
  referrerPolicy = "";
  contentWindow: {
    posted: unknown[];
    postMessage: (data: unknown, origin: string) => void;
  };

  constructor(tagName: string, document: FakeDocument) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = document;
    this.contentWindow = {
      posted: [],
      postMessage: (data, origin) => {
        this.contentWindow.posted.push({ data, origin });
      },
    };
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  appendChild(child: FakeElement) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement) {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  insertAdjacentElement(_position: string, child: FakeElement) {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    child.parentNode = this.parentNode;
    this.parentNode.children.splice(index + 1, 0, child);
    return child;
  }

  hasChildNodes() {
    return this.children.length > 0;
  }

  contains(candidate: unknown): boolean {
    return (
      candidate === this ||
      this.children.some((child) => child.contains(candidate))
    );
  }

  matches(selector: string) {
    if (selector === "[data-hot-potato-router]") {
      return this.attributes.has("data-hot-potato-router");
    }
    if (selector === "[data-hot-potato-form-bridge]") {
      return this.attributes.has("data-hot-potato-form-bridge");
    }
    if (selector === "[data-hot-potato-bridge-modal]") {
      return this.attributes.has("data-hot-potato-bridge-modal");
    }
    if (selector === "[data-hot-potato-resume]") {
      return this.attributes.has("data-hot-potato-resume");
    }
    if (selector === "[data-hot-potato-focus-start]") {
      return this.attributes.has("data-hot-potato-focus-start");
    }
    if (selector === "[data-hot-potato-focus-end]") {
      return this.attributes.has("data-hot-potato-focus-end");
    }
    if (selector === "script[src]") {
      return this.tagName === "SCRIPT" && Boolean(this.src);
    }
    if (selector === "iframe") return this.tagName === "IFRAME";
    if (selector === "a[href]")
      return this.tagName === "A" && Boolean(this.href);
    if (selector === "button:not([disabled])") {
      return this.tagName === "BUTTON" && !this.attributes.has("disabled");
    }
    return false;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const selectors = selector.split(",").map((value) => value.trim());
    const matches: FakeElement[] = [];
    for (const child of this.children) {
      if (selectors.some((candidate) => child.matches(candidate))) {
        matches.push(child);
      }
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  focus() {
    this.ownerDocument.activeElement = this;
    this.dispatchEvent(new FakeEvent("focus"));
  }
}

class FakeDocument extends FakeEventTarget {
  nodeType = 9;
  baseURI = `${pageOrigin}/pricing`;
  readyState = "complete";
  documentElement: FakeElement;
  body: FakeElement;
  currentScript: FakeElement;
  activeElement: FakeElement;

  constructor() {
    super();
    this.documentElement = new FakeElement("html", this);
    this.body = new FakeElement("body", this);
    this.body.style.overflow = "auto";
    this.documentElement.appendChild(this.body);
    this.currentScript = new FakeElement("script", this);
    this.currentScript.src = `${loaderOrigin}/embed/v1.js`;
    this.activeElement = this.body;
  }

  createElement(tagName: string) {
    return new FakeElement(tagName, this);
  }

  querySelectorAll(selector: string) {
    const matches = this.documentElement.matches(selector)
      ? [this.documentElement]
      : [];
    return matches.concat(this.documentElement.querySelectorAll(selector));
  }

  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

class FakeMutationObserver {
  observe() {}
}

type BridgeConfig = {
  provider: "hubspot" | "manual";
  formId: string | null;
  allowedOrigins: string[];
  mapping: {
    attendeeNameFields: string[];
    attendeeEmailField: string;
    answerMappings: Record<string, string>;
  };
  routerPath: string;
};

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    provider: "manual",
    formId: null,
    allowedOrigins: [pageOrigin],
    mapping: {
      attendeeNameFields: ["first_name", "last_name"],
      attendeeEmailField: "work_email",
      answerMappings: { company_size: "employee_count" },
    },
    routerPath: "/r/acme/talk-to-sales",
    ...overrides,
  };
}

type Timer = { callback: () => void; milliseconds: number };

function harness(responseConfig: unknown = config()) {
  const document = new FakeDocument();
  const marker = document.createElement("div");
  marker.setAttribute("data-hot-potato-form-bridge", bridgeId);
  document.body.appendChild(marker);

  const timers = new Map<number, Timer>();
  let timerSequence = 0;
  const requests: Array<{ url: string; options: Record<string, unknown> }> = [];
  const responseConfigs = Array.isArray(responseConfig)
    ? responseConfig
    : [responseConfig];
  const windowTarget = new FakeEventTarget();
  const window = Object.assign(windowTarget, {
    location: { origin: pageOrigin, assign: vi.fn() },
    parent: null as unknown,
    fetch: vi.fn((url: string, options: Record<string, unknown>) => {
      requests.push({ url, options });
      const response =
        responseConfigs[
          Math.min(requests.length - 1, responseConfigs.length - 1)
        ];
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(JSON.stringify(response)),
      });
    }),
    setTimeout: (callback: () => void, milliseconds: number) => {
      timerSequence += 1;
      timers.set(timerSequence, { callback, milliseconds });
      return timerSequence;
    },
    clearTimeout: (id: number) => timers.delete(id),
    HotPotatoForms: undefined as
      | {
          open: (
            id: string,
            input: { submissionId: string; values: Record<string, unknown> },
          ) => Promise<{ ok: boolean; error?: string }>;
        }
      | undefined,
    HubSpotFormsV4: undefined as unknown,
  });
  window.parent = window;
  const context = vm.createContext({
    window,
    document,
    URL,
    Promise,
    CustomEvent: FakeEvent,
    MutationObserver: FakeMutationObserver,
    Node: { ELEMENT_NODE: 1 },
    encodeURIComponent,
    isFinite,
  });
  vm.runInContext(loaderSource, context, { filename: "embed/v1.js" });

  const events: FakeEvent[] = [];
  for (const name of [
    "error",
    "ready",
    "step",
    "booked",
    "no_slots",
    "disqualified",
    "closed",
    "height",
  ]) {
    marker.addEventListener(`hotpotato:${name}`, (event) => events.push(event));
  }

  function realm<T>(value: T): T {
    (context as Record<string, unknown>).__json = JSON.stringify(value);
    return vm.runInContext("JSON.parse(__json)", context) as T;
  }

  function modal() {
    return document.querySelector("[data-hot-potato-bridge-modal]");
  }

  function iframe() {
    return modal()?.querySelector("iframe") ?? null;
  }

  function message(
    data: unknown,
    options: { origin?: string; source?: unknown } = {},
  ) {
    const event = new FakeEvent("message");
    event.origin = options.origin ?? loaderOrigin;
    event.source = options.source ?? iframe()?.contentWindow ?? null;
    event.data = realm(data);
    window.dispatchEvent(event);
  }

  function runTimer(milliseconds: number) {
    const match = [...timers.entries()].find(
      ([, timer]) => timer.milliseconds === milliseconds,
    );
    if (!match) throw new Error(`No ${milliseconds}ms timer found`);
    timers.delete(match[0]);
    match[1].callback();
  }

  return {
    context,
    document,
    events,
    iframe,
    marker,
    message,
    modal,
    realm,
    requests,
    runTimer,
    timers,
    window,
  };
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function openManually(
  instance: ReturnType<typeof harness>,
  submissionId = "submission-1",
) {
  const input = instance.realm({
    submissionId,
    values: {
      first_name: "  Ada  ",
      last_name: " Lovelace ",
      work_email: " ADA@EXAMPLE.COM ",
      employee_count: 250,
      private_notes: "must never leave the host page",
    },
  });
  return instance.window.HotPotatoForms!.open(bridgeId, input);
}

describe("form bridge embed loader", () => {
  it("fetches strict configuration without credentials and rejects an unlisted origin", async () => {
    const instance = harness(
      config({ allowedOrigins: ["https://other.example"] }),
    );
    await flush();

    expect(instance.requests).toEqual([
      {
        url: `${loaderOrigin}/api/router-form-bridges/${bridgeId}`,
        options: {
          method: "GET",
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
        },
      },
    ]);
    expect(instance.events.map((event) => event.detail)).toContainEqual({
      code: "bridge_origin_not_allowed",
    });
    expect(instance.modal()).toBeNull();
  });

  it("rejects malformed or over-broad configuration without touching the marker content", async () => {
    const invalid = {
      ...config(),
      unexpected: "not allowed",
    };
    const instance = harness(invalid);
    const original = instance.document.createElement("span");
    original.textContent = "Native thank-you";
    instance.marker.appendChild(original);
    await flush();

    expect(instance.marker.firstChild).toBe(original);
    expect(instance.events.map((event) => event.detail)).toContainEqual({
      code: "invalid_bridge_config",
    });
    expect(instance.modal()).toBeNull();
  });

  it("retries a failed configuration fetch when a verified manual submission arrives", async () => {
    const invalid = { ...config(), unexpected: "not allowed" };
    const instance = harness([invalid, config()]);
    await flush();

    const completion = openManually(instance, "manual-config-retry");
    await flush();

    expect(instance.requests).toHaveLength(2);
    expect(instance.iframe()).not.toBeNull();
    instance.message({ source: "hot-potato", version: 1, event: "ready" });
    await expect(completion).resolves.toEqual({ ok: true });
  });

  it("shares one fresh retry when verified submissions outpace a failing prefetch", async () => {
    const invalid = { ...config(), unexpected: "not allowed" };
    const instance = harness([invalid, config()]);

    const first = openManually(instance, "pending-config-a");
    const second = openManually(instance, "pending-config-b");
    await flush();

    expect(instance.requests).toHaveLength(2);
    await expect(first).resolves.toEqual({ ok: false, error: "replaced" });
    instance.message({ source: "hot-potato", version: 1, event: "ready" });
    await expect(second).resolves.toEqual({ ok: true });
  });

  it("maps only configured values and sends PII once after a validated ready message", async () => {
    const instance = harness();
    await flush();
    const completion = openManually(instance);
    await flush();

    const iframe = instance.iframe();
    expect(iframe).not.toBeNull();
    expect(iframe!.src).toBe(
      `${loaderOrigin}/r/acme/talk-to-sales?embed=1&bridge=${bridgeId}&parentOrigin=${encodeURIComponent(pageOrigin)}`,
    );
    expect(iframe!.src).not.toContain("ADA");
    expect(iframe!.src).not.toContain("private_notes");

    instance.message(
      { source: "hot-potato", version: 1, event: "ready", extra: "bad" },
      {},
    );
    instance.message(
      { source: "hot-potato", version: 1, event: "ready" },
      { origin: "https://evil.example" },
    );
    instance.message(
      { source: "hot-potato", version: 1, event: "ready" },
      { source: {} },
    );
    expect(iframe!.contentWindow.posted).toHaveLength(0);

    instance.message({ source: "hot-potato", version: 1, event: "ready" });
    await expect(completion).resolves.toEqual({ ok: true });
    expect(iframe!.contentWindow.posted).toEqual([
      {
        origin: loaderOrigin,
        data: {
          source: "hot-potato-host",
          version: 1,
          command: "submit",
          submissionId: "submission-1",
          submission: {
            attendeeName: "Ada Lovelace",
            attendeeEmail: "ada@example.com",
            answers: { company_size: "250" },
          },
        },
      },
    ]);

    instance.message({ source: "hot-potato", version: 1, event: "ready" });
    expect(iframe!.contentWindow.posted).toHaveLength(1);
    const publicDetails = JSON.stringify(
      instance.events.map((event) => event.detail),
    );
    expect(publicDetails).not.toContain("ada@example.com");
    expect(publicDetails).not.toContain("Lovelace");
  });

  it("accepts bracket and slash source fields used by manual and HubSpot forms", async () => {
    const instance = harness(
      config({
        mapping: {
          attendeeNameFields: ["contact[first_name]", "0-1/lastname"],
          attendeeEmailField: "0-1/email",
          answerMappings: { company_size: "company[employee_count]" },
        },
      }),
    );
    await flush();
    const completion = instance.window.HotPotatoForms!.open(
      bridgeId,
      instance.realm({
        submissionId: "printable-source-fields",
        values: {
          "contact[first_name]": "Ada",
          "0-1/lastname": "Lovelace",
          "0-1/email": "ada@example.com",
          "company[employee_count]": 250,
        },
      }),
    );
    await flush();

    instance.message({ source: "hot-potato", version: 1, event: "ready" });
    await expect(completion).resolves.toEqual({ ok: true });
    expect(instance.iframe()!.contentWindow.posted).toEqual([
      {
        origin: loaderOrigin,
        data: {
          source: "hot-potato-host",
          version: 1,
          command: "submit",
          submissionId: "printable-source-fields",
          submission: {
            attendeeName: "Ada Lovelace",
            attendeeEmail: "ada@example.com",
            answers: { company_size: "250" },
          },
        },
      },
    ]);
  });

  it("suppresses duplicate submission IDs for the same bridge", async () => {
    const instance = harness();
    await flush();
    const first = openManually(instance, "conversion-123");
    await flush();
    instance.message({ source: "hot-potato", version: 1, event: "ready" });
    await expect(first).resolves.toEqual({ ok: true });

    const second = openManually(instance, "conversion-123");
    await expect(second).resolves.toEqual({
      ok: false,
      error: "duplicate_submission",
    });
    expect(instance.document.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("keeps an accepted bridge session alive and offers a PII-free resume control after close", async () => {
    const instance = harness();
    await flush();
    const completion = openManually(instance, "resume-after-close");
    await flush();
    const iframe = instance.iframe()!;

    instance.message({ source: "hot-potato", version: 1, event: "ready" });
    await expect(completion).resolves.toEqual({ ok: true });
    expect(iframe.contentWindow.posted).toHaveLength(1);

    const closeButton = instance.modal()!.children[0]!.children[2]!;
    closeButton.dispatchEvent(new FakeEvent("click"));

    expect(instance.modal()).not.toBeNull();
    expect(instance.modal()!.hidden).toBe(true);
    expect(instance.document.body.style.overflow).toBe("auto");
    const resume = instance.marker.querySelector("[data-hot-potato-resume]")!;
    expect(resume.textContent).toBe("Resume scheduling");
    const publicResumeMarkup = JSON.stringify({
      text: resume.textContent,
      attributes: [...resume.attributes.entries()],
    });
    expect(publicResumeMarkup).not.toContain("ada@example.com");
    expect(publicResumeMarkup).not.toContain("Lovelace");

    resume.dispatchEvent(new FakeEvent("click"));
    expect(instance.modal()!.hidden).toBe(false);
    expect(instance.document.body.style.overflow).toBe("hidden");
    expect(instance.iframe()).toBe(iframe);
    expect(iframe.contentWindow.posted).toHaveLength(1);

    instance.message({
      source: "hot-potato",
      version: 1,
      event: "booked",
      redirectUrl: null,
      redirectDelaySeconds: 5,
    });
    closeButton.dispatchEvent(new FakeEvent("click"));
    expect(resume.textContent).toBe("View meeting details");
    expect(
      instance.events
        .filter((event) => event.type === "hotpotato:closed")
        .map((event) => event.detail),
    ).toEqual([{ booked: false }, { booked: true }]);

    const duplicate = openManually(instance, "resume-after-close");
    await expect(duplicate).resolves.toEqual({
      ok: false,
      error: "duplicate_submission",
    });
  });

  it("redirects only after a validated confirmed-booking message and lets the host cancel", async () => {
    const instance = harness();
    await flush();
    const completion = openManually(instance, "redirect-after-booking");
    await flush();
    instance.message({ source: "hot-potato", version: 1, event: "ready" });
    await expect(completion).resolves.toEqual({ ok: true });

    instance.message({
      source: "hot-potato",
      version: 1,
      event: "booked",
      redirectUrl: "javascript:alert(1)",
      redirectDelaySeconds: 4,
    });
    expect(
      instance.events.some((event) => event.type === "hotpotato:booked"),
    ).toBe(false);

    instance.message({
      source: "hot-potato",
      version: 1,
      event: "booked",
      redirectUrl: "https://customer.example/thank-you?booked=1",
      redirectDelaySeconds: 4,
    });
    expect(instance.events.at(-1)?.detail).toEqual({
      redirectUrl: "https://customer.example/thank-you?booked=1",
      redirectDelaySeconds: 4,
    });
    instance.runTimer(4_000);
    expect(instance.window.location.assign).toHaveBeenCalledWith(
      "https://customer.example/thank-you?booked=1",
    );

    const closed = harness();
    await flush();
    const closedCompletion = openManually(closed, "close-before-redirect");
    await flush();
    closed.message({ source: "hot-potato", version: 1, event: "ready" });
    await expect(closedCompletion).resolves.toEqual({ ok: true });
    closed.message({
      source: "hot-potato",
      version: 1,
      event: "booked",
      redirectUrl: "https://customer.example/thank-you",
      redirectDelaySeconds: 6,
    });
    expect(
      [...closed.timers.values()].some((timer) => timer.milliseconds === 6_000),
    ).toBe(true);
    closed
      .modal()!
      .children[0]!.children[2]!.dispatchEvent(new FakeEvent("click"));
    expect(
      [...closed.timers.values()].some((timer) => timer.milliseconds === 6_000),
    ).toBe(false);
    expect(closed.window.location.assign).not.toHaveBeenCalled();

    const cancelled = harness();
    cancelled.marker.addEventListener("hotpotato:booked", (event) =>
      event.preventDefault(),
    );
    await flush();
    const cancelledCompletion = openManually(cancelled, "cancel-redirect");
    await flush();
    cancelled.message({ source: "hot-potato", version: 1, event: "ready" });
    await expect(cancelledCompletion).resolves.toEqual({ ok: true });
    cancelled.message({
      source: "hot-potato",
      version: 1,
      event: "booked",
      redirectUrl: "https://customer.example/thank-you",
      redirectDelaySeconds: 4,
    });
    expect(
      [...cancelled.timers.values()].some(
        (timer) => timer.milliseconds === 4_000,
      ),
    ).toBe(false);
    expect(cancelled.window.location.assign).not.toHaveBeenCalled();
  });

  it("forwards PII-free no-slot and disqualification outcomes", async () => {
    const instance = harness();
    await flush();
    const completion = openManually(instance, "explicit-outcomes");
    await flush();
    instance.message({ source: "hot-potato", version: 1, event: "ready" });
    await expect(completion).resolves.toEqual({ ok: true });

    instance.message({ source: "hot-potato", version: 1, event: "no_slots" });
    instance.message({
      source: "hot-potato",
      version: 1,
      event: "disqualified",
    });

    expect(
      instance.events
        .filter((event) =>
          ["hotpotato:no_slots", "hotpotato:disqualified"].includes(event.type),
        )
        .map((event) => ({ type: event.type, detail: event.detail })),
    ).toEqual([
      { type: "hotpotato:no_slots", detail: {} },
      { type: "hotpotato:disqualified", detail: {} },
    ]);
  });

  it("uses the HubSpot v4 success API and never prevents the native submission", async () => {
    const formId = "22222222-2222-4222-8222-222222222222";
    const instance = harness(config({ provider: "hubspot", formId }));
    await flush();
    vm.runInContext(
      `window.__hubspotCalls = [];
       window.HubSpotFormsV4 = {
         getFormFromEvent: function (event) {
           window.__hubspotCalls.push(event);
           return {
             getFormId: function () { return "${formId}"; },
             getRedirectUrl: function () { return ""; },
             getConversionId: function () { return "conversion-456"; },
             getFormFieldValues: function () {
               return Promise.resolve([
                 { name: "first_name", value: "Grace" },
                 { name: "last_name", value: "Hopper" },
                 { name: "work_email", value: "grace@example.com" },
                 { name: "employee_count", value: ["500", "1000"] },
                 { name: "unmapped_secret", value: "private" }
               ]);
             }
           };
         }
       };`,
      instance.context,
    );
    const success = new FakeEvent("hs-form-event:on-submission:success", {
      detail: instance.realm({ formId, instanceId: "instance-1" }),
    });
    instance.window.dispatchEvent(success);
    await flush();

    expect(success.defaultPrevented).toBe(false);
    expect(instance.iframe()).not.toBeNull();
    instance.message({ source: "hot-potato", version: 1, event: "ready" });
    expect(instance.iframe()!.contentWindow.posted).toEqual([
      {
        origin: loaderOrigin,
        data: {
          source: "hot-potato-host",
          version: 1,
          command: "submit",
          submissionId: "conversion-456",
          submission: {
            attendeeName: "Grace Hopper",
            attendeeEmail: "grace@example.com",
            answers: { company_size: "500, 1000" },
          },
        },
      },
    ]);
  });

  it("retries failed configuration before handling a verified HubSpot success", async () => {
    const formId = "22222222-2222-4222-8222-222222222222";
    const invalid = {
      ...config({ provider: "hubspot", formId }),
      unexpected: "not allowed",
    };
    const instance = harness([
      invalid,
      config({ provider: "hubspot", formId }),
    ]);
    await flush();
    vm.runInContext(
      `window.HubSpotFormsV4 = {
         getFormFromEvent: function () {
           return {
             getFormId: function () { return "${formId}"; },
             getRedirectUrl: function () { return ""; },
             getConversionId: function () { return "hubspot-config-retry"; },
             getFormFieldValues: function () {
               return Promise.resolve([
                 { name: "first_name", value: "Grace" },
                 { name: "last_name", value: "Hopper" },
                 { name: "work_email", value: "grace@example.com" },
                 { name: "employee_count", value: "500" }
               ]);
             }
           };
         }
       };`,
      instance.context,
    );
    const success = new FakeEvent("hs-form-event:on-submission:success", {
      detail: instance.realm({ formId }),
    });
    instance.window.dispatchEvent(success);
    await flush();

    expect(success.defaultPrevented).toBe(false);
    expect(instance.requests).toHaveLength(2);
    expect(instance.iframe()).not.toBeNull();
  });

  it("does not open for a HubSpot redirect and leaves native success untouched", async () => {
    const formId = "22222222-2222-4222-8222-222222222222";
    const instance = harness(config({ provider: "hubspot", formId }));
    await flush();
    vm.runInContext(
      `window.HubSpotFormsV4 = {
         getFormFromEvent: function () {
           return {
             getFormId: function () { return "${formId}"; },
             getRedirectUrl: function () { return "https://customer.example/thanks"; },
             getConversionId: function () { return "conversion-redirect"; },
             getFormFieldValues: function () { throw new Error("must not read"); }
           };
         }
       };`,
      instance.context,
    );
    const success = new FakeEvent("hs-form-event:on-submission:success", {
      detail: instance.realm({ formId }),
    });
    instance.window.dispatchEvent(success);
    await flush();

    expect(success.defaultPrevented).toBe(false);
    expect(instance.modal()).toBeNull();
  });

  it("fails open on iframe timeout and provides a PII-free fallback", async () => {
    const instance = harness();
    await flush();
    const completion = openManually(instance, "timeout-1");
    await flush();
    const staleIframe = instance.iframe()!;
    instance.runTimer(15000);

    await expect(completion).resolves.toEqual({
      ok: false,
      error: "embed_timeout",
    });
    const modal = instance.modal();
    const fallback = modal!.children[0]!.children[3]!;
    expect(fallback.hidden).toBe(false);
    expect(instance.iframe()!.hidden).toBe(true);
    expect(
      JSON.stringify(instance.events.map((event) => event.detail)),
    ).not.toContain("ada@example.com");
    expect(fallback.querySelector("a[href]")!.href).toBe(
      `${loaderOrigin}/r/acme/talk-to-sales`,
    );
    instance.message(
      { source: "hot-potato", version: 1, event: "ready" },
      { source: staleIframe.contentWindow },
    );
    expect(staleIframe.contentWindow.posted).toHaveLength(0);
    expect(fallback.hidden).toBe(false);

    const retry = openManually(instance, "timeout-1");
    await flush();
    instance.message({ source: "hot-potato", version: 1, event: "ready" });
    await expect(retry).resolves.toEqual({ ok: true });
  });

  it("releases the submission after an iframe load failure so it can retry", async () => {
    const instance = harness();
    await flush();
    const first = openManually(instance, "load-failure-retry");
    await flush();
    instance.iframe()!.dispatchEvent(new FakeEvent("error"));
    await expect(first).resolves.toEqual({
      ok: false,
      error: "embed_load_failed",
    });

    const retry = openManually(instance, "load-failure-retry");
    await flush();
    instance.message({ source: "hot-potato", version: 1, event: "ready" });
    await expect(retry).resolves.toEqual({ ok: true });
  });

  it("traps focus on only the visible controls while loading and in fallback", async () => {
    const instance = harness();
    await flush();
    const completion = openManually(instance, "focus-trap");
    await flush();
    const dialog = instance.modal()!.children[0]!;
    const startSentinel = dialog.querySelector(
      "[data-hot-potato-focus-start]",
    )!;
    const endSentinel = dialog.querySelector("[data-hot-potato-focus-end]")!;
    const closeButton = dialog.children[2]!;
    const fallback = dialog.children[3]!;
    const iframe = dialog.children[4]!;

    expect(instance.document.activeElement).toBe(closeButton);
    expect(fallback.hidden).toBe(true);
    expect(iframe.hidden).toBe(true);
    const loadingTab = new FakeEvent("keydown");
    loadingTab.key = "Tab";
    instance.modal()!.dispatchEvent(loadingTab);
    expect(loadingTab.defaultPrevented).toBe(true);
    expect(instance.document.activeElement).toBe(closeButton);
    endSentinel.focus();
    expect(instance.document.activeElement).toBe(closeButton);
    startSentinel.focus();
    expect(instance.document.activeElement).toBe(closeButton);

    instance.runTimer(15000);
    await expect(completion).resolves.toEqual({
      ok: false,
      error: "embed_timeout",
    });
    const fallbackLink = fallback.querySelector("a[href]")!;
    fallbackLink.focus();
    const fallbackTab = new FakeEvent("keydown");
    fallbackTab.key = "Tab";
    instance.modal()!.dispatchEvent(fallbackTab);
    expect(fallbackTab.defaultPrevented).toBe(true);
    expect(instance.document.activeElement).toBe(closeButton);

    const fallbackShiftTab = new FakeEvent("keydown");
    fallbackShiftTab.key = "Tab";
    fallbackShiftTab.shiftKey = true;
    instance.modal()!.dispatchEvent(fallbackShiftTab);
    expect(fallbackShiftTab.defaultPrevented).toBe(true);
    expect(instance.document.activeElement).toBe(fallbackLink);
    endSentinel.focus();
    expect(instance.document.activeElement).toBe(closeButton);
    startSentinel.focus();
    expect(instance.document.activeElement).toBe(fallbackLink);
  });

  it("catches parent navigation after the ready iframe before focus reaches the host page", async () => {
    const instance = harness();
    const hostBefore = instance.document.createElement("button");
    instance.document.body.appendChild(hostBefore);
    await flush();
    const completion = openManually(instance, "ready-focus-trap");
    await flush();
    const hostAfter = instance.document.createElement("button");
    instance.document.body.appendChild(hostAfter);
    instance.message({ source: "hot-potato", version: 1, event: "ready" });
    await expect(completion).resolves.toEqual({ ok: true });
    const dialog = instance.modal()!.children[0]!;
    const startSentinel = dialog.querySelector(
      "[data-hot-potato-focus-start]",
    )!;
    const endSentinel = dialog.querySelector("[data-hot-potato-focus-end]")!;
    const closeButton = dialog.children[2]!;
    const iframe = dialog.children[4]!;

    // A cross-origin iframe's keydown cannot bubble to the parent. Focusing the
    // boundary sentinels models the browser returning to the parent navigation
    // sequence after Tab or Shift+Tab leaves that browsing context.
    iframe.focus();
    endSentinel.focus();
    expect(instance.document.activeElement).toBe(closeButton);
    expect(instance.document.activeElement).not.toBe(hostAfter);
    startSentinel.focus();
    expect(instance.document.activeElement).toBe(iframe);
    expect(instance.document.activeElement).not.toBe(hostBefore);
  });

  it("restores focus and body scrolling when Escape closes the dialog", async () => {
    const instance = harness();
    const trigger = instance.document.createElement("button");
    instance.document.body.appendChild(trigger);
    trigger.focus();
    await flush();
    const completion = openManually(instance, "escape-1");
    await flush();
    expect(
      instance.document.querySelector("[data-hot-potato-focus-start]"),
    ).not.toBeNull();

    expect(instance.document.body.style.overflow).toBe("hidden");
    const escape = new FakeEvent("keydown");
    escape.key = "Escape";
    instance.modal()!.dispatchEvent(escape);
    await expect(completion).resolves.toEqual({ ok: false, error: "closed" });
    expect(instance.modal()).toBeNull();
    expect(
      instance.document.querySelector("[data-hot-potato-focus-start]"),
    ).toBeNull();
    expect(
      instance.document.querySelector("[data-hot-potato-focus-end]"),
    ).toBeNull();
    expect(instance.document.body.style.overflow).toBe("auto");
    expect(instance.document.activeElement).toBe(trigger);

    const retry = openManually(instance, "escape-1");
    await flush();
    instance.message({ source: "hot-potato", version: 1, event: "ready" });
    await expect(retry).resolves.toEqual({ ok: true });
  });

  it("releases the submission when opening the modal fails before readiness", async () => {
    const instance = harness();
    await flush();
    const originalAppendChild = instance.document.body.appendChild.bind(
      instance.document.body,
    );
    let shouldFail = true;
    instance.document.body.appendChild = (child: FakeElement) => {
      if (
        shouldFail &&
        child.getAttribute("data-hot-potato-bridge-modal") !== null
      ) {
        shouldFail = false;
        throw new Error("simulated modal mount failure");
      }
      return originalAppendChild(child);
    };

    const first = openManually(instance, "open-failure-retry");
    await expect(first).resolves.toEqual({
      ok: false,
      error: "bridge_open_failed",
    });
    expect(instance.modal()).toBeNull();

    const retry = openManually(instance, "open-failure-retry");
    await flush();
    instance.message({ source: "hot-potato", version: 1, event: "ready" });
    await expect(retry).resolves.toEqual({ ok: true });
  });

  it("keeps the original inline iframe embed behavior", async () => {
    const instance = harness();
    const inline = instance.document.createElement("div");
    inline.setAttribute(
      "data-hot-potato-router",
      `${loaderOrigin}/r/acme/talk-to-sales`,
    );
    const fallback = instance.document.createElement("a");
    fallback.textContent = "Book a meeting";
    inline.appendChild(fallback);
    instance.document.body.appendChild(inline);
    (
      instance.window as unknown as {
        __hotPotatoEmbedV1: { scan: (root: FakeElement) => void };
      }
    ).__hotPotatoEmbedV1.scan(inline);

    const iframe = inline.querySelector("iframe")!;
    expect(iframe.src).toContain("embed=1");
    expect(iframe.hidden).toBe(true);
    const ready = new FakeEvent("message");
    ready.origin = loaderOrigin;
    ready.source = iframe.contentWindow;
    ready.data = instance.realm({
      source: "hot-potato",
      version: 1,
      event: "ready",
    });
    instance.window.dispatchEvent(ready);
    expect(iframe.hidden).toBe(false);
    expect(inline.getAttribute("aria-busy")).toBeNull();
  });
});
