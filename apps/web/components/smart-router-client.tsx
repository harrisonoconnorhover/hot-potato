"use client";

import type {
  PublicBookingStatus,
  PublicRouterLink,
  RouterLinkMeetingType,
  RouterLinkQuestion,
} from "@hot-potato/db";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import {
  createSmartRouterRecovery,
  parseSmartRouterRecovery,
  reopenSmartRouterAvailability,
  serializeSmartRouterRecovery,
  smartRouterAssignmentLocked,
  smartRouterRecoveryStorageKey,
  type SmartRouterLinkIdentity,
  type SmartRouterRecoveryState,
} from "./smart-router-recovery";
import {
  bookingPollMayReopenAvailability,
  bookingStatusIsDurable,
  bookingStatusIsProcessing,
  slotFromBookingStatus,
} from "./booking-status";
import { AdditionalGuests } from "./additional-guests";

type RouterStep = "details" | "availability" | "confirmation" | "no_match";

type Slot = {
  startsAt: string;
  endsAt: string;
};

type ApiProblem = {
  error?: string | null;
  code?: string;
};

type QualificationResponse = ApiProblem & {
  outcome?: "matched" | "no_match";
  sessionToken?: string;
  expiresAt?: string;
  noMatchMessage?: string;
  meetingType?: RouterLinkMeetingType | null;
};

type AvailabilityResponse = ApiProblem & { slots?: Slot[] };
type BookingResponse = ApiProblem & Partial<PublicBookingStatus>;

type ApiResult<T> = {
  ok: boolean;
  status: number;
  body: T;
  retryAfter: number | null;
};

type DisplayError = { message: string; code: string };

type BridgeSubmission = {
  attendeeName: string;
  attendeeEmail: string;
  answers: Record<string, string>;
};

type BridgeMessage = {
  source: "hot-potato-host";
  version: 1;
  command: "submit";
  submissionId: string;
  submission: BridgeSubmission;
};

const protectedQuestionFields = new Set([
  "email",
  "name",
  "attendee_name",
  "current_owner_email",
]);

const embedSource = "hot-potato";
const embedVersion = 1;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

export function parseBridgeMessage(
  value: unknown,
  questions: RouterLinkQuestion[],
): BridgeMessage | null {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      "source",
      "version",
      "command",
      "submissionId",
      "submission",
    ]) ||
    value.source !== "hot-potato-host" ||
    value.version !== 1 ||
    value.command !== "submit" ||
    typeof value.submissionId !== "string" ||
    value.submissionId.length < 1 ||
    value.submissionId.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(value.submissionId) ||
    !plainRecord(value.submission) ||
    !exactKeys(value.submission, ["attendeeName", "attendeeEmail", "answers"])
  ) {
    return null;
  }

  const attendeeName = value.submission.attendeeName;
  const attendeeEmail = value.submission.attendeeEmail;
  const rawAnswers = value.submission.answers;
  if (
    typeof attendeeName !== "string" ||
    attendeeName.trim().length < 2 ||
    attendeeName.trim().length > 80 ||
    typeof attendeeEmail !== "string" ||
    attendeeEmail.trim().length < 3 ||
    attendeeEmail.trim().length > 320 ||
    !plainRecord(rawAnswers)
  ) {
    return null;
  }

  const expectedFields = questions.map((question) => question.field);
  if (!exactKeys(rawAnswers, expectedFields)) return null;
  const answers: Record<string, string> = {};
  for (const field of expectedFields) {
    const answer = rawAnswers[field];
    if (
      typeof answer !== "string" ||
      answer.length > 500 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(answer)
    ) {
      return null;
    }
    answers[field] = answer;
  }

  return {
    source: "hot-potato-host",
    version: 1,
    command: "submit",
    submissionId: value.submissionId,
    submission: {
      attendeeName: attendeeName.trim(),
      attendeeEmail: attendeeEmail.trim(),
      answers,
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timeout = window.setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

async function postJson<T>(
  url: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<ApiResult<T>> {
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const body = (await response.json().catch(() => ({}))) as T;
  const retryHeader = Number(response.headers.get("retry-after"));
  return {
    ok: response.ok,
    status: response.status,
    body,
    retryAfter:
      Number.isFinite(retryHeader) && retryHeader > 0 ? retryHeader : null,
  };
}

function errorFor<T extends ApiProblem>(
  result: ApiResult<T>,
  fallback: string,
): DisplayError {
  const retry = result.retryAfter
    ? ` Try again in about ${result.retryAfter} seconds.`
    : "";
  return {
    message: `${result.body.error ?? fallback}${retry}`,
    code: result.body.code ?? `http_${result.status}`,
  };
}

function dateKey(value: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dayLabel(value: string): { weekday: string; date: string } {
  const date = new Date(value);
  return {
    weekday: new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(
      date,
    ),
    date: new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(date),
  };
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function longDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function optionLabel(value: string): string {
  if (value === "true") return "Yes";
  if (value === "false") return "No";
  return value;
}

function conferenceName(value: RouterLinkMeetingType["conferenceProvider"]) {
  if (value === "google_meet") return "Google Meet";
  if (value === "microsoft_teams") return "Microsoft Teams";
  if (value === "zoom") return "Zoom";
  return "Calendar invitation";
}

function safeConferenceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function safeManagePath(value: string | null | undefined): string | null {
  return value?.startsWith("/schedule/manage/") ? value : null;
}

function safeSuccessRedirectUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const loopback =
      hostname === "localhost" ||
      hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname);
    return !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === "https:" || (url.protocol === "http:" && loopback))
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function questionAnswer(
  question: RouterLinkQuestion,
  value: string,
): string | number {
  const normalized = value.trim();
  if (question.type !== "number" || normalized === "") return normalized;
  return Number(normalized);
}

function stepNumber(step: RouterStep): number | null {
  if (step === "details") return 1;
  if (step === "availability") return 2;
  if (step === "confirmation") return 3;
  return null;
}

export function SmartRouterClient({
  link,
  embed,
  bridge,
  parentOrigin,
  recoveryOnly = false,
}: {
  link: PublicRouterLink;
  embed: boolean;
  bridge: boolean;
  parentOrigin: string | null;
  recoveryOnly?: boolean;
}) {
  const questions = useMemo(
    () =>
      link.questions.filter(
        (question) => !protectedQuestionFields.has(question.field),
      ),
    [link.questions],
  );
  const linkIdentity = useMemo<SmartRouterLinkIdentity>(
    () => ({
      organizationSlug: link.organizationSlug,
      routerLinkId: link.id,
      routerSlug: link.slug,
    }),
    [link.id, link.organizationSlug, link.slug],
  );
  const recoveryKey = smartRouterRecoveryStorageKey(linkIdentity);
  const [step, setStep] = useState<RouterStep>("details");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [additionalAttendeeEmails, setAdditionalAttendeeEmails] = useState<
    string[]
  >([]);
  const [answers, setAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(questions.map((question) => [question.field, ""])),
  );
  const [website, setWebsite] = useState("");
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [meetingType, setMeetingType] = useState<RouterLinkMeetingType | null>(
    null,
  );
  const [slots, setSlots] = useState<Slot[]>([]);
  const [activeDay, setActiveDay] = useState("");
  const [selected, setSelected] = useState<Slot | null>(null);
  const [booking, setBooking] = useState<BookingResponse | null>(null);
  const [busy, setBusy] = useState<
    | "qualifying"
    | "availability"
    | "booking"
    | "status"
    | "restore"
    | "retry"
    | "abandon"
    | null
  >("restore");
  const [error, setError] = useState<DisplayError | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [noMatchMessage, setNoMatchMessage] = useState(link.noMatchMessage);
  const [recipientTimezone, setRecipientTimezone] = useState("your timezone");
  const [bridgeAwaitingSubmission, setBridgeAwaitingSubmission] =
    useState(bridge);
  const [recovery, setRecovery] = useState<SmartRouterRecoveryState | null>(
    null,
  );
  const [recoveryLoaded, setRecoveryLoaded] = useState(false);
  const [needsNewScheduling, setNeedsNewScheduling] = useState(false);
  const [redirectSecondsRemaining, setRedirectSecondsRemaining] = useState<
    number | null
  >(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const operationRef = useRef<AbortController | null>(null);
  const initialStep = useRef(true);
  const sentBooked = useRef(false);
  const lastEmbedError = useRef<string | null>(null);
  const bridgeSubmissionIds = useRef(new Set<string>());
  const bridgeSubmission = useRef<BridgeSubmission | null>(null);
  const recoveryRef = useRef<SmartRouterRecoveryState | null>(null);
  const recoveryLoadKeyRef = useRef<string | null>(null);
  const recoveryPendingRef = useRef(false);
  const recoveryAttemptRef = useRef<string | null>(null);

  const baseApiPath = `/api/router-links/${encodeURIComponent(link.organizationSlug)}/${encodeURIComponent(link.slug)}`;
  const successRedirectUrl = useMemo(
    () => safeSuccessRedirectUrl(link.successRedirectUrl),
    [link.successRedirectUrl],
  );

  const beginOperation = useCallback(() => {
    operationRef.current?.abort();
    const controller = new AbortController();
    operationRef.current = controller;
    return controller;
  }, []);

  const persistRecovery = useCallback(
    (value: SmartRouterRecoveryState) => {
      recoveryRef.current = value;
      try {
        window.sessionStorage.setItem(
          recoveryKey,
          serializeSmartRouterRecovery(value),
        );
      } catch {
        // The in-memory session remains locked when browser storage is blocked.
      }
      setRecovery(value);
    },
    [recoveryKey],
  );

  const clearRecovery = useCallback(() => {
    try {
      window.sessionStorage.removeItem(recoveryKey);
    } catch {
      // Clear the in-memory session even if storage is unavailable.
    }
    recoveryRef.current = null;
    recoveryPendingRef.current = false;
    recoveryAttemptRef.current = null;
    setRecovery(null);
  }, [recoveryKey]);

  const postEmbed = useCallback(
    (
      event:
        | "ready"
        | "step"
        | "booked"
        | "no_slots"
        | "disqualified"
        | "error"
        | "height",
      detail: {
        step?: RouterStep;
        code?: string;
        height?: number;
        redirectUrl?: string | null;
        redirectDelaySeconds?: number;
      } = {},
    ) => {
      if (!embed || !parentOrigin || window.parent === window) return;
      window.parent.postMessage(
        { source: embedSource, version: embedVersion, event, ...detail },
        parentOrigin,
      );
    },
    [embed, parentOrigin],
  );

  useEffect(() => {
    if (recoveryLoadKeyRef.current === recoveryKey) return;
    operationRef.current?.abort();
    recoveryLoadKeyRef.current = recoveryKey;
    recoveryRef.current = null;
    recoveryPendingRef.current = false;
    recoveryAttemptRef.current = null;
    setRecovery(null);
    setRecoveryLoaded(false);
    setBusy("restore");
    let raw: string | null = null;
    try {
      raw = window.sessionStorage.getItem(recoveryKey);
    } catch {
      // Treat unavailable session storage as an empty recovery store.
    }
    const recovered = parseSmartRouterRecovery(raw, linkIdentity);
    if (raw && !recovered) {
      try {
        window.sessionStorage.removeItem(recoveryKey);
      } catch {
        // Invalid state remains unusable even if it cannot be removed.
      }
    }
    recoveryPendingRef.current = Boolean(recovered);
    if (recovered) {
      persistRecovery(recovered);
    } else {
      setBusy(null);
      if (recoveryOnly) {
        setNeedsNewScheduling(true);
        setStep("confirmation");
        setAnnouncement(
          "This Smart Link is no longer accepting new scheduling requests.",
        );
      }
    }
    setRecoveryLoaded(true);
  }, [linkIdentity, persistRecovery, recoveryKey, recoveryOnly]);

  useEffect(() => {
    if (!recoveryLoaded || !recovery || !recoveryPendingRef.current) {
      return;
    }
    const attemptKey = `${recovery.routerLinkId ?? recovery.routerSlug}:${recovery.sessionToken}`;
    if (recoveryAttemptRef.current === attemptKey) return;
    recoveryAttemptRef.current = attemptKey;
    void restoreScheduling(recovery);
    // Recovery runs only for state loaded from storage, not state created by
    // the qualification request in this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryLoaded, recovery?.routerLinkId, recovery?.sessionToken]);

  useEffect(() => {
    if (!recovery || recovery.routerSlug === link.slug) return;
    persistRecovery({ ...recovery, routerSlug: link.slug });
  }, [link.slug, persistRecovery, recovery]);

  useEffect(() => {
    setRecipientTimezone(
      Intl.DateTimeFormat().resolvedOptions().timeZone || "your timezone",
    );
    postEmbed("ready");
    return () => operationRef.current?.abort();
  }, [postEmbed]);

  useEffect(() => {
    postEmbed("step", { step });
    if (initialStep.current) {
      initialStep.current = false;
      return;
    }
    window.requestAnimationFrame(() => headingRef.current?.focus());
  }, [postEmbed, step]);

  useEffect(() => {
    if (!error || lastEmbedError.current === error.code) return;
    lastEmbedError.current = error.code;
    postEmbed("error", { code: error.code });
  }, [error, postEmbed]);

  useEffect(() => {
    if (booking?.status !== "confirmed" || sentBooked.current) return;
    sentBooked.current = true;
    postEmbed("booked", {
      redirectUrl: successRedirectUrl,
      redirectDelaySeconds: link.successRedirectDelaySeconds,
    });
  }, [
    booking?.status,
    link.successRedirectDelaySeconds,
    postEmbed,
    successRedirectUrl,
  ]);

  useEffect(() => {
    if (booking?.status !== "confirmed" || !successRedirectUrl) {
      setRedirectSecondsRemaining(null);
      return;
    }
    const delay = link.successRedirectDelaySeconds;
    setRedirectSecondsRemaining(delay);
    const interval = window.setInterval(() => {
      setRedirectSecondsRemaining((current) =>
        current === null ? null : Math.max(0, current - 1),
      );
    }, 1_000);
    const redirectTimer = embed
      ? null
      : window.setTimeout(() => {
          window.location.assign(successRedirectUrl);
        }, delay * 1_000);
    return () => {
      window.clearInterval(interval);
      if (redirectTimer !== null) window.clearTimeout(redirectTimer);
    };
  }, [
    booking?.status,
    embed,
    link.successRedirectDelaySeconds,
    successRedirectUrl,
  ]);

  useEffect(() => {
    if (!embed || !parentOrigin || !rootRef.current) return;
    let frame = 0;
    const sendHeight = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const height = Math.max(
          240,
          Math.min(5_000, Math.ceil(document.documentElement.scrollHeight)),
        );
        postEmbed("height", { height });
      });
    };
    const observer = new ResizeObserver(sendHeight);
    observer.observe(rootRef.current);
    sendHeight();
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [embed, parentOrigin, postEmbed]);

  const days = useMemo(() => {
    const grouped = new Map<string, Slot[]>();
    for (const slot of slots) {
      const key = dateKey(slot.startsAt);
      const group = grouped.get(key) ?? [];
      group.push(slot);
      grouped.set(key, group);
    }
    return [...grouped.entries()];
  }, [slots]);

  function rememberSelected(slot: Slot | null) {
    setSelected(slot);
    const current = recoveryRef.current;
    if (current) persistRecovery({ ...current, selectedSlot: slot });
  }

  function requireNewScheduling(message: string) {
    setSlots([]);
    setBooking(null);
    setNeedsNewScheduling(true);
    setStep("confirmation");
    setError({ message, code: "session_expired" });
    setAnnouncement(message);
  }

  function startNewScheduling() {
    if (recoveryOnly) return;
    operationRef.current?.abort();
    clearRecovery();
    setName("");
    setEmail("");
    setAdditionalAttendeeEmails([]);
    setAnswers(
      Object.fromEntries(questions.map((question) => [question.field, ""])),
    );
    setWebsite("");
    setSessionToken(null);
    setMeetingType(null);
    setSlots([]);
    setActiveDay("");
    setSelected(null);
    setBooking(null);
    setNeedsNewScheduling(false);
    setNoMatchMessage(link.noMatchMessage);
    setError(null);
    setBusy(null);
    sentBooked.current = false;
    lastEmbedError.current = null;
    bridgeSubmission.current = null;
    setBridgeAwaitingSubmission(bridge);
    setStep("details");
    setAnnouncement(
      bridge
        ? "Ready for another verified form handoff."
        : "Ready to schedule another meeting.",
    );
  }

  async function loadAvailability(
    token: string,
    controller = beginOperation(),
    staleMessage?: string,
    staleMessageIsError = true,
  ): Promise<boolean> {
    setBusy("availability");
    if (!staleMessage) setError(null);
    setAnnouncement("Checking live calendar availability.");
    try {
      const result = await postJson<AvailabilityResponse>(
        `${baseApiPath}/availability`,
        { sessionToken: token },
        controller.signal,
      );
      if (!result.ok || !Array.isArray(result.body.slots)) {
        if (recoveryOnly && result.status === 404) {
          clearRecovery();
          requireNewScheduling(
            "No booking was found, and this Smart Link is no longer accepting new requests.",
          );
          return false;
        }
        if (result.status === 410) {
          requireNewScheduling(
            "Your routing session expired before a booking was created. Start over explicitly to continue.",
          );
          return false;
        }
        const problem = errorFor(
          result,
          "Live availability could not be loaded. Please try again.",
        );
        setError(problem);
        setAnnouncement(problem.message);
        return false;
      }
      rememberSelected(null);
      setSlots(result.body.slots);
      if (result.body.slots.length === 0) postEmbed("no_slots");
      const firstDay = result.body.slots[0]
        ? dateKey(result.body.slots[0].startsAt)
        : "";
      setActiveDay(firstDay);
      setNeedsNewScheduling(false);
      setStep("availability");
      const message =
        staleMessage ??
        (result.body.slots.length > 0
          ? "Live times are ready. Choose a time to continue."
          : "No live times are currently available.");
      setAnnouncement(message);
      setError(
        staleMessage && staleMessageIsError
          ? { message: staleMessage, code: "slot_unavailable" }
          : null,
      );
      return true;
    } catch (caught) {
      if (isAbortError(caught)) return false;
      const problem = {
        message:
          "Live availability could not be loaded. Check your connection and try again.",
        code: "network_error",
      };
      setError(problem);
      setAnnouncement(problem.message);
      return false;
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  async function qualify(
    event?: FormEvent<HTMLFormElement>,
    submitted?: BridgeSubmission,
  ) {
    event?.preventDefault();
    if (recoveryOnly) return;
    if (recoveryRef.current) {
      const problem = {
        message:
          "This scheduling session is already active. Return to it or explicitly start over before submitting different details.",
        code: "scheduling_session_active",
      };
      setError(problem);
      setAnnouncement(problem.message);
      return;
    }
    const controller = beginOperation();
    setBusy("qualifying");
    setError(null);
    setBooking(null);
    sentBooked.current = false;
    setAnnouncement("Matching your details to the right calendar.");
    const submittedAnswers = submitted?.answers ?? answers;
    const normalizedAnswers = Object.fromEntries(
      questions.map((question) => [
        question.field,
        questionAnswer(question, submittedAnswers[question.field] ?? ""),
      ]),
    );

    try {
      const result = await postJson<QualificationResponse>(
        `${baseApiPath}/qualify`,
        {
          attendeeName: submitted?.attendeeName ?? name,
          attendeeEmail: submitted?.attendeeEmail ?? email,
          answers: normalizedAnswers,
          website,
        },
        controller.signal,
      );

      if (result.body.outcome === "no_match") {
        const message = result.body.noMatchMessage ?? link.noMatchMessage;
        clearRecovery();
        setNoMatchMessage(message);
        setSessionToken(null);
        setStep("no_match");
        postEmbed("disqualified");
        setAnnouncement(message);
        setBusy(null);
        return;
      }
      if (
        !result.ok ||
        result.body.outcome !== "matched" ||
        !result.body.sessionToken ||
        !result.body.meetingType
      ) {
        const problem = errorFor(
          result,
          "Your details could not be matched. Please check them and try again.",
        );
        setError(problem);
        setAnnouncement(problem.message);
        setBusy(null);
        return;
      }

      setSessionToken(result.body.sessionToken);
      setMeetingType(result.body.meetingType);
      const nextRecovery = createSmartRouterRecovery(
        linkIdentity,
        result.body.sessionToken,
        result.body.meetingType,
      );
      persistRecovery(nextRecovery);
      setNeedsNewScheduling(false);
      await loadAvailability(result.body.sessionToken, controller);
    } catch (caught) {
      if (isAbortError(caught)) return;
      const problem = {
        message:
          "The Smart Router could not be reached. Check your connection and try again.",
        code: "network_error",
      };
      setError(problem);
      setAnnouncement(problem.message);
      setBusy(null);
    }
  }

  useEffect(() => {
    if (
      recoveryOnly ||
      !bridge ||
      !embed ||
      !parentOrigin ||
      window.parent === window
    )
      return;

    const receiveBridgeSubmission = (event: MessageEvent<unknown>) => {
      if (event.origin !== parentOrigin || event.source !== window.parent)
        return;
      const message = parseBridgeMessage(event.data, questions);
      if (!message) {
        postEmbed("error", { code: "invalid_bridge_submission" });
        return;
      }
      if (recoveryRef.current) {
        postEmbed("error", { code: "scheduling_session_active" });
        return;
      }
      if (bridgeSubmissionIds.current.has(message.submissionId)) return;
      bridgeSubmissionIds.current.add(message.submissionId);
      bridgeSubmission.current = message.submission;
      setBridgeAwaitingSubmission(false);
      setName(message.submission.attendeeName);
      setEmail(message.submission.attendeeEmail);
      setAnswers(message.submission.answers);
      void qualify(undefined, message.submission);
    };

    window.addEventListener("message", receiveBridgeSubmission);
    return () => window.removeEventListener("message", receiveBridgeSubmission);
  }, [bridge, embed, parentOrigin, postEmbed, questions, recoveryOnly]);

  function applyBookingStatus(value: BookingResponse) {
    const authoritativeSlot = slotFromBookingStatus(value);
    if (authoritativeSlot) rememberSelected(authoritativeSlot);
    setBooking((current) => ({
      ...current,
      ...value,
      repName: value.repName ?? current?.repName ?? null,
    }));
    setNeedsNewScheduling(false);
    if (value.status === "confirmed") {
      if (value.error) {
        setError({ message: value.error, code: "provider_cleanup_failed" });
        setAnnouncement(`Your meeting remains active. ${value.error}`);
      } else {
        setError(null);
        setAnnouncement("Your meeting is confirmed.");
      }
    } else if (value.status === "failed") {
      const message =
        value.error ??
        "The calendar provider did not return a complete result. You can safely retry or close this same booking without changing the assigned representative.";
      setError({ message, code: "booking_failed" });
      setAnnouncement(message);
    } else if (value.status === "cancel_pending") {
      setError(null);
      setAnnouncement(
        "Hot Potato is reconciling the calendar provider before releasing the time.",
      );
    } else if (value.status === "cancelled") {
      clearRecovery();
      setError(null);
      setAnnouncement(
        "The failed booking is closed. Any provider event was removed before the time was released.",
      );
    } else if (value.status === "attempting") {
      setError(null);
      setAnnouncement(
        "Your selected time is locked while Hot Potato verifies the calendar provider.",
      );
    } else {
      setError(null);
      setAnnouncement("Your meeting is being confirmed.");
    }
  }

  async function restoreScheduling(
    recovered: SmartRouterRecoveryState,
    controller = beginOperation(),
  ) {
    setBusy("restore");
    setSessionToken(recovered.sessionToken);
    setMeetingType(recovered.meetingType);
    setSelected(recovered.selectedSlot);
    setNeedsNewScheduling(false);
    setStep("confirmation");
    setError(null);
    setAnnouncement(
      "Recovering your scheduling session before accepting another request.",
    );
    try {
      const result = await postJson<BookingResponse>(
        `${baseApiPath}/bookings/status`,
        { sessionToken: recovered.sessionToken },
        controller.signal,
      );
      if (result.status === 404) {
        if (recovered.bookingStarted) {
          await pollBooking(recovered.sessionToken, controller, true);
          return;
        }
        const availabilityRestored = await loadAvailability(
          recovered.sessionToken,
          controller,
          "Your live scheduling session was restored. Choose a time to continue.",
          false,
        );
        if (availabilityRestored) setBooking(null);
        return;
      }
      if (!result.ok && result.status !== 202) {
        const problem = errorFor(
          result,
          "Your saved booking could not be checked. It remains locked so another request cannot replace it.",
        );
        setError(problem);
        setAnnouncement(problem.message);
        return;
      }
      if (!result.body.status) {
        const problem = {
          message:
            "Your saved booking returned an incomplete status. It remains locked; check it again.",
          code: "invalid_booking_status",
        };
        setError(problem);
        setAnnouncement(problem.message);
        return;
      }
      if (!recovered.bookingStarted) {
        persistRecovery({ ...recovered, bookingStarted: true });
      }
      applyBookingStatus(result.body);
      if (bookingStatusIsProcessing(result.body.status)) {
        await pollBooking(
          recovered.sessionToken,
          controller,
          false,
          bookingStatusIsDurable(result.body.status),
        );
      }
    } catch (caught) {
      if (isAbortError(caught)) return;
      const problem = {
        message:
          "Your saved scheduling session could not be reached. It is still preserved and no new request was submitted.",
        code: "network_error",
      };
      setError(problem);
      setAnnouncement(problem.message);
    } finally {
      recoveryPendingRef.current = false;
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  async function pollBooking(
    token: string,
    controller = beginOperation(),
    immediate = false,
    durableStatusAlreadyObserved = false,
  ) {
    setBusy("status");
    let sawNotFound = false;
    let durableStatusObserved = durableStatusAlreadyObserved;
    // Cover the server's complete booking-attempt lease before asking the
    // visitor to check again manually.
    const delays = immediate
      ? [0, 1_000, 1_500, 2_250, 3_500, 5_000, 7_500, 10_000]
      : [750, 1_000, 1_500, 2_250, 3_500, 5_000, 7_500, 10_000];
    try {
      for (const delay of delays) {
        if (delay > 0) await wait(delay, controller.signal);
        const result = await postJson<BookingResponse>(
          `${baseApiPath}/bookings/status`,
          { sessionToken: token },
          controller.signal,
        );
        if (!result.ok && result.status !== 202) {
          if (result.status === 404) {
            sawNotFound = true;
            continue;
          }
          if (result.status === 429 && result.retryAfter) {
            await wait(
              Math.min(result.retryAfter * 1_000, 5_000),
              controller.signal,
            );
            continue;
          }
          const problem = errorFor(
            result,
            "Booking status could not be refreshed. Your request has not been submitted again.",
          );
          setError(problem);
          setAnnouncement(problem.message);
          return;
        }
        if (!result.body.status) continue;
        sawNotFound = false;
        durableStatusObserved ||= bookingStatusIsDurable(result.body.status);
        applyBookingStatus(result.body);
        if (!bookingStatusIsProcessing(result.body.status)) return;
      }
      if (
        bookingPollMayReopenAvailability(sawNotFound, durableStatusObserved)
      ) {
        const current = recoveryRef.current;
        if (current) {
          const availabilityRestored = await loadAvailability(
            token,
            controller,
            "No booking was created. Your original qualification session is still valid—choose a refreshed live time.",
            false,
          );
          if (availabilityRestored) {
            persistRecovery(reopenSmartRouterAvailability(current));
            setBooking(null);
          }
        } else {
          setError({
            message:
              "The booking could not be found, but this page could not verify the original scheduling session. No new request was submitted.",
            code: "booking_not_found",
          });
          setAnnouncement(
            "The booking could not be found. No new request was submitted.",
          );
        }
        return;
      }
      if (sawNotFound && durableStatusObserved) {
        const problem = {
          message:
            "A booking attempt was previously found, but its latest status is not yet available. The request remains locked; check the same status again.",
          code: "booking_status_uncertain",
        };
        setError(problem);
        setAnnouncement(problem.message);
        return;
      }
      setError({
        message:
          "Confirmation is taking longer than usual. Your booking is still processing; check its status again in a moment.",
        code: "booking_pending",
      });
      setAnnouncement("Your booking is still processing.");
    } catch (caught) {
      if (isAbortError(caught)) return;
      setError({
        message:
          "Booking status could not be refreshed. Your request has not been submitted again.",
        code: "network_error",
      });
      setAnnouncement("Booking status could not be refreshed.");
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  async function book() {
    if (!sessionToken || !selected || !meetingType) return;
    const controller = beginOperation();
    const currentRecovery =
      recoveryRef.current ??
      createSmartRouterRecovery(linkIdentity, sessionToken, meetingType);
    const startedRecovery: SmartRouterRecoveryState = {
      ...currentRecovery,
      routerSlug: link.slug,
      selectedSlot: selected,
      bookingStarted: true,
    };
    persistRecovery(startedRecovery);
    setBusy("booking");
    setError(null);
    setBooking(null);
    setNeedsNewScheduling(false);
    setStep("confirmation");
    setAnnouncement("Rechecking that time before booking.");
    try {
      const result = await postJson<BookingResponse>(
        `${baseApiPath}/bookings`,
        {
          sessionToken,
          startsAt: selected.startsAt,
          additionalAttendeeEmails,
          website,
        },
        controller.signal,
      );
      if (!result.ok && result.status !== 202) {
        if (result.status === 409 && result.body.code === "slot_unavailable") {
          persistRecovery({
            ...startedRecovery,
            selectedSlot: null,
            bookingStarted: false,
          });
          await loadAvailability(
            sessionToken,
            controller,
            "That time was just taken. No representative was assigned—choose one of the refreshed live times.",
          );
          return;
        }
        if (result.status === 410) {
          persistRecovery({ ...startedRecovery, bookingStarted: false });
          requireNewScheduling(
            "Your routing session expired before a booking was created. Start over explicitly to choose a fresh time.",
          );
          return;
        }
        const problem = errorFor(
          result,
          "The booking result could not be confirmed. This request remains locked until its status is recovered.",
        );
        setError(problem);
        setAnnouncement(problem.message);
        return;
      }
      if (!result.body.status) {
        const problem = {
          message:
            "The booking returned an incomplete result. This request remains locked; check its status before doing anything else.",
          code: "invalid_response",
        };
        setError(problem);
        setAnnouncement(problem.message);
        return;
      }

      applyBookingStatus(result.body);
      if (bookingStatusIsProcessing(result.body.status)) {
        await pollBooking(
          sessionToken,
          controller,
          false,
          bookingStatusIsDurable(result.body.status),
        );
      }
    } catch (caught) {
      if (isAbortError(caught)) return;
      const problem = {
        message:
          "We lost contact while submitting the booking. The request remains locked; recover its status before doing anything else.",
        code: "network_error",
      };
      setError(problem);
      setAnnouncement(problem.message);
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  async function retryFailedBooking() {
    if (!sessionToken) return;
    const controller = beginOperation();
    const assignedRep = booking?.repName ?? null;
    setBusy("retry");
    setError(null);
    setAnnouncement(
      `Retrying this same booking${assignedRep ? ` with ${assignedRep}` : ""}. Your assignment will not change.`,
    );
    try {
      const result = await postJson<BookingResponse>(
        `${baseApiPath}/bookings/retry`,
        { sessionToken },
        controller.signal,
      );
      if (!result.ok && result.status !== 202) {
        const problem =
          result.status === 409
            ? {
                message: `The original time is no longer available. ${assignedRep ? `${assignedRep} remains assigned` : "Your representative assignment is unchanged"}; this booking was not rerouted.`,
                code: result.body.code ?? "slot_unavailable",
              }
            : errorFor(
                result,
                "This same booking could not be retried. Your representative assignment remains unchanged.",
              );
        setError(problem);
        setAnnouncement(problem.message);
        return;
      }
      if (!result.body.status) {
        const problem = {
          message:
            "The retry returned an incomplete result. Your original booking and assignment remain locked.",
          code: "invalid_retry_status",
        };
        setError(problem);
        setAnnouncement(problem.message);
        return;
      }
      applyBookingStatus(result.body);
      if (bookingStatusIsProcessing(result.body.status)) {
        await pollBooking(
          sessionToken,
          controller,
          false,
          bookingStatusIsDurable(result.body.status),
        );
      }
    } catch (caught) {
      if (isAbortError(caught)) return;
      const problem = {
        message:
          "This same booking could not be reached. Your representative assignment remains unchanged; retry it again when the connection is available.",
        code: "network_error",
      };
      setError(problem);
      setAnnouncement(problem.message);
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  async function abandonFailedBooking() {
    if (!sessionToken || booking?.status !== "failed") return;
    const controller = beginOperation();
    setBusy("abandon");
    setError(null);
    setAnnouncement(
      "Checking for a provider event before safely closing this failed booking.",
    );
    try {
      const result = await postJson<BookingResponse>(
        `${baseApiPath}/bookings/abandon`,
        { sessionToken },
        controller.signal,
      );
      if (!result.ok || !result.body.status) {
        const problem = errorFor(
          result,
          "The failed booking could not be closed. It remains locked with the same assignment.",
        );
        setError(problem);
        setAnnouncement(problem.message);
        return;
      }
      applyBookingStatus(result.body);
      if (bookingStatusIsProcessing(result.body.status)) {
        await pollBooking(
          sessionToken,
          controller,
          false,
          bookingStatusIsDurable(result.body.status),
        );
      }
    } catch (caught) {
      if (isAbortError(caught)) return;
      const problem = {
        message:
          "The failed booking could not be closed. It remains locked with the same assignment.",
        code: "network_error",
      };
      setError(problem);
      setAnnouncement(problem.message);
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  function editDetails() {
    if (smartRouterAssignmentLocked(recoveryRef.current)) return;
    operationRef.current?.abort();
    clearRecovery();
    setSessionToken(null);
    setMeetingType(null);
    setSlots([]);
    setActiveDay("");
    setSelected(null);
    setBooking(null);
    setNeedsNewScheduling(false);
    setError(null);
    if (bridge) {
      bridgeSubmission.current = null;
      setBridgeAwaitingSubmission(true);
    }
    setStep("details");
    setAnnouncement(
      bridge
        ? "The prior scheduling session was abandoned. Waiting for another verified form handoff."
        : "Your previous answers are ready to edit.",
    );
  }

  const progress = stepNumber(step);
  const meetingConference = meetingType
    ? conferenceName(meetingType.conferenceProvider)
    : "Calendar invitation";
  const joinUrl = safeConferenceUrl(booking?.conferenceUrl);
  const managePath = safeManagePath(booking?.managePath);

  return (
    <div
      ref={rootRef}
      className={`smart-router-shell${embed ? " smart-router-embedded" : ""}${bridge ? " smart-router-bridge" : ""}`}
      data-embed={embed ? "true" : "false"}
      data-bridge={bridge ? "true" : "false"}
      style={{ "--smart-accent": link.accentColor } as CSSProperties}
    >
      {!embed && (
        <div className="smart-brand" aria-label="Hot Potato">
          <img src="/hot-potato-mascot.png" alt="" />
          <b>HOT POTATO</b>
        </div>
      )}

      <main className="smart-card" aria-busy={busy !== null}>
        <header className="smart-header">
          <small>{link.organizationName}</small>
          <h1>{link.title}</h1>
          {link.description && <p>{link.description}</p>}
        </header>

        <ol className="smart-steps" aria-label="Booking progress">
          {["Details", "Availability", "Confirmation"].map((label, index) => {
            const number = index + 1;
            const state =
              progress === number
                ? "current"
                : progress !== null && progress > number
                  ? "complete"
                  : step === "no_match" && number === 1
                    ? "complete"
                    : "upcoming";
            return (
              <li
                key={label}
                data-state={state}
                aria-current={state === "current" ? "step" : undefined}
              >
                <span>{number}</span>
                <b>{label}</b>
              </li>
            );
          })}
        </ol>

        {step === "details" && bridge && (
          <section
            className="smart-panel smart-bridge-handoff"
            aria-labelledby="smart-bridge-title"
          >
            <span className="smart-bridge-pulse" aria-hidden="true" />
            <small>FORM RECEIVED</small>
            <h2 id="smart-bridge-title" ref={headingRef} tabIndex={-1}>
              {error
                ? "We couldn’t open the calendar."
                : "Finding your best calendar…"}
            </h2>
            <p>
              {error
                ? error.message
                : bridgeAwaitingSubmission
                  ? "Waiting for the verified form handoff. Your original submission is safe."
                  : "Matching your submitted details to the right team and checking live availability."}
            </p>
            {error && bridgeSubmission.current && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  setError(null);
                  void qualify(undefined, bridgeSubmission.current!);
                }}
              >
                Try the calendar again <span aria-hidden="true">→</span>
              </button>
            )}
          </section>
        )}

        {step === "details" && !bridge && (
          <section
            className="smart-panel"
            aria-labelledby="smart-details-title"
          >
            <h2 id="smart-details-title" ref={headingRef} tabIndex={-1}>
              Tell us a little about you
            </h2>
            <p>We’ll use these details only to find the right live calendar.</p>
            <form
              className="smart-form"
              onSubmit={(event) => void qualify(event)}
            >
              <label>
                Your name
                <input
                  required
                  minLength={2}
                  maxLength={80}
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                Work email
                <input
                  required
                  type="email"
                  maxLength={320}
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              {questions.map((question, index) => {
                const inputId = `smart-question-${index}`;
                const helpId = question.helpText
                  ? `${inputId}-help`
                  : undefined;
                return (
                  <label key={question.field} htmlFor={inputId}>
                    {question.label}
                    {question.type === "select" ? (
                      <select
                        id={inputId}
                        required={question.required}
                        aria-describedby={helpId}
                        value={answers[question.field] ?? ""}
                        onChange={(event) =>
                          setAnswers((current) => ({
                            ...current,
                            [question.field]: event.target.value,
                          }))
                        }
                      >
                        <option value="">Choose an option</option>
                        {question.options.map((option) => (
                          <option key={option} value={option}>
                            {optionLabel(option)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={inputId}
                        required={question.required}
                        type={question.type === "number" ? "number" : "text"}
                        step={question.type === "number" ? "any" : undefined}
                        maxLength={question.type === "text" ? 500 : undefined}
                        placeholder={question.placeholder || undefined}
                        aria-describedby={helpId}
                        value={answers[question.field] ?? ""}
                        onChange={(event) =>
                          setAnswers((current) => ({
                            ...current,
                            [question.field]: event.target.value,
                          }))
                        }
                      />
                    )}
                    {question.helpText && (
                      <small id={helpId}>{question.helpText}</small>
                    )}
                  </label>
                );
              })}
              <label className="smart-honeypot" aria-hidden="true">
                Website
                <input
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(event) => setWebsite(event.target.value)}
                />
              </label>
              <button type="submit" disabled={busy !== null}>
                {busy === "qualifying"
                  ? "Finding your calendar…"
                  : link.buttonLabel}
                <span aria-hidden="true">→</span>
              </button>
            </form>
          </section>
        )}

        {step === "availability" && meetingType && (
          <section
            className="smart-panel smart-availability"
            aria-labelledby="smart-availability-title"
          >
            <div className="smart-meeting-summary">
              <div>
                <small>MATCHED MEETING</small>
                <h2
                  id="smart-availability-title"
                  ref={headingRef}
                  tabIndex={-1}
                >
                  {meetingType.title}
                </h2>
                {meetingType.description && <p>{meetingType.description}</p>}
              </div>
              <dl>
                <div>
                  <dt>Length</dt>
                  <dd>{meetingType.durationMinutes} minutes</dd>
                </div>
                <div>
                  <dt>Location</dt>
                  <dd>{meetingConference}</dd>
                </div>
                <div>
                  <dt>Timezone</dt>
                  <dd>{recipientTimezone.replaceAll("_", " ")}</dd>
                </div>
              </dl>
            </div>

            {busy === "availability" ? (
              <p className="smart-loading" role="status">
                Checking live calendars…
              </p>
            ) : slots.length === 0 ? (
              <div className="smart-empty">
                <h3>No live times are open right now.</h3>
                <p>Calendars change often, so you can check again.</p>
                <button
                  type="button"
                  disabled={!sessionToken || busy !== null}
                  onClick={() =>
                    sessionToken && void loadAvailability(sessionToken)
                  }
                >
                  Check again
                </button>
              </div>
            ) : (
              <div className="smart-slot-picker">
                <div className="smart-days" aria-label="Available dates">
                  {days.map(([key, daySlots]) => {
                    const label = dayLabel(daySlots[0]!.startsAt);
                    return (
                      <button
                        key={key}
                        type="button"
                        aria-pressed={activeDay === key}
                        onClick={() => {
                          setActiveDay(key);
                          rememberSelected(null);
                        }}
                      >
                        <span>{label.weekday}</span>
                        <b>{label.date}</b>
                      </button>
                    );
                  })}
                </div>
                <div className="smart-times" aria-label="Available times">
                  {(days.find(([key]) => key === activeDay)?.[1] ?? []).map(
                    (slot) => (
                      <button
                        key={slot.startsAt}
                        type="button"
                        aria-label={longDateTime(slot.startsAt)}
                        aria-pressed={selected?.startsAt === slot.startsAt}
                        onClick={() => {
                          rememberSelected(slot);
                          setError(null);
                          setAnnouncement(
                            `${longDateTime(slot.startsAt)} selected.`,
                          );
                        }}
                      >
                        {timeLabel(slot.startsAt)}
                      </button>
                    ),
                  )}
                </div>
              </div>
            )}

            {selected && (
              <AdditionalGuests
                value={additionalAttendeeEmails}
                onChange={setAdditionalAttendeeEmails}
                primaryEmail={email}
                disabled={busy !== null}
              />
            )}

            {selected && (
              <div className="smart-selection">
                <div>
                  <small>SELECTED LIVE TIME</small>
                  <b>{longDateTime(selected.startsAt)}</b>
                </div>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void book()}
                >
                  {busy === "booking" ? "Rechecking…" : "Book this meeting"}
                </button>
              </div>
            )}

            <button
              className="smart-text-button"
              type="button"
              disabled={busy !== null}
              onClick={editDetails}
            >
              Change details
            </button>
          </section>
        )}

        {step === "confirmation" && (
          <section
            className="smart-panel smart-confirmation"
            aria-labelledby="smart-confirmation-title"
          >
            {needsNewScheduling ? (
              <>
                <small>SCHEDULING SESSION ENDED</small>
                <h2
                  id="smart-confirmation-title"
                  ref={headingRef}
                  tabIndex={-1}
                >
                  Start a new scheduling request.
                </h2>
                <p>
                  {recoveryOnly
                    ? "No active booking was recovered. This Smart Link is no longer accepting new requests."
                    : "No active booking was recovered. Starting over explicitly clears only this expired scheduling session."}
                </p>
                {!recoveryOnly && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={startNewScheduling}
                  >
                    Start over
                  </button>
                )}
              </>
            ) : booking?.status === "confirmed" ? (
              <>
                <span className="smart-confirmation-mark" aria-hidden="true">
                  ✓
                </span>
                <small>YOU’RE BOOKED</small>
                <h2
                  id="smart-confirmation-title"
                  ref={headingRef}
                  tabIndex={-1}
                >
                  Your meeting is confirmed.
                </h2>
                {selected && <p>{longDateTime(selected.startsAt)}</p>}
                {booking.repName && <p>With {booking.repName}</p>}
                <p>
                  A calendar invitation is on its way
                  {additionalAttendeeEmails.length > 0
                    ? ` to you and ${additionalAttendeeEmails.length} ${additionalAttendeeEmails.length === 1 ? "guest" : "guests"}.`
                    : "."}
                </p>
                <div className="smart-confirmation-actions">
                  {joinUrl && (
                    <a href={joinUrl} target="_blank" rel="noreferrer">
                      Join {meetingConference} ↗
                    </a>
                  )}
                  {managePath && <a href={managePath}>Reschedule or cancel</a>}
                  {successRedirectUrl && (
                    <a
                      href={successRedirectUrl}
                      target={embed ? "_blank" : undefined}
                      rel={embed ? "noreferrer" : undefined}
                    >
                      Continue now ↗
                    </a>
                  )}
                </div>
                {successRedirectUrl && redirectSecondsRemaining !== null && (
                  <p className="smart-redirect-notice" role="status">
                    Continuing to the next page in {redirectSecondsRemaining}{" "}
                    second{redirectSecondsRemaining === 1 ? "" : "s"}.
                  </p>
                )}
                {!recoveryOnly && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={startNewScheduling}
                  >
                    Schedule another meeting
                  </button>
                )}
              </>
            ) : booking?.status === "cancelled" ? (
              <>
                <small>FAILED BOOKING CLOSED</small>
                <h2
                  id="smart-confirmation-title"
                  ref={headingRef}
                  tabIndex={-1}
                >
                  The failed request is safely closed.
                </h2>
                <p>
                  Any provider event from that request was removed before the
                  time was released. Starting another meeting is an explicit new
                  scheduling request.
                </p>
                {!recoveryOnly && (
                  <button type="button" onClick={startNewScheduling}>
                    Start another meeting
                  </button>
                )}
              </>
            ) : booking?.status === "failed" ? (
              <>
                <small>BOOKING NOT COMPLETED</small>
                <h2
                  id="smart-confirmation-title"
                  ref={headingRef}
                  tabIndex={-1}
                >
                  We couldn’t verify that calendar write.
                </h2>
                <p>
                  The provider did not return a complete result.
                  {booking.repName
                    ? ` ${booking.repName} remains assigned.`
                    : " Your representative assignment is preserved."}{" "}
                  The time stays reserved. Retry safely checks for the same
                  provider event before writing again. Close safely checks for
                  and removes any event before releasing the time. Hot Potato
                  will not reroute it.
                </p>
                <div className="smart-confirmation-actions">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void retryFailedBooking()}
                  >
                    {busy === "retry"
                      ? "Retrying same booking…"
                      : "Retry same booking"}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void abandonFailedBooking()}
                  >
                    {busy === "abandon"
                      ? "Closing failed booking…"
                      : "Close failed booking"}
                  </button>
                  {managePath && (
                    <a href={managePath}>Open durable recovery page</a>
                  )}
                </div>
              </>
            ) : booking?.status === "cancel_pending" ? (
              <>
                <small>CLOSING SAFELY</small>
                <h2
                  id="smart-confirmation-title"
                  ref={headingRef}
                  tabIndex={-1}
                >
                  Verifying the calendar before closing.
                </h2>
                <p>
                  The selected time stays reserved while Hot Potato checks
                  Google or Outlook again. If an event exists, it will be
                  removed before the time is released.
                </p>
                {managePath && (
                  <a href={managePath}>Continue on the booking page</a>
                )}
                {busy === null && sessionToken && (
                  <button
                    type="button"
                    onClick={() =>
                      void pollBooking(
                        sessionToken,
                        undefined,
                        true,
                        bookingStatusIsDurable(booking.status),
                      )
                    }
                  >
                    Check cleanup status
                  </button>
                )}
              </>
            ) : booking?.status === "attempting" ? (
              <>
                <small>TIME LOCKED</small>
                <h2
                  id="smart-confirmation-title"
                  ref={headingRef}
                  tabIndex={-1}
                >
                  Verifying your selected time.
                </h2>
                {selected && <p>{longDateTime(selected.startsAt)}</p>}
                <p>
                  This request is already in progress. Hot Potato will reuse the
                  same provider transaction and will not create a duplicate
                  meeting.
                </p>
                {busy === null && sessionToken && (
                  <button
                    type="button"
                    onClick={() =>
                      void pollBooking(
                        sessionToken,
                        undefined,
                        true,
                        bookingStatusIsDurable(booking.status),
                      )
                    }
                  >
                    Check booking status
                  </button>
                )}
              </>
            ) : (
              <>
                <small>CONFIRMING</small>
                <h2
                  id="smart-confirmation-title"
                  ref={headingRef}
                  tabIndex={-1}
                >
                  {booking?.status
                    ? "Your meeting is being confirmed."
                    : "Recovering your booking request."}
                </h2>
                <p>
                  This request is locked to its original routing decision.
                  Checking status will not submit, duplicate, or reroute it.
                </p>
                {managePath && (
                  <a href={managePath}>Keep this booking recovery link</a>
                )}
                {busy === null && sessionToken && (
                  <button
                    type="button"
                    onClick={() => {
                      if (booking?.status) {
                        void pollBooking(
                          sessionToken,
                          undefined,
                          true,
                          bookingStatusIsDurable(booking.status),
                        );
                      } else if (recovery) {
                        void restoreScheduling(recovery);
                      }
                    }}
                  >
                    {booking?.status
                      ? "Check booking status"
                      : "Recover booking status"}
                  </button>
                )}
              </>
            )}
          </section>
        )}

        {step === "no_match" && (
          <section
            className="smart-panel smart-no-match"
            aria-labelledby="smart-no-match-title"
          >
            <small>THANK YOU</small>
            <h2 id="smart-no-match-title" ref={headingRef} tabIndex={-1}>
              We have your details.
            </h2>
            <p>{noMatchMessage}</p>
            <button type="button" onClick={editDetails}>
              Change answers
            </button>
          </section>
        )}

        {error && !(bridge && step === "details") && (
          <p className="smart-error" role="alert">
            {error.message}
          </p>
        )}
        <p
          className="smart-announcement"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {announcement}
        </p>
      </main>

      {!embed && (
        <footer className="smart-footer">
          Open-source scheduling and routing by Hot Potato
        </footer>
      )}
    </div>
  );
}
