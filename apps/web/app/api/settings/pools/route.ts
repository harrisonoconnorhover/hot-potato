import { NextResponse } from "next/server";
import { z } from "zod";
import { repository } from "../../../repository";

const poolInput = z
  .object({
    id: z.uuid().optional(),
    name: z.string().trim().min(2).max(120),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    memberIds: z.array(z.uuid()).min(1).max(200),
  })
  .refine((value) => new Set(value.memberIds).size === value.memberIds.length, {
    path: ["memberIds"],
    message: "Choose each representative only once.",
  });

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
}

export async function PUT(request: Request) {
  const parsed = poolInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the routing pool." },
      { status: 400 },
    );
  }

  try {
    const id = await repository.saveRoutingPool({
      organizationSlug: process.env.HOT_POTATO_ORG ?? "acme",
      ...parsed.data,
    });
    return NextResponse.json({ id });
  } catch (error) {
    const conflict = errorCode(error) === "23505";
    return NextResponse.json(
      {
        error: conflict
          ? "That pool slug is already in use."
          : error instanceof Error
            ? error.message
            : "The routing pool could not be saved.",
      },
      { status: conflict ? 409 : 500 },
    );
  }
}
