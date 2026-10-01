import { NextResponse } from "next/server";
import { z } from "zod";
import { repository } from "../../../repository";

const previewInput = z.object({
  lead: z
    .object({
      email: z.email(),
      current_owner_email: z.email().optional(),
    })
    .loose(),
  evaluatedAt: z.iso.datetime().optional(),
});

export async function POST(request: Request) {
  const parsed = previewInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Enter a valid lead email, fields, and preview time." },
      { status: 400 },
    );
  }

  try {
    const preview = await repository.routingPreview({
      organizationSlug: process.env.HOT_POTATO_ORG ?? "acme",
      lead: parsed.data.lead,
      evaluatedAt: parsed.data.evaluatedAt
        ? new Date(parsed.data.evaluatedAt)
        : undefined,
    });
    return NextResponse.json(preview, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error(
      "Routing preview failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return NextResponse.json(
      { error: "The route preview could not be evaluated." },
      { status: 500 },
    );
  }
}
