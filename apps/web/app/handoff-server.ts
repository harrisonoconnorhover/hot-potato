import {
  availablePublicSlotOptions,
  cachedAvailablePublicSlots,
} from "./public-scheduling";
import { findOwnedRepCalendarEvent } from "./rep-calendar-availability";
import { resolveHubSpotOwnership } from "./hubspot-routing-context";
import { repository } from "./repository";
import type { HandoffDependencies } from "./handoff-api";

export function handoffDependencies(): HandoffDependencies {
  return {
    organizationSlug: process.env.HOT_POTATO_ORG ?? "acme",
    repository,
    resolveCurrentOwnerEmail: async (organizationSlug, contactEmail) =>
      (
        await resolveHubSpotOwnership({
          organizationSlug,
          contactEmail,
        })
      ).ownerEmail,
    cachedAvailableSlots: cachedAvailablePublicSlots,
    freshAvailableSlotOptions: (
      schedule,
      onlyRepId,
      excludeBookingExternalId,
    ) =>
      availablePublicSlotOptions(
        schedule,
        new Date(),
        onlyRepId,
        excludeBookingExternalId,
      ),
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
  };
}
