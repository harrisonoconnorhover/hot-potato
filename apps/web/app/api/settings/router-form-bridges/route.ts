import { RouterFormBridgeValidationError } from "@hot-potato/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { repository } from "../../../repository";

const printableSourceField = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^[^\u0000-\u001f\u007f]+$/u,
    "Source fields must contain printable characters only.",
  )
  .refine(
    (value) =>
      value !== "__proto__" && value !== "prototype" && value !== "constructor",
    "Choose a safe source field.",
  );

const routerQuestionField = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/)
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
    "Choose a safe Smart Link question field.",
  );

const exactOrigin = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .transform((value, context) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Enter a valid HTTPS origin.",
      });
      return z.NEVER;
    }
    const hostname = parsed.hostname.toLowerCase();
    const loopback =
      hostname === "localhost" ||
      hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      (parsed.protocol !== "https:" &&
        !(parsed.protocol === "http:" && loopback))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Use an exact HTTPS origin; HTTP is allowed only for loopback development.",
      });
      return z.NEVER;
    }
    return parsed.origin;
  });

const formBridgeInput = z
  .object({
    id: z.uuid().optional(),
    routerLinkId: z.uuid(),
    name: z.string().trim().min(2).max(120),
    provider: z.enum(["hubspot", "manual"]),
    formId: printableSourceField.nullable().optional(),
    allowedOrigins: z.array(exactOrigin).min(1).max(10),
    attendeeNameFields: z.array(printableSourceField).min(1).max(4),
    attendeeEmailField: printableSourceField,
    answerMappings: z.record(routerQuestionField, printableSourceField),
    active: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.provider === "hubspot" && !value.formId) {
      context.addIssue({
        code: "custom",
        path: ["formId"],
        message: "Enter the exact HubSpot form ID.",
      });
    }
    if (value.provider === "manual" && value.formId != null) {
      context.addIssue({
        code: "custom",
        path: ["formId"],
        message: "Manual bridges do not use a HubSpot form ID.",
      });
    }
    if (new Set(value.allowedOrigins).size !== value.allowedOrigins.length) {
      context.addIssue({
        code: "custom",
        path: ["allowedOrigins"],
        message: "Use each allowed origin only once.",
      });
    }
    if (
      new Set(value.attendeeNameFields).size !== value.attendeeNameFields.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["attendeeNameFields"],
        message: "Use each attendee name field only once.",
      });
    }
    if (Object.keys(value.answerMappings).length > 20) {
      context.addIssue({
        code: "custom",
        path: ["answerMappings"],
        message: "A bridge can map at most 20 Smart Link questions.",
      });
    }
  });

function databaseErrorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
}

export async function PUT(request: Request) {
  const parsed = formBridgeInput.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          parsed.error.issues[0]?.message ??
          "Check the existing-form bridge configuration.",
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const id = await repository.saveRouterFormBridge({
      organizationSlug: process.env.HOT_POTATO_ORG ?? "acme",
      ...parsed.data,
      formId: parsed.data.provider === "hubspot" ? parsed.data.formId! : null,
    });
    return NextResponse.json(
      { id },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (databaseErrorCode(error) === "23505") {
      return NextResponse.json(
        { error: "That bridge name is already in use." },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }
    if (error instanceof RouterFormBridgeValidationError) {
      return NextResponse.json(
        { error: error.message },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    console.error(
      "Existing-form bridge save failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return NextResponse.json(
      { error: "The existing-form bridge could not be saved." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
