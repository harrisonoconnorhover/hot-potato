import { randomBytes } from "node:crypto";
import {
  CalendarSlotUnavailableError,
  InviteeBookingLimitError,
  type BeginRouterLinkBookingAttemptRequest,
  type BeginRouterLinkBookingAttemptResult,
  type BookingCandidateQuote,
  type LegacyBookingCalendarAccountProof,
  RouterLinkConflictError,
  RouterLinkNotFoundError,
  RouterLinkSessionExpiredError,
  RouterLinkValidationError,
  type BookRouterLinkSessionRequest,
  type PublicBookingStatus,
  type PublicSchedule,
  type QualifyRouterLinkRequest,
  type ReconciledCalendarEvent,
  type RouterLinkBookingRetryContext,
  type RouterLinkQualification,
  type RouterLinkSession,
} from "@hot-potato/db";
import { verifiedFailedRouterProviderEvent } from "./router-booking-recovery";
import {
  bookingInput,
  qualificationInput,
  routerSlug,
  sessionInput,
} from "./api/router-links/schemas";
import {
  PublicBodyError,
  publicBodyError,
  publicError,
  publicJson,
  readPublicJson,
} from "./public-api";

export const handoffQualificationInput = qualificationInput
  .omit({ website: true })
  .extend({ routerSlug })
  .strict();

export const handoffSessionInput = sessionInput.extend({ routerSlug }).strict();

export const handoffBookingInput = bookingInput
  .omit({ website: true })
  .extend({ routerSlug })
  .strict();

export interface HandoffRepository {
  qualifyRouterLink(
    input: QualifyRouterLinkRequest,
  ): Promise<RouterLinkQualification>;
  routerLinkSession(
    organizationSlug: string,
    routerSlug: string,
    sessionToken: string,
  ): Promise<RouterLinkSession | null>;
  routerLinkBookingStatus(
    organizationSlug: string,
    routerSlug: string,
    sessionToken: string,
    now?: Date,
  ): Promise<PublicBookingStatus | null>;
  routerLinkBookingRetryContext(
    organizationSlug: string,
    routerSlug: string,
    sessionToken: string,
  ): Promise<RouterLinkBookingRetryContext | null>;
  abandonRouterLinkBooking(
    organizationSlug: string,
    routerSlug: string,
    sessionToken: string,
    providerEvent: ReconciledCalendarEvent | null,
  ): Promise<PublicBookingStatus | null>;
  retryRouterLinkBooking(
    organizationSlug: string,
    routerSlug: string,
    sessionToken: string,
    calendarQuote?: BookingCandidateQuote,
  ): Promise<PublicBookingStatus | null>;
  bindLegacyBookingCalendarAccount(
    manageToken: string,
    proof: LegacyBookingCalendarAccountProof,
  ): Promise<boolean>;
  bookRouterLinkSession(
    input: BookRouterLinkSessionRequest,
  ): Promise<PublicBookingStatus>;
  beginRouterLinkBookingAttempt(
    input: BeginRouterLinkBookingAttemptRequest,
  ): Promise<BeginRouterLinkBookingAttemptResult>;
  releaseRouterLinkBookingAttempt(
    organizationSlug: string,
    routerSlug: string,
    sessionToken: string,
    attemptToken: string,
  ): Promise<void>;
}

export type HandoffSlot = {
  startsAt: string;
  endsAt: string;
};

export type HandoffSlotOption = HandoffSlot & {
  candidateQuotes: BookingCandidateQuote[];
};

export type HandoffDependencies = {
  organizationSlug: string;
  repository: HandoffRepository;
  resolveCurrentOwnerEmail: (
    organizationSlug: string,
    contactEmail: string,
  ) => Promise<string | null>;
  cachedAvailableSlots: (schedule: PublicSchedule) => Promise<HandoffSlot[]>;
  freshAvailableSlotOptions: (
    schedule: PublicSchedule,
    onlyRepId?: string,
    excludeBookingExternalId?: string,
  ) => Promise<HandoffSlotOption[]>;
  findOwnedCalendarEvent: (
    context: RouterLinkBookingRetryContext,
  ) => Promise<ReconciledCalendarEvent | null>;
  createSessionToken?: () => string;
  createBookingAttemptToken?: () => string;
};

type HandoffOperation =
  | "qualify"
  | "availability"
  | "booking"
  | "abandon"
  | "retry"
  | "status";

const unavailableByOperation: Record<
  HandoffOperation,
  { message: string; code: string }
> = {
  qualify: {
    message:
      "The Smart Router could not be evaluated. Check its configuration and try again.",
    code: "router_unavailable",
  },
  availability: {
    message:
      "Connected calendars could not be checked. Refresh availability and try again.",
    code: "calendar_unavailable",
  },
  booking: {
    message:
      "The booking could not be completed. Refresh availability and try again.",
    code: "booking_unavailable",
  },
  abandon: {
    message:
      "The failed booking could not be closed. Its original assignment is unchanged; try again.",
    code: "abandon_unavailable",
  },
  retry: {
    message:
      "The same booking could not be requeued. Its original representative assignment is unchanged; try again.",
    code: "retry_unavailable",
  },
  status: {
    message: "Booking status could not be loaded. Try again.",
    code: "status_unavailable",
  },
};

function invalidCode(operation: HandoffOperation) {
  if (operation === "qualify") return "invalid_answers";
  if (operation === "booking") return "invalid_booking";
  return "invalid_session";
}

export function handoffError(error: unknown, operation: HandoffOperation) {
  if (error instanceof PublicBodyError) return publicBodyError(error);
  if (error instanceof RouterLinkValidationError) {
    return publicError(422, error.message, invalidCode(operation));
  }
  if (error instanceof CalendarSlotUnavailableError) {
    return publicError(
      409,
      "That time is no longer available. Refresh the calendar and choose another time.",
      "slot_unavailable",
    );
  }
  if (error instanceof InviteeBookingLimitError) {
    return publicError(409, error.message, "booking_limit_reached");
  }
  if (error instanceof RouterLinkConflictError) {
    return publicError(409, error.message, "routing_conflict");
  }
  if (error instanceof RouterLinkSessionExpiredError) {
    return publicError(
      410,
      "This routing session has expired. Qualify the visitor again.",
      "session_expired",
    );
  }
  if (error instanceof RouterLinkNotFoundError) {
    return publicError(404, "Smart Router Link not found.", "not_found");
  }

  console.error(
    `Operator handoff ${operation} failed:`,
    error instanceof Error ? error.name : "Unknown error",
  );
  const unavailable = unavailableByOperation[operation];
  return publicError(503, unavailable.message, unavailable.code);
}

function validationError(
  issues: ReadonlyArray<{ message: string }>,
  fallback: string,
  code: string,
) {
  return publicError(422, issues[0]?.message ?? fallback, code);
}

function bookingStatusResponse(booking: PublicBookingStatus) {
  return publicJson(
    {
      status: booking.status,
      error:
        booking.status === "failed"
          ? "The calendar provider did not return a complete result. Retry or close this same booking safely."
          : booking.status === "confirmed" && booking.error
            ? "The requested calendar change could not be completed. The existing provider event remains active."
            : null,
      managePath: booking.managePath,
      conferenceUrl: booking.conferenceUrl,
      repName: booking.repName,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
    },
    booking.status === "attempting" ||
      booking.status === "pending" ||
      booking.status === "cancel_pending"
      ? 202
      : 200,
  );
}

export async function qualifyHandoffRequest(
  request: Request,
  dependencies: HandoffDependencies,
) {
  try {
    const parsed = handoffQualificationInput.safeParse(
      await readPublicJson(request),
    );
    if (!parsed.success) {
      return validationError(
        parsed.error.issues,
        "Check the qualification details.",
        "invalid_answers",
      );
    }
    const input = parsed.data;
    const currentOwnerEmail = await dependencies.resolveCurrentOwnerEmail(
      dependencies.organizationSlug,
      input.attendeeEmail,
    );
    const qualification = await dependencies.repository.qualifyRouterLink({
      organizationSlug: dependencies.organizationSlug,
      routerSlug: input.routerSlug,
      sessionToken:
        dependencies.createSessionToken?.() ??
        randomBytes(32).toString("base64url"),
      attendeeName: input.attendeeName,
      attendeeEmail: input.attendeeEmail,
      answers: input.answers,
      ...(currentOwnerEmail ? { currentOwnerEmail } : {}),
    });

    if (
      qualification.outcome === "matched" &&
      (!qualification.meetingType ||
        !qualification.matchedRuleName ||
        !qualification.poolName)
    ) {
      return publicError(
        503,
        "The route matched, but its handoff details could not be loaded. Republish the Smart Link and try again.",
        "routing_metadata_unavailable",
      );
    }

    return publicJson({
      outcome: qualification.outcome,
      sessionToken: qualification.sessionToken,
      expiresAt: qualification.expiresAt,
      meetingType: qualification.meetingType,
      matchedRuleName: qualification.matchedRuleName ?? null,
      poolName: qualification.poolName ?? null,
      noMatchMessage:
        qualification.outcome === "no_match"
          ? qualification.noMatchMessage
          : null,
    });
  } catch (error) {
    return handoffError(error, "qualify");
  }
}

export async function availabilityHandoffRequest(
  request: Request,
  dependencies: HandoffDependencies,
) {
  try {
    const parsed = handoffSessionInput.safeParse(await readPublicJson(request));
    if (!parsed.success) {
      return validationError(
        parsed.error.issues,
        "Enter a valid routing session.",
        "invalid_session",
      );
    }
    const input = parsed.data;
    const session = await dependencies.repository.routerLinkSession(
      dependencies.organizationSlug,
      input.routerSlug,
      input.sessionToken,
    );
    if (!session) {
      return publicError(404, "Routing session not found.", "not_found");
    }

    const slots = await dependencies.cachedAvailableSlots(session.schedule);
    return publicJson({
      slots,
      meetingType: {
        slug: session.schedule.schedulingSlug,
        title: session.schedule.meetingTitle,
        description: session.schedule.meetingDescription,
        durationMinutes: session.schedule.durationMinutes,
        minimumNoticeMinutes: session.schedule.minimumNoticeMinutes,
        bookingWindowDays: session.schedule.bookingWindowDays,
        conferenceProvider: session.schedule.conferenceProvider,
        reminderMinutes: session.schedule.reminderMinutes,
      },
      matchedRuleName: session.matchedRuleName,
      poolName: session.poolName,
    });
  } catch (error) {
    return handoffError(error, "availability");
  }
}

export async function bookingHandoffRequest(
  request: Request,
  dependencies: HandoffDependencies,
) {
  try {
    const parsed = handoffBookingInput.safeParse(await readPublicJson(request));
    if (!parsed.success) {
      return validationError(
        parsed.error.issues,
        "Choose a valid available time.",
        "invalid_booking",
      );
    }
    const input = parsed.data;

    const existing = await dependencies.repository.routerLinkBookingStatus(
      dependencies.organizationSlug,
      input.routerSlug,
      input.sessionToken,
    );
    if (existing) return bookingStatusResponse(existing);

    const session = await dependencies.repository.routerLinkSession(
      dependencies.organizationSlug,
      input.routerSlug,
      input.sessionToken,
    );
    if (!session) {
      return publicError(404, "Routing session not found.", "not_found");
    }

    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(
      startsAt.getTime() + session.schedule.durationMinutes * 60_000,
    );
    const attemptToken =
      dependencies.createBookingAttemptToken?.() ??
      randomBytes(32).toString("base64url");
    const attempt = await dependencies.repository.beginRouterLinkBookingAttempt(
      {
        organizationSlug: dependencies.organizationSlug,
        routerSlug: input.routerSlug,
        sessionToken: input.sessionToken,
        attemptToken,
        startsAt,
        endsAt,
      },
    );
    if (!attempt.acquired) return bookingStatusResponse(attempt.booking);

    try {
      const offeredSlots = await dependencies.freshAvailableSlotOptions(
        session.schedule,
      );
      const selected = offeredSlots.find(
        (slot) =>
          slot.startsAt === startsAt.toISOString() &&
          slot.endsAt === endsAt.toISOString(),
      );
      if (!selected) throw new CalendarSlotUnavailableError();

      const booking = await dependencies.repository.bookRouterLinkSession({
        organizationSlug: dependencies.organizationSlug,
        routerSlug: input.routerSlug,
        sessionToken: input.sessionToken,
        attemptToken,
        candidateQuotes: selected.candidateQuotes,
        startsAt,
        endsAt,
        additionalAttendeeEmails: input.additionalAttendeeEmails,
      });
      return bookingStatusResponse(booking);
    } catch (error) {
      await dependencies.repository
        .releaseRouterLinkBookingAttempt(
          dependencies.organizationSlug,
          input.routerSlug,
          input.sessionToken,
          attemptToken,
        )
        .catch(() => undefined);
      throw error;
    }
  } catch (error) {
    return handoffError(error, "booking");
  }
}

export async function bookingStatusHandoffRequest(
  request: Request,
  dependencies: HandoffDependencies,
) {
  try {
    const parsed = handoffSessionInput.safeParse(await readPublicJson(request));
    if (!parsed.success) {
      return validationError(
        parsed.error.issues,
        "Enter a valid routing session.",
        "invalid_session",
      );
    }
    const input = parsed.data;
    const booking = await dependencies.repository.routerLinkBookingStatus(
      dependencies.organizationSlug,
      input.routerSlug,
      input.sessionToken,
    );
    if (!booking) {
      return publicError(404, "Booking not found.", "not_found");
    }
    return bookingStatusResponse(booking);
  } catch (error) {
    return handoffError(error, "status");
  }
}

export async function retryBookingHandoffRequest(
  request: Request,
  dependencies: HandoffDependencies,
) {
  try {
    const parsed = handoffSessionInput.safeParse(await readPublicJson(request));
    if (!parsed.success) {
      return validationError(
        parsed.error.issues,
        "Enter a valid routing session.",
        "invalid_session",
      );
    }
    const input = parsed.data;
    const retryContext =
      await dependencies.repository.routerLinkBookingRetryContext(
        dependencies.organizationSlug,
        input.routerSlug,
        input.sessionToken,
      );
    if (!retryContext) {
      return publicError(404, "Booking not found.", "not_found");
    }
    let calendarQuote: BookingCandidateQuote | undefined;
    if (retryContext.status === "failed") {
      const providerEvent = await verifiedFailedRouterProviderEvent(
        retryContext,
        {
          findOwnedCalendarEvent: dependencies.findOwnedCalendarEvent,
          bindLegacyBookingCalendarAccount: (manageToken, proof) =>
            dependencies.repository.bindLegacyBookingCalendarAccount(
              manageToken,
              proof,
            ),
        },
      );
      if (!providerEvent) {
        if (!retryContext.schedule) {
          throw new RouterLinkConflictError(
            "The original booking destination is no longer available to retry.",
          );
        }
        const available = await dependencies.freshAvailableSlotOptions(
          retryContext.schedule,
          retryContext.repId,
          retryContext.transactionId,
        );
        const originalSlot = available.find(
          (slot) =>
            slot.startsAt === retryContext.startsAt &&
            slot.endsAt === retryContext.endsAt,
        );
        calendarQuote = originalSlot?.candidateQuotes.find(
          (quote) => quote.repId === retryContext.repId,
        );
        if (!calendarQuote) {
          throw new CalendarSlotUnavailableError();
        }
      }
    }
    const booking = await dependencies.repository.retryRouterLinkBooking(
      dependencies.organizationSlug,
      input.routerSlug,
      input.sessionToken,
      calendarQuote,
    );
    if (!booking) {
      return publicError(404, "Booking not found.", "not_found");
    }
    return bookingStatusResponse(booking);
  } catch (error) {
    return handoffError(error, "retry");
  }
}

export async function abandonBookingHandoffRequest(
  request: Request,
  dependencies: HandoffDependencies,
) {
  try {
    const parsed = handoffSessionInput.safeParse(await readPublicJson(request));
    if (!parsed.success) {
      return validationError(
        parsed.error.issues,
        "Enter a valid routing session.",
        "invalid_session",
      );
    }
    const input = parsed.data;
    const retryContext =
      await dependencies.repository.routerLinkBookingRetryContext(
        dependencies.organizationSlug,
        input.routerSlug,
        input.sessionToken,
      );
    if (!retryContext) {
      return publicError(404, "Booking not found.", "not_found");
    }
    const providerEvent = await verifiedFailedRouterProviderEvent(
      retryContext,
      {
        findOwnedCalendarEvent: dependencies.findOwnedCalendarEvent,
        bindLegacyBookingCalendarAccount: (manageToken, proof) =>
          dependencies.repository.bindLegacyBookingCalendarAccount(
            manageToken,
            proof,
          ),
      },
    );
    const booking = await dependencies.repository.abandonRouterLinkBooking(
      dependencies.organizationSlug,
      input.routerSlug,
      input.sessionToken,
      providerEvent,
    );
    if (!booking) {
      return publicError(404, "Booking not found.", "not_found");
    }
    return bookingStatusResponse(booking);
  } catch (error) {
    return handoffError(error, "abandon");
  }
}
