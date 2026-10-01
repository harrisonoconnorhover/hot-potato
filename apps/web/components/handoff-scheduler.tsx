"use client";

import type {
  Dashboard,
  PublicBookingStatus,
  RouterLinkMeetingType,
  RouterLinkQuestion,
} from "@hot-potato/db";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import styles from "./handoff-scheduler.module.css";
import { AdditionalGuests } from "./additional-guests";
import {
  bookingPollMayReopenAvailability,
  bookingStatusIsDurable,
  bookingStatusIsProcessing,
  slotFromBookingStatus,
} from "./booking-status";

type Slot = {
  startsAt: string;
  endsAt: string;
};

type ApiProblem = {
  error?: string | null;
  code?: string;
};

type Qualification = ApiProblem & {
  outcome?: "matched" | "no_match";
  sessionToken?: string;
  expiresAt?: string;
  noMatchMessage?: string;
  meetingType?: RouterLinkMeetingType | null;
  matchedRuleName?: string | null;
  poolName?: string | null;
};

type Availability = ApiProblem & {
  slots?: Slot[];
  meetingType?: RouterLinkMeetingType | null;
  matchedRuleName?: string | null;
  poolName?: string | null;
};

type Booking = ApiProblem & Partial<PublicBookingStatus>;

type WorkflowStep = "details" | "availability" | "confirmation" | "no_match";
type BusyState =
  | "qualify"
  | "availability"
  | "booking"
  | "retry"
  | "abandon"
  | "restore"
  | "status"
  | null;

type ApiResult<T> = {
  ok: boolean;
  status: number;
  body: T;
};

const protectedQuestionFields = new Set([
  "email",
  "name",
  "attendee_name",
  "current_owner_email",
]);

export type HandoffRecoveryState = {
  version: 3;
  routerLinkId: string;
  routerSlug: string;
  sessionToken: string;
  selectedSlot: Slot | null;
  bookingStarted: boolean;
  match: {
    expiresAt: string | null;
    meetingType: RouterLinkMeetingType;
    matchedRuleName: string;
    poolName: string;
  };
};

const routerSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const sessionTokenPattern = /^[A-Za-z0-9_-]+$/;
const stableIdPattern = /^[A-Za-z0-9_-]+$/;
const conferenceProviders = new Set([
  "none",
  "google_meet",
  "microsoft_teams",
  "zoom",
]);

function plainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function finiteNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function parseRecoveryMeetingType(
  value: unknown,
): RouterLinkMeetingType | null {
  if (
    !plainRecord(value) ||
    !boundedString(value.slug, 80) ||
    !routerSlugPattern.test(value.slug) ||
    !boundedString(value.title, 200) ||
    !boundedString(value.description, 1_000) ||
    !finiteNumber(value.durationMinutes, 5, 480) ||
    !finiteNumber(value.minimumNoticeMinutes, 0, 525_600) ||
    !finiteNumber(value.bookingWindowDays, 1, 730) ||
    typeof value.conferenceProvider !== "string" ||
    !conferenceProviders.has(value.conferenceProvider) ||
    !finiteNumber(value.reminderMinutes, 0, 525_600)
  ) {
    return null;
  }
  return {
    slug: value.slug,
    title: value.title,
    description: value.description,
    durationMinutes: value.durationMinutes,
    minimumNoticeMinutes: value.minimumNoticeMinutes,
    bookingWindowDays: value.bookingWindowDays,
    conferenceProvider:
      value.conferenceProvider as RouterLinkMeetingType["conferenceProvider"],
    reminderMinutes: value.reminderMinutes,
  };
}

function parseRecoverySlot(value: unknown): Slot | null {
  if (
    !plainRecord(value) ||
    typeof value.startsAt !== "string" ||
    typeof value.endsAt !== "string"
  ) {
    return null;
  }
  const startsAt = Date.parse(value.startsAt);
  const endsAt = Date.parse(value.endsAt);
  return Number.isFinite(startsAt) &&
    Number.isFinite(endsAt) &&
    endsAt > startsAt
    ? { startsAt: value.startsAt, endsAt: value.endsAt }
    : null;
}

export function handoffRecoveryStorageKey(organizationSlug: string) {
  return `hot-potato:handoff:${organizationSlug}`;
}

export function serializeHandoffRecovery(value: HandoffRecoveryState) {
  const meetingType = value.match.meetingType;
  return JSON.stringify({
    version: 3,
    routerLinkId: value.routerLinkId,
    routerSlug: value.routerSlug,
    sessionToken: value.sessionToken,
    selectedSlot: value.selectedSlot
      ? {
          startsAt: value.selectedSlot.startsAt,
          endsAt: value.selectedSlot.endsAt,
        }
      : null,
    bookingStarted: value.bookingStarted,
    match: {
      expiresAt: value.match.expiresAt,
      meetingType: {
        slug: meetingType.slug,
        title: meetingType.title,
        description: meetingType.description,
        durationMinutes: meetingType.durationMinutes,
        minimumNoticeMinutes: meetingType.minimumNoticeMinutes,
        bookingWindowDays: meetingType.bookingWindowDays,
        conferenceProvider: meetingType.conferenceProvider,
        reminderMinutes: meetingType.reminderMinutes,
      },
      matchedRuleName: value.match.matchedRuleName,
      poolName: value.match.poolName,
    },
  } satisfies HandoffRecoveryState);
}

export function shouldPreserveHandoffAcrossLinkRefresh(
  recovery: Pick<HandoffRecoveryState, "routerLinkId"> | null,
  selectedRouterLinkId: string | null | undefined,
) {
  return Boolean(recovery && recovery.routerLinkId === selectedRouterLinkId);
}

export function parseHandoffRecovery(
  raw: string | null,
  knownRouterLinks: ReadonlyArray<{ id: string; slug: string }>,
): HandoffRecoveryState | null {
  if (!raw || raw.length > 8_000) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !plainRecord(value) ||
      (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
      typeof value.routerSlug !== "string" ||
      value.routerSlug.length > 80 ||
      !routerSlugPattern.test(value.routerSlug) ||
      typeof value.sessionToken !== "string" ||
      value.sessionToken.length < 32 ||
      value.sessionToken.length > 128 ||
      !sessionTokenPattern.test(value.sessionToken) ||
      !plainRecord(value.match)
    ) {
      return null;
    }
    const routerLink =
      value.version !== 1
        ? typeof value.routerLinkId === "string" &&
          value.routerLinkId.length > 0 &&
          value.routerLinkId.length <= 128 &&
          stableIdPattern.test(value.routerLinkId)
          ? knownRouterLinks.find((link) => link.id === value.routerLinkId)
          : null
        : knownRouterLinks.find((link) => link.slug === value.routerSlug);
    if (!routerLink) return null;
    const meetingType = parseRecoveryMeetingType(value.match.meetingType);
    if (
      !meetingType ||
      !boundedString(value.match.matchedRuleName, 200) ||
      !value.match.matchedRuleName.trim() ||
      !boundedString(value.match.poolName, 200) ||
      !value.match.poolName.trim() ||
      !(
        value.match.expiresAt === null ||
        (typeof value.match.expiresAt === "string" &&
          Number.isFinite(Date.parse(value.match.expiresAt)))
      )
    ) {
      return null;
    }
    const selectedSlot =
      value.selectedSlot === null
        ? null
        : parseRecoverySlot(value.selectedSlot);
    if (value.selectedSlot !== null && !selectedSlot) return null;
    if (value.version === 3 && typeof value.bookingStarted !== "boolean") {
      return null;
    }
    return {
      version: 3,
      routerLinkId: routerLink.id,
      routerSlug: routerLink.slug,
      sessionToken: value.sessionToken,
      selectedSlot,
      bookingStarted:
        value.version === 3 ? value.bookingStarted === true : false,
      match: {
        expiresAt: value.match.expiresAt,
        meetingType,
        matchedRuleName: value.match.matchedRuleName,
        poolName: value.match.poolName,
      },
    };
  } catch {
    return null;
  }
}

function emptyAnswers(questions: RouterLinkQuestion[]) {
  return Object.fromEntries(questions.map((question) => [question.field, ""]));
}

function recoveryFromQualification(
  routerLinkId: string,
  routerSlug: string,
  qualification: Qualification,
  selectedSlot: Slot | null,
): HandoffRecoveryState | null {
  if (
    !routerLinkId ||
    routerLinkId.length > 128 ||
    !stableIdPattern.test(routerLinkId) ||
    qualification.outcome !== "matched" ||
    !qualification.sessionToken ||
    !qualification.meetingType ||
    !qualification.matchedRuleName ||
    !qualification.poolName
  ) {
    return null;
  }
  return {
    version: 3,
    routerLinkId,
    routerSlug,
    sessionToken: qualification.sessionToken,
    selectedSlot,
    bookingStarted: false,
    match: {
      expiresAt: qualification.expiresAt ?? null,
      meetingType: qualification.meetingType,
      matchedRuleName: qualification.matchedRuleName,
      poolName: qualification.poolName,
    },
  };
}

function qualificationFromRecovery(
  recovery: HandoffRecoveryState,
): Qualification {
  return {
    outcome: "matched",
    sessionToken: recovery.sessionToken,
    expiresAt: recovery.match.expiresAt ?? undefined,
    meetingType: recovery.match.meetingType,
    matchedRuleName: recovery.match.matchedRuleName,
    poolName: recovery.match.poolName,
  };
}

function answerValue(question: RouterLinkQuestion, value: string) {
  const normalized = value.trim();
  if (question.type !== "number" || normalized === "") return normalized;
  return Number(normalized);
}

function optionLabel(value: string) {
  if (value === "true") return "Yes";
  if (value === "false") return "No";
  return value;
}

function dayKey(value: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function dayLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function longDateTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function normalizedFutureSlots(slots: Slot[]) {
  const now = Date.now();
  const seen = new Set<string>();
  return slots
    .filter((slot) => {
      if (
        typeof slot?.startsAt !== "string" ||
        typeof slot?.endsAt !== "string"
      ) {
        return false;
      }
      const startsAt = Date.parse(slot.startsAt);
      const endsAt = Date.parse(slot.endsAt);
      if (
        !Number.isFinite(startsAt) ||
        !Number.isFinite(endsAt) ||
        startsAt <= now ||
        endsAt <= startsAt
      ) {
        return false;
      }
      const key = `${slot.startsAt}:${slot.endsAt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
}

function conferenceName(
  value: RouterLinkMeetingType["conferenceProvider"] | undefined,
) {
  if (value === "google_meet") return "Google Meet";
  if (value === "microsoft_teams") return "Microsoft Teams";
  if (value === "zoom") return "Zoom";
  return "Calendar invitation";
}

function safeExternalUrl(value: string | null | undefined) {
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

function safeManagePath(value: string | null | undefined) {
  return value?.startsWith("/schedule/manage/") ? value : null;
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

async function postJson<T>(
  path: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<ApiResult<T>> {
  const response = await fetch(path, {
    method: "POST",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  return {
    ok: response.ok,
    status: response.status,
    body: (await response.json().catch(() => ({}))) as T,
  };
}

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
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

export function HandoffScheduler({ dashboard }: { dashboard: Dashboard }) {
  const publishedLinks = useMemo(
    () => dashboard.routerLinks.filter((link) => link.active),
    [dashboard.routerLinks],
  );
  const [routerSlug, setRouterSlug] = useState(
    () => publishedLinks[0]?.slug ?? "",
  );
  const recoveryKey = handoffRecoveryStorageKey(dashboard.organization.slug);
  const [recovery, setRecovery] = useState<HandoffRecoveryState | null>(null);
  const selectedLink =
    dashboard.routerLinks.find((link) => link.slug === routerSlug) ??
    (recovery
      ? dashboard.routerLinks.find((link) => link.id === recovery.routerLinkId)
      : null) ??
    publishedLinks[0] ??
    null;
  const questions = useMemo(
    () =>
      (selectedLink?.questions ?? []).filter(
        (question) => !protectedQuestionFields.has(question.field),
      ),
    [selectedLink],
  );
  const linkFingerprint = JSON.stringify(
    selectedLink
      ? {
          id: selectedLink.id,
          slug: selectedLink.slug,
          title: selectedLink.title,
          questions: selectedLink.questions,
          destinations: selectedLink.destinations,
        }
      : null,
  );
  const [attendeeName, setAttendeeName] = useState("");
  const [attendeeEmail, setAttendeeEmail] = useState("");
  const [additionalAttendeeEmails, setAdditionalAttendeeEmails] = useState<
    string[]
  >([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [step, setStep] = useState<WorkflowStep>("details");
  const [busy, setBusy] = useState<BusyState>("restore");
  const [qualification, setQualification] = useState<Qualification | null>(
    null,
  );
  const [slots, setSlots] = useState<Slot[]>([]);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [timezone, setTimezone] = useState("Browser timezone");
  const [recoveryLoaded, setRecoveryLoaded] = useState(false);
  const [needsNewHandoff, setNeedsNewHandoff] = useState(false);
  const operationRef = useRef<AbortController | null>(null);
  const recoveryRef = useRef<HandoffRecoveryState | null>(null);
  const recoveryLoadKeyRef = useRef<string | null>(null);
  const recoveryAttemptRef = useRef<string | null>(null);
  const recoveryPendingRef = useRef(true);

  const beginOperation = useCallback(() => {
    operationRef.current?.abort();
    const controller = new AbortController();
    operationRef.current = controller;
    return controller;
  }, []);

  const persistRecovery = useCallback(
    (value: HandoffRecoveryState) => {
      recoveryRef.current = value;
      try {
        window.sessionStorage.setItem(
          recoveryKey,
          serializeHandoffRecovery(value),
        );
      } catch {
        // The in-memory lock still protects this open dashboard when storage is
        // unavailable (for example, hardened/private browser settings).
      }
      setRecovery(value);
    },
    [recoveryKey],
  );

  const clearRecovery = useCallback(() => {
    try {
      window.sessionStorage.removeItem(recoveryKey);
    } catch {
      // The current in-memory state is still cleared below.
    }
    recoveryPendingRef.current = false;
    recoveryAttemptRef.current = null;
    recoveryRef.current = null;
    setRecovery(null);
  }, [recoveryKey]);

  useEffect(() => {
    setTimezone(
      Intl.DateTimeFormat().resolvedOptions().timeZone || "Browser timezone",
    );
    return () => operationRef.current?.abort();
  }, []);

  useEffect(() => {
    if (recoveryLoadKeyRef.current === recoveryKey) return;
    recoveryLoadKeyRef.current = recoveryKey;
    let raw: string | null = null;
    try {
      raw = window.sessionStorage.getItem(recoveryKey);
    } catch {
      // Treat unavailable session storage as an empty recovery store.
    }
    const recovered = parseHandoffRecovery(
      raw,
      dashboard.routerLinks.map((link) => ({ id: link.id, slug: link.slug })),
    );
    if (raw && !recovered) {
      try {
        window.sessionStorage.removeItem(recoveryKey);
      } catch {
        // Invalid state stays unusable even if browser storage cannot be edited.
      }
    }
    recoveryPendingRef.current = Boolean(recovered);
    setRecoveryLoaded(true);
    if (recovered) {
      persistRecovery(recovered);
      setRouterSlug(recovered.routerSlug);
    } else {
      setBusy(null);
    }
    // Router links are part of the loaded dashboard snapshot. Reloading the
    // storage key for every dashboard refresh could overwrite live form state;
    // the stable-id reconciliation effect below handles later link edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryKey]);

  useEffect(() => {
    const recoveredLink = recovery
      ? dashboard.routerLinks.find((link) => link.id === recovery.routerLinkId)
      : null;
    if (recovery && recoveredLink) {
      if (recovery.routerSlug !== recoveredLink.slug) {
        persistRecovery({ ...recovery, routerSlug: recoveredLink.slug });
      }
      if (routerSlug !== recoveredLink.slug) {
        setRouterSlug(recoveredLink.slug);
      }
      return;
    }
    if (publishedLinks.some((link) => link.slug === routerSlug)) return;
    setRouterSlug(publishedLinks[0]?.slug ?? "");
  }, [
    dashboard.routerLinks,
    persistRecovery,
    publishedLinks,
    recovery,
    routerSlug,
  ]);

  useEffect(() => {
    if (shouldPreserveHandoffAcrossLinkRefresh(recovery, selectedLink?.id)) {
      // The dashboard may refresh because this Smart Link was edited. Its
      // persisted session is authoritative until the booking is resolved; do
      // not let a presentation/config refresh reopen qualification.
      return;
    }
    operationRef.current?.abort();
    setBusy(recoveryPendingRef.current ? "restore" : null);
    setAnswers(emptyAnswers(questions));
    setAdditionalAttendeeEmails([]);
    setQualification(null);
    setSlots([]);
    setSelectedSlot(null);
    setBooking(null);
    setError(null);
    setStep("details");
    setNeedsNewHandoff(false);
    setAnnouncement("");
    // A published link can be edited while this dashboard is open. Reset only
    // when the selected link's scheduling contract actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkFingerprint]);

  useEffect(() => {
    if (
      !recoveryLoaded ||
      !recovery ||
      !recoveryPendingRef.current ||
      selectedLink?.id !== recovery.routerLinkId
    ) {
      return;
    }
    const attemptKey = `${recovery.routerLinkId}:${recovery.routerSlug}:${recovery.sessionToken}`;
    if (recoveryAttemptRef.current === attemptKey) return;
    recoveryAttemptRef.current = attemptKey;
    void restoreHandoff(recovery);
    // Recovery is deliberately keyed to the persisted token, not transient
    // booking/error state changed by polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    recoveryLoaded,
    recovery?.routerLinkId,
    recovery?.routerSlug,
    recovery?.sessionToken,
    selectedLink?.id,
  ]);

  const groupedSlots = useMemo(() => {
    const groups = new Map<string, Slot[]>();
    for (const slot of slots) {
      const group = groups.get(dayKey(slot.startsAt)) ?? [];
      group.push(slot);
      groups.set(dayKey(slot.startsAt), group);
    }
    return [...groups.values()];
  }, [slots]);

  function responseError(body: ApiProblem, fallback: string, status?: number) {
    return body.error ?? (status ? `${fallback} (HTTP ${status})` : fallback);
  }

  function resetSession(message?: string) {
    if (step === "confirmation" && qualification?.sessionToken) return;
    operationRef.current?.abort();
    clearRecovery();
    setQualification(null);
    setSlots([]);
    setSelectedSlot(null);
    setBooking(null);
    setStep("details");
    setBusy(null);
    setError(message ?? null);
    setAnnouncement(message ?? "Handoff details are ready to edit.");
  }

  function requireNewHandoff(message: string) {
    setBooking(null);
    setSlots([]);
    setSelectedSlot(recovery?.selectedSlot ?? null);
    setNeedsNewHandoff(true);
    setStep("confirmation");
    setError(message);
    setAnnouncement(message);
  }

  function startNewHandoff(
    nextRouterSlug = selectedLink?.active
      ? selectedLink.slug
      : (publishedLinks[0]?.slug ?? ""),
  ) {
    operationRef.current?.abort();
    clearRecovery();
    setRouterSlug(nextRouterSlug);
    setAttendeeName("");
    setAttendeeEmail("");
    setAdditionalAttendeeEmails([]);
    setAnswers(emptyAnswers(questions));
    setQualification(null);
    setSlots([]);
    setSelectedSlot(null);
    setBooking(null);
    setNeedsNewHandoff(false);
    setStep("details");
    setBusy(null);
    setError(null);
    setAnnouncement("Ready for another handoff.");
  }

  function rememberSelectedSlot(slot: Slot | null, bookingStarted?: boolean) {
    setSelectedSlot(slot);
    const current = recoveryRef.current;
    if (!current) return;
    persistRecovery({
      ...current,
      selectedSlot: slot,
      bookingStarted: bookingStarted ?? current.bookingStarted,
    });
  }

  async function restoreHandoff(recovered: HandoffRecoveryState) {
    const controller = beginOperation();
    const restoredQualification = qualificationFromRecovery(recovered);
    setBusy("restore");
    setQualification(restoredQualification);
    setSelectedSlot(recovered.selectedSlot);
    setBooking(null);
    setNeedsNewHandoff(false);
    setStep("confirmation");
    setError(null);
    setAnnouncement(
      "Recovering this handoff before allowing another qualification.",
    );
    try {
      const status = await postJson<Booking>(
        "/api/handoff/bookings/status",
        {
          routerSlug: recovered.routerSlug,
          sessionToken: recovered.sessionToken,
        },
        controller.signal,
      );
      if (status.ok || status.status === 202) {
        if (!status.body.status) {
          const message =
            "The saved booking returned an incomplete status. Its recovery token is still preserved; check status again.";
          setError(message);
          setAnnouncement(message);
          return;
        }
        applyBooking(status.body);
        setStep("confirmation");
        if (bookingStatusIsProcessing(status.body.status)) {
          await pollStatus(
            recovered.sessionToken,
            recovered.routerSlug,
            controller,
            false,
            bookingStatusIsDurable(status.body.status),
          );
        }
        return;
      }
      if (status.status === 404) {
        if (recovered.bookingStarted) {
          await pollStatus(
            recovered.sessionToken,
            recovered.routerSlug,
            controller,
            true,
          );
          return;
        }
        await loadAvailability(
          recovered.sessionToken,
          recovered.routerSlug,
          controller,
          "Recovered the still-valid qualification session. No rep has been assigned yet; choose a live time to continue.",
          true,
        );
        return;
      }
      if (status.status === 410) {
        requireNewHandoff(
          "The saved qualification expired and no booking could be recovered. Start another handoff explicitly to continue.",
        );
        return;
      }
      const message = responseError(
        status.body,
        "The saved handoff could not be checked. It remains locked so another qualification cannot replace a possible booking.",
        status.status,
      );
      setError(message);
      setAnnouncement(message);
    } catch (caught) {
      if (isAbortError(caught)) return;
      const message =
        "The saved handoff could not be reached. Its recovery token is preserved and another qualification remains locked until status is checked.";
      setError(message);
      setAnnouncement(message);
    } finally {
      recoveryPendingRef.current = false;
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  async function loadAvailability(
    token: string,
    slug: string,
    controller = beginOperation(),
    notice?: string,
    restoring = false,
  ) {
    setBusy("availability");
    rememberSelectedSlot(null);
    if (!notice) setError(null);
    setAnnouncement("Checking every selected calendar for live times.");
    try {
      const result = await postJson<Availability>(
        "/api/handoff/availability",
        { routerSlug: slug, sessionToken: token },
        controller.signal,
      );
      if (!result.ok || !Array.isArray(result.body.slots)) {
        if (result.status === 410) {
          requireNewHandoff(
            "This qualification session expired and no booking was found. Start another handoff explicitly to continue.",
          );
          return false;
        }
        const message = responseError(
          result.body,
          "Live availability could not be loaded. Check the rep calendar connections and try again.",
          result.status,
        );
        setError(message);
        setAnnouncement(message);
        return false;
      }
      if (
        result.body.meetingType &&
        result.body.matchedRuleName &&
        result.body.poolName
      ) {
        const refreshedQualification: Qualification = {
          outcome: "matched",
          sessionToken: token,
          expiresAt:
            qualification?.expiresAt ?? recovery?.match.expiresAt ?? undefined,
          meetingType: result.body.meetingType,
          matchedRuleName: result.body.matchedRuleName,
          poolName: result.body.poolName,
        };
        setQualification(refreshedQualification);
        const routerLinkId =
          dashboard.routerLinks.find((link) => link.slug === slug)?.id ??
          (recovery?.routerSlug === slug ? recovery.routerLinkId : null);
        const refreshedRecovery = recoveryFromQualification(
          routerLinkId ?? "",
          slug,
          refreshedQualification,
          null,
        );
        if (routerLinkId && refreshedRecovery) {
          persistRecovery(refreshedRecovery);
        }
      } else if (restoring && !recovery?.match.meetingType) {
        const message =
          "The saved qualification is valid, but its meeting details could not be restored. Its recovery token remains preserved.";
        setError(message);
        setAnnouncement(message);
        setStep("confirmation");
        return false;
      }
      const futureSlots = normalizedFutureSlots(result.body.slots);
      setSlots(futureSlots);
      setError(notice ?? null);
      setStep("availability");
      const message =
        notice ??
        (futureSlots.length > 0
          ? `${futureSlots.length} live times are ready in ${timezone.replaceAll("_", " ")}.`
          : "No live times are currently open for the matched pool.");
      setAnnouncement(message);
      return true;
    } catch (caught) {
      if (isAbortError(caught)) return false;
      const message =
        "Live calendars could not be reached. Check the Google or Outlook connection and try again.";
      setError(message);
      setAnnouncement(message);
      return false;
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  async function qualify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedLink) return;
    const controller = beginOperation();
    setBusy("qualify");
    setError(null);
    setQualification(null);
    setSlots([]);
    setSelectedSlot(null);
    setBooking(null);
    setAnnouncement("Qualifying this handoff without assigning an owner.");
    try {
      const result = await postJson<Qualification>(
        "/api/handoff/qualify",
        {
          routerSlug: selectedLink.slug,
          attendeeName: attendeeName.trim(),
          attendeeEmail: attendeeEmail.trim(),
          answers: Object.fromEntries(
            questions.map((question) => [
              question.field,
              answerValue(question, answers[question.field] ?? ""),
            ]),
          ),
        },
        controller.signal,
      );
      if (result.body.outcome === "no_match") {
        clearRecovery();
        setQualification(result.body);
        setStep("no_match");
        setAnnouncement(
          result.body.noMatchMessage ??
            selectedLink.noMatchMessage ??
            "No published route matched these answers.",
        );
        return;
      }
      if (
        !result.ok ||
        result.body.outcome !== "matched" ||
        !result.body.sessionToken ||
        !result.body.meetingType ||
        !result.body.matchedRuleName ||
        !result.body.poolName
      ) {
        const message = responseError(
          result.body,
          "This handoff could not be qualified. Review the answers and try again.",
          result.status,
        );
        setError(message);
        setAnnouncement(message);
        return;
      }
      setQualification(result.body);
      const nextRecovery = recoveryFromQualification(
        selectedLink.id,
        selectedLink.slug,
        result.body,
        null,
      );
      if (nextRecovery) persistRecovery(nextRecovery);
      setAnnouncement(
        "Match found. No owner has been assigned yet; loading live times now.",
      );
      await loadAvailability(
        result.body.sessionToken,
        selectedLink.slug,
        controller,
      );
    } catch (caught) {
      if (isAbortError(caught)) return;
      const message =
        "The handoff service could not be reached. Check the connection and try again.";
      setError(message);
      setAnnouncement(message);
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  function applyBooking(value: Booking) {
    const authoritativeSlot = slotFromBookingStatus(value);
    rememberSelectedSlot(authoritativeSlot ?? selectedSlot, true);
    const assignedRep = value.repName ?? booking?.repName ?? null;
    setBooking((current) => ({
      ...current,
      ...value,
      repName: value.repName ?? current?.repName ?? null,
    }));
    if (value.status === "confirmed") {
      if (value.error) {
        setError(value.error);
        setAnnouncement(
          `The meeting remains active${assignedRep ? ` with ${assignedRep}` : ""}. ${value.error}`,
        );
      } else {
        setError(null);
        setAnnouncement(
          `Meeting confirmed${assignedRep ? ` with ${assignedRep}` : ""}.`,
        );
      }
    } else if (value.status === "failed") {
      const message =
        value.error ??
        "The calendar provider did not return a complete result. Retry or close this same booking safely without changing the assigned representative.";
      setError(message);
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
        "The failed calendar booking is closed. Any provider event was removed before the time was released; its routing audit was preserved.",
      );
    } else if (value.status === "attempting") {
      setError(null);
      setAnnouncement(
        "The selected time is locked while Hot Potato verifies the calendar provider.",
      );
    } else {
      setAnnouncement("The calendar write is still being confirmed.");
    }
  }

  async function retryFailedBooking() {
    if (!selectedLink || !qualification?.sessionToken) return;
    const controller = beginOperation();
    const assignedRep = booking?.repName ?? null;
    setBusy("retry");
    setError(null);
    setAnnouncement(
      `Retrying this same booking${assignedRep ? ` for ${assignedRep}` : ""}. The assignment will not change.`,
    );
    try {
      const result = await postJson<Booking>(
        "/api/handoff/bookings/retry",
        {
          routerSlug: selectedLink.slug,
          sessionToken: qualification.sessionToken,
        },
        controller.signal,
      );
      if (!result.ok && result.status !== 202) {
        const message =
          result.status === 409
            ? `The original time is now occupied. ${assignedRep ? `${assignedRep} remains assigned` : "The existing rep remains assigned"}; the assignment was not changed.`
            : responseError(
                result.body,
                "This same booking could not be retried. The existing rep assignment was preserved.",
                result.status,
              );
        setError(message);
        setAnnouncement(message);
        return;
      }
      if (!result.body.status) {
        const message =
          "The retry returned an incomplete booking status. The existing rep assignment was preserved; check this same booking again.";
        setError(message);
        setAnnouncement(message);
        return;
      }
      applyBooking(result.body);
      if (bookingStatusIsProcessing(result.body.status)) {
        await pollStatus(
          qualification.sessionToken,
          selectedLink.slug,
          controller,
          false,
          bookingStatusIsDurable(result.body.status),
        );
      }
    } catch (caught) {
      if (isAbortError(caught)) return;
      const message =
        "The retry could not be reached. The existing rep assignment was preserved; check this same booking before retrying again.";
      setError(message);
      setAnnouncement(message);
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  async function abandonFailedBooking() {
    if (
      !selectedLink ||
      !qualification?.sessionToken ||
      booking?.status !== "failed"
    ) {
      return;
    }
    const controller = beginOperation();
    setBusy("abandon");
    setError(null);
    setAnnouncement(
      "Checking for a provider event before safely closing this failed calendar booking.",
    );
    try {
      const result = await postJson<Booking>(
        "/api/handoff/bookings/abandon",
        {
          routerSlug: selectedLink.slug,
          sessionToken: qualification.sessionToken,
        },
        controller.signal,
      );
      if (!result.ok || !result.body.status) {
        const message = responseError(
          result.body,
          "The failed booking could not be closed. Its original routing assignment and recovery lock remain unchanged.",
          result.status,
        );
        setError(message);
        setAnnouncement(message);
        return;
      }
      applyBooking(result.body);
      if (bookingStatusIsProcessing(result.body.status)) {
        await pollStatus(
          qualification.sessionToken,
          selectedLink.slug,
          controller,
          false,
          bookingStatusIsDurable(result.body.status),
        );
      }
    } catch (caught) {
      if (isAbortError(caught)) return;
      const message =
        "The failed booking could not be closed. Its original routing assignment and recovery lock remain unchanged.";
      setError(message);
      setAnnouncement(message);
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  async function pollStatus(
    token: string,
    slug: string,
    controller = beginOperation(),
    immediate = false,
    durableStatusAlreadyObserved = false,
  ) {
    setBusy("status");
    let sawNotFound = false;
    let durableStatusObserved = durableStatusAlreadyObserved;
    try {
      // Cover the server's complete booking-attempt lease before asking the
      // operator to check again manually.
      const delays = immediate
        ? [0, 850, 1_300, 2_000, 3_000, 4_500, 6_500, 12_500]
        : [500, 850, 1_300, 2_000, 3_000, 4_500, 6_500, 12_500];
      for (const delay of delays) {
        if (delay > 0) await wait(delay, controller.signal);
        const result = await postJson<Booking>(
          "/api/handoff/bookings/status",
          { routerSlug: slug, sessionToken: token },
          controller.signal,
        );
        if (!result.ok && result.status !== 202) {
          if (result.status === 404) {
            sawNotFound = true;
            continue;
          }
          const message = responseError(
            result.body,
            "Booking status could not be refreshed. The booking was not submitted again.",
            result.status,
          );
          setError(message);
          setAnnouncement(message);
          return;
        }
        if (!result.body.status) continue;
        sawNotFound = false;
        durableStatusObserved ||= bookingStatusIsDurable(result.body.status);
        applyBooking(result.body);
        if (!bookingStatusIsProcessing(result.body.status)) return;
      }
      if (
        bookingPollMayReopenAvailability(sawNotFound, durableStatusObserved)
      ) {
        const availabilityRestored = await loadAvailability(
          token,
          slug,
          controller,
          "No booking was created. The original qualification session is still valid—choose a refreshed live time.",
        );
        if (availabilityRestored) {
          rememberSelectedSlot(null, false);
          setBooking(null);
        }
        return;
      }
      if (sawNotFound && durableStatusObserved) {
        const message =
          "A booking attempt was previously found, but its latest status is not yet available. The handoff remains locked; check this same status again.";
        setError(message);
        setAnnouncement(message);
        return;
      }
      const message =
        "Calendar confirmation is taking longer than usual. You can safely check the same booking again.";
      setError(message);
      setAnnouncement(message);
    } catch (caught) {
      if (isAbortError(caught)) return;
      const message =
        "Booking status could not be reached. Checking again will not create a duplicate.";
      setError(message);
      setAnnouncement(message);
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  async function bookSelected() {
    if (!selectedLink || !qualification?.sessionToken || !selectedSlot) return;
    const controller = beginOperation();
    rememberSelectedSlot(selectedSlot, true);
    setBusy("booking");
    setError(null);
    setAnnouncement(
      "Rechecking the selected time before assigning and booking.",
    );
    try {
      const result = await postJson<Booking>(
        "/api/handoff/bookings",
        {
          routerSlug: selectedLink.slug,
          sessionToken: qualification.sessionToken,
          startsAt: selectedSlot.startsAt,
          additionalAttendeeEmails,
        },
        controller.signal,
      );
      if (!result.ok && result.status !== 202) {
        if (result.status === 409) {
          rememberSelectedSlot(null, false);
          await loadAvailability(
            qualification.sessionToken,
            selectedLink.slug,
            controller,
            "That time was just taken. The qualification session and attendee details are saved—choose a refreshed time.",
          );
          return;
        }
        if (result.status === 410) {
          requireNewHandoff(
            "This qualification session expired before a booking was created. Start another handoff explicitly to continue.",
          );
          return;
        }
        const message = responseError(
          result.body,
          "The meeting could not be booked. No duplicate request will be sent automatically.",
          result.status,
        );
        setError(message);
        setAnnouncement(message);
        return;
      }
      if (!result.body.status) {
        const message =
          "The calendar returned an incomplete booking result. Check status before trying again.";
        setError(message);
        setAnnouncement(message);
        return;
      }
      applyBooking(result.body);
      setStep("confirmation");
      if (bookingStatusIsProcessing(result.body.status)) {
        await pollStatus(
          qualification.sessionToken,
          selectedLink.slug,
          controller,
          false,
          bookingStatusIsDurable(result.body.status),
        );
      }
    } catch (caught) {
      if (isAbortError(caught)) return;
      const message =
        "The connection dropped during booking. Check booking status before choosing another time.";
      setError(message);
      setAnnouncement(message);
      setStep("confirmation");
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }

  if (!selectedLink) {
    return (
      <section
        className={`${styles.shell} ${styles.empty}`}
        id="handoff-scheduler"
      >
        <div className={styles.emptyMark} aria-hidden="true">
          ↗
        </div>
        <div>
          <span className={styles.eyebrow}>HANDOFF SCHEDULER</span>
          <h2>Publish a Smart Router Link to start booking.</h2>
          <p>
            Operators use a published link&apos;s real questions, routing rules,
            meeting type, and rep calendars. Create or publish one in Smart
            links, then this workspace becomes the fastest path from lead to
            confirmed meeting.
          </p>
          <a href="#smart-links">Open Smart links</a>
        </div>
      </section>
    );
  }

  const meetingType = qualification?.meetingType ?? null;
  const joinUrl = safeExternalUrl(booking?.conferenceUrl);
  const managePath = safeManagePath(booking?.managePath);
  const noMatchMessage =
    qualification?.noMatchMessage ?? selectedLink.noMatchMessage;
  const handoffLocked =
    step === "confirmation" && Boolean(qualification?.sessionToken);

  return (
    <section className={styles.shell} id="handoff-scheduler">
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <span className={styles.eyebrow}>PRIMARY OPERATOR WORKFLOW</span>
          <h2>Qualify. Find a live time. Hand it off.</h2>
          <p>
            Match the right rule and pool first. Hot Potato assigns the rep only
            after the attendee chooses a time and the live slot is rechecked.
          </p>
        </div>
        <label className={styles.linkPicker}>
          <span>
            {selectedLink.active
              ? "Published Smart Router Link"
              : "Saved Smart Router Link"}
          </span>
          <select
            value={selectedLink.slug}
            disabled={busy === "restore" || handoffLocked}
            onChange={(event) => startNewHandoff(event.target.value)}
          >
            {!selectedLink.active &&
              recovery?.routerLinkId === selectedLink.id && (
                <option value={selectedLink.slug}>
                  {selectedLink.name} (recovery only)
                </option>
              )}
            {publishedLinks.map((link) => (
              <option value={link.slug} key={link.id}>
                {link.name}
              </option>
            ))}
          </select>
          <small>
            {publishedLinks.length} published link
            {publishedLinks.length === 1 ? "" : "s"}
          </small>
        </label>
      </header>

      <div className={styles.progress} aria-label="Handoff progress">
        {[
          ["details", "1", "Qualify"],
          ["availability", "2", "Choose a time"],
          ["confirmation", "3", "Confirm handoff"],
        ].map(([value, number, label]) => {
          const rank = { details: 0, availability: 1, confirmation: 2 };
          const current = step === "no_match" ? 0 : rank[step];
          const item = rank[value as keyof typeof rank];
          return (
            <div
              className={`${styles.progressItem} ${item === current ? styles.progressActive : ""} ${item < current ? styles.progressDone : ""}`}
              key={value}
            >
              <span>{item < current ? "✓" : number}</span>
              <b>{label}</b>
            </div>
          );
        })}
      </div>

      <div className={styles.workspace}>
        <form className={styles.form} onSubmit={(event) => void qualify(event)}>
          <div className={styles.formHeading}>
            <div>
              <span>HANDOFF DETAILS</span>
              <h3>{selectedLink.title}</h3>
            </div>
            {step !== "details" && !handoffLocked && (
              <button type="button" onClick={() => resetSession()}>
                Edit
              </button>
            )}
          </div>
          {selectedLink.description && <p>{selectedLink.description}</p>}

          <div className={styles.identityFields}>
            <label>
              <span>Attendee name</span>
              <input
                type="text"
                required
                minLength={2}
                maxLength={80}
                autoComplete="name"
                disabled={step !== "details" || busy !== null}
                value={attendeeName}
                onChange={(event) => setAttendeeName(event.target.value)}
              />
            </label>
            <label>
              <span>Work email</span>
              <input
                type="email"
                required
                maxLength={320}
                autoComplete="email"
                disabled={step !== "details" || busy !== null}
                value={attendeeEmail}
                onChange={(event) => setAttendeeEmail(event.target.value)}
              />
            </label>
          </div>

          <div className={styles.questionFields}>
            {questions.map((question, index) => {
              const inputId = `handoff-${selectedLink.slug}-${index}`;
              const helpId = question.helpText ? `${inputId}-help` : undefined;
              return (
                <label key={question.field} htmlFor={inputId}>
                  <span>
                    {question.label}
                    {!question.required && <em>Optional</em>}
                  </span>
                  {question.type === "select" ? (
                    <select
                      id={inputId}
                      required={question.required}
                      disabled={step !== "details" || busy !== null}
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
                        <option value={option} key={option}>
                          {optionLabel(option)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={inputId}
                      required={question.required}
                      disabled={step !== "details" || busy !== null}
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
          </div>

          {step === "details" && (
            <button
              className={styles.primaryButton}
              type="submit"
              disabled={busy !== null}
            >
              <span>
                {busy === "qualify" ? "Qualifying…" : "Qualify handoff"}
              </span>
              <span aria-hidden="true">→</span>
            </button>
          )}
          <p className={styles.safetyNote}>
            <span aria-hidden="true">✓</span>
            Qualification is read-only. Ownership changes only after a live time
            is successfully booked.
          </p>
        </form>

        <div className={styles.result} aria-busy={busy !== null}>
          {step === "details" && (
            <div className={styles.ready}>
              <div className={styles.readyMark} aria-hidden="true">
                ↗
              </div>
              <span>READY FOR A HANDOFF</span>
              <h3>Use the link&apos;s real qualification path.</h3>
              <p>
                The match, live calendars, assigned rep, meeting link, and
                management link all stay together in this workflow.
              </p>
            </div>
          )}

          {step === "no_match" && (
            <div className={styles.noMatch}>
              <span>NO PUBLISHED ROUTE MATCHED</span>
              <h3>No meeting was offered.</h3>
              <p>{noMatchMessage}</p>
              <button type="button" onClick={() => resetSession()}>
                Review answers
              </button>
            </div>
          )}

          {(step === "availability" || step === "confirmation") &&
            meetingType && (
              <>
                <div className={styles.matchCard}>
                  <div className={styles.matchHeading}>
                    <span className={styles.matchCheck} aria-hidden="true">
                      ✓
                    </span>
                    <div>
                      <span>
                        {step === "confirmation"
                          ? booking?.repName
                            ? `ASSIGNMENT LOCKED · ${booking.repName}`
                            : "HANDOFF RECOVERY LOCKED"
                          : "QUALIFIED · NOT YET ASSIGNED"}
                      </span>
                      <h3>{meetingType.title}</h3>
                    </div>
                  </div>
                  <dl>
                    <div>
                      <dt>Rule</dt>
                      <dd>
                        {qualification?.matchedRuleName ?? "Matched rule"}
                      </dd>
                    </div>
                    <div>
                      <dt>Pool</dt>
                      <dd>{qualification?.poolName ?? "Matched pool"}</dd>
                    </div>
                    <div>
                      <dt>Meeting</dt>
                      <dd>
                        {meetingType.durationMinutes} min ·{" "}
                        {conferenceName(meetingType.conferenceProvider)}
                      </dd>
                    </div>
                  </dl>
                </div>

                {step === "availability" && (
                  <div className={styles.availability}>
                    <div className={styles.availabilityHeading}>
                      <div>
                        <span>LIVE AVAILABILITY</span>
                        <h3>Choose a time</h3>
                        <p>{timezone.replaceAll("_", " ")}</p>
                      </div>
                      <button
                        type="button"
                        disabled={busy !== null || !qualification?.sessionToken}
                        onClick={() =>
                          qualification?.sessionToken &&
                          void loadAvailability(
                            qualification.sessionToken,
                            selectedLink.slug,
                          )
                        }
                      >
                        {busy === "availability"
                          ? "Checking…"
                          : "Refresh times"}
                      </button>
                    </div>

                    {busy === "availability" && slots.length === 0 ? (
                      <div className={styles.loading} role="status">
                        <span />
                        Checking Google and Outlook calendars…
                      </div>
                    ) : groupedSlots.length === 0 ? (
                      <div className={styles.slotEmpty}>
                        <b>No live times are open right now.</b>
                        <span>
                          Refresh after calendars change, or check the matched
                          pool&apos;s calendar readiness.
                        </span>
                      </div>
                    ) : (
                      <div className={styles.slotGroups}>
                        {groupedSlots.map((group) => (
                          <section
                            className={styles.slotGroup}
                            aria-label={`Available times for ${dayLabel(group[0]!.startsAt)}`}
                            key={dayKey(group[0]!.startsAt)}
                          >
                            <h4>{dayLabel(group[0]!.startsAt)}</h4>
                            <div>
                              {group.map((slot) => (
                                <button
                                  type="button"
                                  key={slot.startsAt}
                                  aria-pressed={
                                    selectedSlot?.startsAt === slot.startsAt
                                  }
                                  aria-label={longDateTime(slot.startsAt)}
                                  onClick={() => {
                                    rememberSelectedSlot(slot);
                                    setError(null);
                                    setAnnouncement(
                                      `${longDateTime(slot.startsAt)} selected.`,
                                    );
                                  }}
                                >
                                  {timeLabel(slot.startsAt)}
                                </button>
                              ))}
                            </div>
                          </section>
                        ))}
                      </div>
                    )}

                    {selectedSlot && (
                      <AdditionalGuests
                        value={additionalAttendeeEmails}
                        onChange={setAdditionalAttendeeEmails}
                        primaryEmail={attendeeEmail}
                        disabled={busy !== null}
                        tone="dark"
                      />
                    )}

                    {selectedSlot && (
                      <div className={styles.selection}>
                        <div>
                          <span>SELECTED LIVE TIME</span>
                          <b>{longDateTime(selectedSlot.startsAt)}</b>
                        </div>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void bookSelected()}
                        >
                          {busy === "booking"
                            ? "Rechecking…"
                            : "Assign rep & book"}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {step === "confirmation" && (
                  <div className={styles.confirmation}>
                    {needsNewHandoff ? (
                      <>
                        <span className={styles.failureMark} aria-hidden="true">
                          !
                        </span>
                        <small>RECOVERY SESSION ENDED</small>
                        <h3>No active booking was recovered.</h3>
                        <p>
                          The saved qualification can no longer continue. Start
                          another handoff explicitly; Hot Potato will clear only
                          this expired recovery token.
                        </p>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => startNewHandoff()}
                        >
                          Start another handoff
                        </button>
                      </>
                    ) : booking?.status === "confirmed" ? (
                      <>
                        <span
                          className={styles.confirmationMark}
                          aria-hidden="true"
                        >
                          ✓
                        </span>
                        <small>HANDOFF COMPLETE</small>
                        <h3>Meeting confirmed.</h3>
                        {selectedSlot && (
                          <p>{longDateTime(selectedSlot.startsAt)}</p>
                        )}
                        {booking.repName && (
                          <p>Assigned to {booking.repName}</p>
                        )}
                        {additionalAttendeeEmails.length > 0 && (
                          <p>
                            Calendar invitations sent to the attendee and{" "}
                            {additionalAttendeeEmails.length} additional{" "}
                            {additionalAttendeeEmails.length === 1
                              ? "guest"
                              : "guests"}
                            .
                          </p>
                        )}
                        <div className={styles.confirmationActions}>
                          {joinUrl && (
                            <a href={joinUrl} target="_blank" rel="noreferrer">
                              Open meeting ↗
                            </a>
                          )}
                          {managePath && (
                            <a href={managePath}>Manage booking</a>
                          )}
                        </div>
                        {!joinUrl && !managePath && (
                          <p className={styles.inviteNote}>
                            The calendar invitation contains the final meeting
                            details.
                          </p>
                        )}
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => startNewHandoff()}
                        >
                          Start another handoff
                        </button>
                      </>
                    ) : booking?.status === "cancelled" ? (
                      <>
                        <span
                          className={styles.confirmationMark}
                          aria-hidden="true"
                        >
                          ✓
                        </span>
                        <small>FAILED BOOKING CLOSED</small>
                        <h3>The failed booking is safely closed.</h3>
                        <p>
                          Any provider event from that request was removed
                          before the time was released. The original routing and
                          CRM audit evidence remain intact; starting another
                          handoff is an explicit new request.
                        </p>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => startNewHandoff()}
                        >
                          Start another handoff
                        </button>
                      </>
                    ) : booking?.status === "failed" ? (
                      <>
                        <span className={styles.failureMark} aria-hidden="true">
                          !
                        </span>
                        <small>CALENDAR WRITE FAILED</small>
                        <h3>
                          {booking.repName
                            ? `${booking.repName} is still assigned.`
                            : "The assigned rep is preserved."}
                        </h3>
                        <p>
                          The provider did not return a complete result, so the
                          time stays reserved. Retry checks for the same Google
                          or Outlook event before writing again. Close checks
                          for and removes any event before releasing the time.
                          Hot Potato will not reroute the attendee or choose a
                          different rep.
                        </p>
                        <div className={styles.confirmationActions}>
                          <button
                            type="button"
                            disabled={
                              busy !== null || !qualification?.sessionToken
                            }
                            onClick={() => void retryFailedBooking()}
                          >
                            {busy === "retry"
                              ? "Retrying same booking…"
                              : "Retry same booking"}
                          </button>
                          <button
                            type="button"
                            disabled={
                              busy !== null || !qualification?.sessionToken
                            }
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
                        <span className={styles.pendingMark} aria-hidden="true">
                          ···
                        </span>
                        <small>PROVIDER CLEANUP IN PROGRESS</small>
                        <h3>Verifying the calendar before closing.</h3>
                        <p>
                          The time stays reserved while Hot Potato checks Google
                          or Outlook again. If an event exists, it will be
                          removed before the time is released.
                        </p>
                        {managePath && (
                          <a href={managePath}>Continue on the booking page</a>
                        )}
                        <button
                          type="button"
                          disabled={
                            busy !== null || !qualification?.sessionToken
                          }
                          onClick={() => {
                            if (!qualification?.sessionToken) return;
                            void pollStatus(
                              qualification.sessionToken,
                              selectedLink.slug,
                              undefined,
                              true,
                              bookingStatusIsDurable(booking.status),
                            );
                          }}
                        >
                          {busy === "status"
                            ? "Checking…"
                            : "Check cleanup status"}
                        </button>
                      </>
                    ) : booking?.status === "attempting" ? (
                      <>
                        <span className={styles.pendingMark} aria-hidden="true">
                          ···
                        </span>
                        <small>TIME LOCKED</small>
                        <h3>Verifying the selected time.</h3>
                        {selectedSlot && (
                          <p>{longDateTime(selectedSlot.startsAt)}</p>
                        )}
                        <p>
                          This request is already in progress. Hot Potato will
                          reuse the same provider transaction and will not
                          create a duplicate meeting or assignment.
                        </p>
                        <button
                          type="button"
                          disabled={
                            busy !== null || !qualification?.sessionToken
                          }
                          onClick={() => {
                            if (!qualification?.sessionToken) return;
                            void pollStatus(
                              qualification.sessionToken,
                              selectedLink.slug,
                              undefined,
                              true,
                              bookingStatusIsDurable(booking.status),
                            );
                          }}
                        >
                          {busy === "status"
                            ? "Checking…"
                            : "Check booking status"}
                        </button>
                      </>
                    ) : (
                      <>
                        <span className={styles.pendingMark} aria-hidden="true">
                          ···
                        </span>
                        <small>CALENDAR WRITE IN PROGRESS</small>
                        <h3>Confirming the handoff.</h3>
                        <p>
                          Status checks are read-only and will not create a
                          duplicate meeting.
                        </p>
                        {managePath && (
                          <a href={managePath}>
                            Keep this booking recovery link
                          </a>
                        )}
                        <button
                          type="button"
                          disabled={
                            busy !== null || !qualification?.sessionToken
                          }
                          onClick={() => {
                            if (!qualification?.sessionToken) return;
                            if (booking?.status) {
                              void pollStatus(
                                qualification.sessionToken,
                                selectedLink.slug,
                                undefined,
                                true,
                                bookingStatusIsDurable(booking.status),
                              );
                            } else if (recovery) {
                              void restoreHandoff(recovery);
                            }
                          }}
                        >
                          {busy === "status" || busy === "restore"
                            ? "Checking…"
                            : booking?.status
                              ? "Check booking status"
                              : "Recover handoff"}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </>
            )}

          {error && (
            <div className={styles.error} role="alert">
              <span aria-hidden="true">!</span>
              <p>{error}</p>
            </div>
          )}
        </div>
      </div>

      <p className={styles.announcement} role="status" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}
