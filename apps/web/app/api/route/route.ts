import { NoEligibleRepError, NoMatchingRuleError } from "@hot-potato/router";
import {
  GoogleCalendarAdapter,
  MicrosoftCalendarAdapter,
} from "@hot-potato/integrations";
import { NextResponse } from "next/server";
import { z } from "zod";
import { connectionManager } from "../../connections";
import {
  calendarSource,
  combinedRepBusyIntervals,
} from "../../rep-calendar-availability";
import {
  HubSpotOwnershipLookupError,
  leadWithAuthoritativeHubSpotOwner,
  resolveHubSpotOwnership,
} from "../../hubspot-routing-context";
import { repository } from "../../repository";

const routeRequest = z.object({
  externalId: z.string().min(1).max(200).optional(),
  lead: z
    .object({
      email: z.email(),
      current_owner_email: z.email().optional(),
    })
    .loose(),
});

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await map(values[index]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return results;
}

export async function POST(request: Request) {
  const parsed = routeRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Enter a valid lead email and routing fields." },
      { status: 400 },
    );
  }

  try {
    const organizationSlug = process.env.HOT_POTATO_ORG ?? "acme";
    if (parsed.data.externalId) {
      const existing = await repository.decisionByExternalId(
        organizationSlug,
        parsed.data.externalId,
      );
      if (existing) return NextResponse.json(existing);
    }

    const ownership = await resolveHubSpotOwnership({
      organizationSlug,
      contactEmail: parsed.data.lead.email,
    });
    const lead = leadWithAuthoritativeHubSpotOwner(parsed.data.lead, ownership);
    const now = new Date();
    let unavailableRepEmails: string[] = [];
    let availabilitySource:
      | "weekly_schedule"
      | "google_calendar"
      | "microsoft_calendar"
      | "connected_calendars" = "weekly_schedule";
    let availabilitySourceByRepEmail:
      | Record<
          string,
          "google_calendar" | "microsoft_calendar" | "connected_calendars"
        >
      | undefined;
    const candidates = await repository.routeCandidateReps({
      organizationSlug,
      lead,
      now,
    });
    const repCalendars = await repository.repAvailabilityCalendarSources(
      organizationSlug,
      candidates.map((rep) => rep.id),
    );
    if (repCalendars.size > 0) {
      availabilitySourceByRepEmail = {};
      unavailableRepEmails = candidates
        .filter((rep) => !repCalendars.has(rep.id))
        .map((rep) => rep.email);
      const checked = await mapWithConcurrency(
        candidates.filter((candidate) => repCalendars.has(candidate.id)),
        6,
        async (rep) => {
          const calendars = repCalendars.get(rep.id)!;
          try {
            const busy = await combinedRepBusyIntervals({
              organizationSlug,
              repId: rep.id,
              calendars,
              startsAt: now,
              endsAt: new Date(now.getTime() + 30 * 60_000),
            });
            return { rep, calendars, unavailable: busy.length > 0 };
          } catch (error) {
            console.error(
              `Connected calendar availability failed for rep ${rep.id}:`,
              error instanceof Error ? error.message : "Unknown error",
            );
            return { rep, calendars, unavailable: true };
          }
        },
      );
      for (const result of checked) {
        if (result.unavailable) unavailableRepEmails.push(result.rep.email);
        availabilitySourceByRepEmail[result.rep.email] = calendarSource(
          result.calendars,
        );
      }
    } else {
      const activeCalendar = (
        await repository.connectionStatuses(organizationSlug)
      ).find((connection) => connection.active);
      if (
        activeCalendar?.provider !== "google" &&
        activeCalendar?.provider !== "microsoft"
      ) {
        const decision = await repository.route({
          organizationSlug,
          externalId: parsed.data.externalId,
          lead,
          now,
          unavailableRepEmails,
          availabilitySource,
        });
        return NextResponse.json(decision, { status: 201 });
      }
      const calendar =
        activeCalendar.provider === "google"
          ? new GoogleCalendarAdapter(() =>
              connectionManager().accessToken(organizationSlug, "google"),
            )
          : new MicrosoftCalendarAdapter(() =>
              connectionManager().accessToken(organizationSlug, "microsoft"),
            );
      try {
        unavailableRepEmails = await calendar.busyRepEmails({
          repEmails: candidates.map((rep) => rep.email),
          startsAt: now,
          endsAt: new Date(now.getTime() + 30 * 60_000),
        });
        availabilitySource =
          activeCalendar.provider === "google"
            ? "google_calendar"
            : "microsoft_calendar";
      } catch (error) {
        console.error(
          `${activeCalendar.provider} calendar availability failed:`,
          error instanceof Error ? error.message : "Unknown error",
        );
        return NextResponse.json(
          {
            error: `${activeCalendar.provider === "google" ? "Google Calendar" : "Microsoft 365"} availability could not be verified.`,
          },
          { status: 503 },
        );
      }
    }

    const decision = await repository.route({
      organizationSlug,
      externalId: parsed.data.externalId,
      lead,
      now,
      unavailableRepEmails,
      availabilitySource,
      availabilitySourceByRepEmail,
    });
    return NextResponse.json(decision, { status: 201 });
  } catch (error) {
    if (error instanceof HubSpotOwnershipLookupError) {
      return NextResponse.json(
        {
          error:
            "HubSpot contact ownership could not be verified. Reconnect HubSpot or try again.",
        },
        { status: 503 },
      );
    }
    if (error instanceof NoMatchingRuleError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof NoEligibleRepError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error(error);
    return NextResponse.json(
      { error: "The lead could not be routed. Try again." },
      { status: 500 },
    );
  }
}
