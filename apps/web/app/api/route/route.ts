import { NoEligibleRepError, NoMatchingRuleError } from "@hot-potato/router";
import { NextResponse } from "next/server";
import { z } from "zod";
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
    const decision = await repository.route({
      organizationSlug: process.env.HOT_POTATO_ORG ?? "acme",
      externalId: parsed.data.externalId,
      lead: parsed.data.lead,
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
