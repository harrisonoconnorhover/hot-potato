import { NextResponse } from "next/server";
import { z } from "zod";
import { repository } from "../../../repository";

const primitive = z.union([z.string().max(500), z.number(), z.boolean()]);
const listValue = z.union([z.string().max(500), z.number()]);
const predicate = z.union([
  z.object({ eq: primitive }).strict(),
  z.object({ in: z.array(listValue).min(1).max(50) }).strict(),
  z.object({ gte: z.number() }).strict(),
  z.object({ lte: z.number() }).strict(),
  z.object({ contains: z.string().max(500) }).strict(),
  z.object({ exists: z.boolean() }).strict(),
]);
const fieldPath = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/)
  .max(160)
  .refine(
    (value) =>
      value
        .split(".")
        .every(
          (part) =>
            part !== "__proto__" &&
            part !== "prototype" &&
            part !== "constructor",
        ),
    { message: "Choose a safe CRM field path." },
  );
const conditions = z
  .record(fieldPath, predicate)
  .refine((value) => Object.keys(value).length <= 20, {
    message: "A rule can contain at most 20 conditions.",
  });
const ruleInput = z
  .object({
    id: z.uuid().optional(),
    name: z.string().trim().min(2).max(120),
    priority: z.number().int().min(1).max(10000),
    conditions,
    catchAll: z.boolean().optional().default(false),
    poolId: z.uuid(),
    active: z.boolean(),
  })
  .superRefine((value, context) => {
    const conditionCount = Object.keys(value.conditions).length;
    if (value.catchAll && conditionCount > 0) {
      context.addIssue({
        code: "custom",
        path: ["conditions"],
        message: "A catch-all cannot contain conditions.",
      });
    }
    if (!value.catchAll && conditionCount === 0) {
      context.addIssue({
        code: "custom",
        path: ["conditions"],
        message: "Add at least one condition or choose catch-all.",
      });
    }
  });

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
}

function errorConstraint(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  if ("constraint_name" in error) return String(error.constraint_name);
  if ("constraint" in error) return String(error.constraint);
  return null;
}

export async function PUT(request: Request) {
  const parsed = ruleInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the routing rule." },
      { status: 400 },
    );
  }

  try {
    const { catchAll, ...rule } = parsed.data;
    const id = await repository.saveRoutingRule({
      organizationSlug: process.env.HOT_POTATO_ORG ?? "acme",
      ...rule,
      conditions: catchAll ? {} : rule.conditions,
    });
    return NextResponse.json({ id });
  } catch (error) {
    const conflict = errorCode(error) === "23505";
    const catchAllConflict =
      conflict && errorConstraint(error) === "routing_rules_one_catch_all_idx";
    return NextResponse.json(
      {
        error: catchAllConflict
          ? "This workspace already has a catch-all rule. Edit that rule instead."
          : conflict
            ? "Each routing rule needs a unique priority."
            : error instanceof Error
              ? error.message
              : "The routing rule could not be saved.",
      },
      { status: conflict ? 409 : 500 },
    );
  }
}
