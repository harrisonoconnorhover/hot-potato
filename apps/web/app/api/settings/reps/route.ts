import { NextResponse } from "next/server";
import { z } from "zod";
import { repository } from "../../../repository";

const repInput = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(2).max(120),
  email: z.email().max(320),
  schedulingSlug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80),
  timezone: z.string().trim().min(1).max(100),
  weight: z.number().int().min(1).max(100),
  active: z.boolean(),
});

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
}

export async function PUT(request: Request) {
  const parsed = repInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !validTimezone(parsed.data.timezone)) {
    return NextResponse.json(
      {
        error: parsed.success
          ? "Choose a valid IANA timezone, such as America/New_York."
          : (parsed.error.issues[0]?.message ?? "Check the representative."),
      },
      { status: 400 },
    );
  }

  try {
    const id = await repository.saveRoutingRep({
      organizationSlug: process.env.HOT_POTATO_ORG ?? "acme",
      ...parsed.data,
      email: parsed.data.email.toLowerCase(),
    });
    return NextResponse.json({ id });
  } catch (error) {
    const conflict =
      errorCode(error) === "23505" ||
      (error instanceof Error && error.message.includes("already in use"));
    return NextResponse.json(
      {
        error: conflict
          ? "That representative email or scheduling-link slug is already in use."
          : error instanceof Error
            ? error.message
            : "The representative could not be saved.",
      },
      { status: conflict ? 409 : 500 },
    );
  }
}
