import {
  RouterLinkConflictError,
  RouterLinkValidationError,
} from "@hot-potato/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { repository } from "../../../repository";

const fieldPath = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(
    /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/,
    "Choose a valid routing field path.",
  )
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
    { message: "Choose a safe routing field path." },
  )
  .refine(
    (value) =>
      value !== "email" &&
      value !== "name" &&
      value !== "attendee_name" &&
      value !== "current_owner_email",
    { message: "That identity field is supplied by the public form." },
  );

const option = z.string().trim().min(1).max(100);

const question = z
  .object({
    field: fieldPath,
    label: z.string().trim().min(1).max(120),
    type: z.enum(["text", "number", "select"]),
    required: z.boolean(),
    placeholder: z.string().trim().max(160),
    helpText: z.string().trim().max(300),
    options: z.array(option).max(50),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.options).size !== value.options.length) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Use each select option only once.",
      });
    }
    if (value.type === "select" && value.options.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Select questions need at least one option.",
      });
    }
    if (value.type !== "select" && value.options.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Only select questions can define options.",
      });
    }
  });

const destination = z
  .object({
    poolId: z.uuid(),
    meetingTypeId: z.uuid(),
  })
  .strict();

const successRedirectUrl = z
  .string()
  .trim()
  .max(2_048)
  .nullable()
  .optional()
  .superRefine((value, context) => {
    if (value === null || value === undefined || value === "") return;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Enter a valid HTTPS post-booking redirect URL.",
      });
      return;
    }
    const hostname = parsed.hostname.toLowerCase();
    const loopback =
      hostname === "localhost" ||
      hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      (parsed.protocol !== "https:" &&
        !(parsed.protocol === "http:" && loopback))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Post-booking redirects must use HTTPS; HTTP is limited to loopback development, and credentials or fragments are not allowed.",
      });
    }
  })
  .transform((value) => (value === "" ? null : value));

const routerLinkInput = z
  .object({
    id: z.uuid().optional(),
    name: z.string().trim().min(2).max(120),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Choose a valid public slug.")
      .max(80),
    title: z.string().trim().min(2).max(160),
    description: z.string().trim().max(1000),
    buttonLabel: z.string().trim().min(2).max(80),
    noMatchMessage: z.string().trim().min(2).max(500),
    successRedirectUrl,
    successRedirectDelaySeconds: z.number().int().min(1).max(30).optional(),
    accentColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Use a six-digit hex accent color."),
    active: z.boolean(),
    questions: z.array(question).max(20),
    destinations: z.array(destination).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const fields = value.questions.map((item) => item.field);
    if (new Set(fields).size !== fields.length) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "Each routing field can be asked only once.",
      });
    }
    for (const field of fields) {
      if (
        fields.some(
          (candidate) =>
            candidate !== field &&
            (candidate.startsWith(`${field}.`) ||
              field.startsWith(`${candidate}.`)),
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["questions"],
          message: "Routing question fields cannot contain one another.",
        });
        break;
      }
    }

    const poolIds = value.destinations.map((item) => item.poolId);
    if (new Set(poolIds).size !== poolIds.length) {
      context.addIssue({
        code: "custom",
        path: ["destinations"],
        message: "Choose one meeting type for each routing pool.",
      });
    }
    if (value.active && value.destinations.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["destinations"],
        message: "Map every reachable pool before publishing.",
      });
    }
  });

function databaseErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
}

export async function PUT(request: Request) {
  const parsed = routerLinkInput.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          parsed.error.issues[0]?.message ??
          "Check the Smart Link configuration.",
      },
      { status: 400 },
    );
  }

  try {
    const id = await repository.saveRouterLink({
      organizationSlug: process.env.HOT_POTATO_ORG ?? "acme",
      ...parsed.data,
    });
    return NextResponse.json({ id });
  } catch (error) {
    const conflict =
      error instanceof RouterLinkConflictError ||
      databaseErrorCode(error) === "23505";
    if (conflict) {
      return NextResponse.json(
        {
          error:
            "That Smart Link slug is already in use or reserved by an existing link.",
        },
        { status: 409 },
      );
    }
    if (error instanceof RouterLinkValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error(
      "Smart Link settings save failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return NextResponse.json(
      { error: "The Smart Link could not be saved. Please try again." },
      { status: 500 },
    );
  }
}
