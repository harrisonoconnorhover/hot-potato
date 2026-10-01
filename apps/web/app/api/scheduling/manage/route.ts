import {
  CalendarSlotUnavailableError,
  RouterLinkConflictError,
  type BookingCandidateQuote,
} from "@hot-potato/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  managedBookingWithVerifiedCalendar,
  managedBookingView,
  unverifiedManagedBookingError,
} from "../../../managed-booking";
import { bookingChangeIsOpen } from "../../../booking-change-policy";
import {
  availableManagedSlotOptions,
  availableManagedSlots,
} from "../../../public-scheduling";
import { findOwnedRepCalendarEvent } from "../../../rep-calendar-availability";
import { repository } from "../../../repository";
import { verifiedFailedRouterProviderEvent } from "../../../router-booking-recovery";
import { managedRescheduleSelection } from "./managed-reschedule";

const tokenSchema = z.uuid();
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel"), token: z.uuid() }),
  z.object({ action: z.literal("retry_failed_router"), token: z.uuid() }),
  z.object({ action: z.literal("close_failed_router"), token: z.uuid() }),
  z.object({
    action: z.literal("reschedule"),
    token: z.uuid(),
    startsAt: z.iso.datetime(),
  }),
]);

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const token = tokenSchema.safeParse(
    new URL(request.url).searchParams.get("token"),
  );
  if (!token.success) {
    return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  }
  const booking = await managedBookingWithVerifiedCalendar(token.data);
  if (!booking) {
    return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  }
  const slots =
    booking.status === "confirmed" &&
    bookingChangeIsOpen(booking.rescheduleAllowedUntil)
      ? await availableManagedSlots(booking, booking.transactionId)
      : [];
  return NextResponse.json(
    { booking: managedBookingView(booking), slots },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Choose a valid booking action." },
      { status: 400 },
    );
  }
  const booking = await managedBookingWithVerifiedCalendar(parsed.data.token);
  if (!booking) {
    return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  }
  const accountError = unverifiedManagedBookingError(booking);
  if (accountError) {
    return NextResponse.json({ error: accountError }, { status: 409 });
  }

  try {
    if (
      parsed.data.action === "retry_failed_router" ||
      parsed.data.action === "close_failed_router"
    ) {
      if (!booking.failedRouterCreate || booking.status !== "failed") {
        throw new RouterLinkConflictError(
          "Only a failed Smart Router calendar write can use this recovery action.",
        );
      }
      const retryContext =
        await repository.managedRouterLinkBookingRetryContext(
          parsed.data.token,
        );
      if (!retryContext) {
        throw new RouterLinkConflictError(
          "Reconnect the original Google or Outlook account before recovering this booking.",
        );
      }
      const providerEvent = await verifiedFailedRouterProviderEvent(
        retryContext,
        {
          findOwnedCalendarEvent: (context) =>
            findOwnedRepCalendarEvent({
              organizationSlug: context.organizationSlug,
              repId: context.repId,
              provider: context.calendarProvider,
              calendarExternalAccountId: context.calendarExternalAccountId,
              transactionId: context.transactionId,
              externalEventId: context.externalEventId,
              startsAt: new Date(context.startsAt),
              endsAt: new Date(context.endsAt),
            }),
          bindLegacyBookingCalendarAccount: (manageToken, proof) =>
            repository.bindLegacyBookingCalendarAccount(manageToken, proof),
        },
      );
      if (parsed.data.action === "close_failed_router") {
        const closed = await repository.abandonManagedRouterLinkBooking(
          parsed.data.token,
          providerEvent,
        );
        if (!closed) throw new Error("Booking not found.");
        return NextResponse.json({ status: closed.status }, { status: 202 });
      }

      let calendarQuote: BookingCandidateQuote | undefined;
      if (!providerEvent) {
        const slot = (
          await availableManagedSlotOptions(booking, booking.transactionId)
        ).find(
          (candidate) =>
            candidate.startsAt === booking.startsAt &&
            candidate.endsAt === booking.endsAt,
        );
        calendarQuote = slot?.candidateQuotes.find(
          (quote) => quote.repId === booking.repId,
        );
        if (!calendarQuote) throw new CalendarSlotUnavailableError();
      }
      const retried = await repository.retryManagedRouterLinkBooking(
        parsed.data.token,
        calendarQuote,
      );
      if (!retried) throw new Error("Booking not found.");
      return NextResponse.json({ status: retried.status }, { status: 202 });
    }

    if (parsed.data.action === "cancel") {
      const status = await repository.requestBookingCancellation(
        parsed.data.token,
      );
      return NextResponse.json(
        { status },
        { status: status === "cancelled" ? 200 : 202 },
      );
    }

    const requestedStart = parsed.data.startsAt;
    const exactAcceptedRepeat =
      (booking.status === "confirmed" ||
        (booking.status === "reschedule_pending" && !booking.error)) &&
      Date.parse(booking.startsAt) === Date.parse(requestedStart);
    if (exactAcceptedRepeat) {
      // A provider may already report the accepted target as busy. Confirm the
      // ledger under its row lock rather than treating a lost response as a new
      // request for availability. A changed or newly failed operation still
      // fails closed because this acknowledgment carries no provider quote.
      const status = await repository.requestBookingReschedule({
        manageToken: parsed.data.token,
        startsAt: new Date(booking.startsAt),
        endsAt: new Date(booking.endsAt),
        reminderMinutes: 0,
      });
      return NextResponse.json(
        { status },
        { status: status === "confirmed" ? 200 : 202 },
      );
    }
    const selection = await managedRescheduleSelection(
      booking,
      requestedStart,
      (managedBooking) =>
        availableManagedSlotOptions(
          managedBooking,
          managedBooking.transactionId,
        ),
      (range) =>
        findOwnedRepCalendarEvent({
          organizationSlug: booking.organizationSlug,
          repId: booking.repId,
          provider: booking.calendarProvider,
          calendarExternalAccountId: booking.calendarExternalAccountId,
          transactionId: booking.transactionId,
          externalEventId: booking.externalEventId,
          ...range,
        }),
    );
    if (!selection) {
      return NextResponse.json(
        { error: "That time is no longer available. Choose another time." },
        { status: 409 },
      );
    }
    const requiresCalendarQuote =
      !selection.exactFailedRetry || !selection.providerEventAtRequested;
    if (requiresCalendarQuote && selection.slot.candidateQuotes.length !== 1) {
      return NextResponse.json(
        { error: "That time is no longer available. Choose another time." },
        { status: 409 },
      );
    }
    const reminderMinutes = selection.exactFailedRetry
      ? 0
      : booking.rescheduleSchedule?.reminderMinutes;
    if (reminderMinutes === undefined) {
      return NextResponse.json(
        { error: "That time is no longer available. Choose another time." },
        { status: 409 },
      );
    }
    const status = await repository.requestBookingReschedule({
      manageToken: parsed.data.token,
      startsAt: new Date(selection.slot.startsAt),
      endsAt: new Date(selection.slot.endsAt),
      reminderMinutes,
      ...(selection.slot.candidateQuotes[0]
        ? { calendarQuote: selection.slot.candidateQuotes[0] }
        : {}),
      ...(selection.exactFailedRetry
        ? { providerEventAtRequested: selection.providerEventAtRequested }
        : {}),
    });
    return NextResponse.json(
      { status },
      { status: status === "confirmed" ? 200 : 202 },
    );
  } catch (error) {
    if (error instanceof CalendarSlotUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof RouterLinkConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (
      parsed.data.action === "retry_failed_router" ||
      parsed.data.action === "close_failed_router"
    ) {
      console.error(
        "Managed Smart Router recovery failed:",
        error instanceof Error ? error.name : "Unknown error",
      );
      return NextResponse.json(
        {
          error:
            "The calendar provider could not be verified. The time remains reserved; repair the original calendar connection and try again.",
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "The booking could not be changed.",
      },
      { status: 409 },
    );
  }
}
