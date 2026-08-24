import { NoEligibleRepError, NoMatchingRuleError } from "@hot-potato/router";
import { GoogleCalendarAdapter } from "@hot-potato/integrations";
import { NextResponse } from "next/server";
import { z } from "zod";
import { connectionManager } from "../../connections";
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

    const now = new Date();
    let unavailableRepEmails: string[] = [];
    let availabilitySource: "weekly_schedule" | "google_calendar" =
      "weekly_schedule";
    const googleConnection = await repository.getOAuthConnection(
      organizationSlug,
      "google",
    );
    if (googleConnection) {
      const candidates = await repository.routeCandidates({
        organizationSlug,
        lead: parsed.data.lead,
        now,
      });
      const calendar = new GoogleCalendarAdapter(() =>
        connectionManager().accessToken(organizationSlug, "google"),
      );
      try {
        unavailableRepEmails = await calendar.busyRepEmails({
          repEmails: candidates,
          startsAt: now,
          endsAt: new Date(now.getTime() + 30 * 60_000),
        });
        availabilitySource = "google_calendar";
      } catch (error) {
        console.error(
          "Google Calendar availability failed:",
          error instanceof Error ? error.message : "Unknown error",
        );
        return NextResponse.json(
          { error: "Google Calendar availability could not be verified." },
          { status: 503 },
        );
      }
    }

    const decision = await repository.route({
      organizationSlug,
      externalId: parsed.data.externalId,
      lead: parsed.data.lead,
      now,
      unavailableRepEmails,
      availabilitySource,
    });
    return NextResponse.json(decision, { status: 201 });
  } catch (error) {
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
