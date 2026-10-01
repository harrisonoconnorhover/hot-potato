import { NextResponse } from "next/server";
import { z } from "zod";
import { repository } from "../../../repository";

const meetingTypeInput = z
  .object({
    id: z.uuid().optional(),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    title: z.string().trim().min(2).max(120),
    description: z.string().trim().max(500),
    durationMinutes: z.number().int().min(15).max(480),
    bufferBeforeMinutes: z.number().int().min(0).max(480).default(0),
    bufferAfterMinutes: z.number().int().min(0).max(480).default(0),
    minimumNoticeMinutes: z.number().int().min(0).max(43200),
    bookingWindowDays: z.number().int().min(1).max(365),
    inviteeLimitScope: z.enum(["none", "email", "domain"]),
    inviteeLimitCount: z.number().int().min(1).max(100).nullable(),
    rescheduleCutoffMinutes: z.number().int().min(0).max(43200).nullable(),
    cancelCutoffMinutes: z.number().int().min(0).max(43200).nullable(),
    conferenceProvider: z.enum([
      "none",
      "google_meet",
      "microsoft_teams",
      "zoom",
    ]),
    zoomJoinUrl: z.url().max(500).nullable().optional(),
    reminderMinutes: z.number().int().min(0).max(43200),
    active: z.boolean(),
    targetType: z.enum(["rep", "pool"]),
    targetId: z.uuid(),
    cohosts: z
      .array(
        z.object({
          repId: z.uuid(),
          requiredForAvailability: z.boolean(),
        }),
      )
      .max(10)
      .optional(),
    cohostGroups: z
      .array(
        z.object({
          poolId: z.uuid(),
          requiredForAvailability: z.boolean(),
          crmOwnerProperty: z
            .string()
            .trim()
            .regex(/^[a-z][a-z0-9_]{0,99}$/, {
              error:
                "Use the lowercase internal HubSpot property name, with letters, numbers, or underscores.",
            })
            .nullable()
            .optional(),
        }),
      )
      .max(5)
      .optional(),
  })
  .superRefine((value, context) => {
    if (
      (value.inviteeLimitScope === "none") !==
      (value.inviteeLimitCount === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["inviteeLimitCount"],
        message:
          value.inviteeLimitScope === "none"
            ? "Unlimited booking policies cannot have a maximum."
            : "Choose the maximum number of active or upcoming bookings.",
      });
    }
    if (
      value.cohosts &&
      new Set(value.cohosts.map((cohost) => cohost.repId)).size !==
        value.cohosts.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["cohosts"],
        message: "Choose each co-host only once.",
      });
    }
    if (
      value.targetType === "rep" &&
      value.cohosts?.some((cohost) => cohost.repId === value.targetId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["cohosts"],
        message: "The organizer cannot also be a co-host.",
      });
    }
    if (
      value.cohostGroups &&
      new Set(value.cohostGroups.map((group) => group.poolId)).size !==
        value.cohostGroups.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["cohostGroups"],
        message: "Choose each co-host pool only once.",
      });
    }
    if (
      value.targetType === "pool" &&
      value.cohostGroups?.some((group) => group.poolId === value.targetId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["cohostGroups"],
        message: "The organizer pool cannot also be a co-host pool.",
      });
    }
    const crmOwnerProperties = (value.cohostGroups ?? []).flatMap((group) =>
      group.crmOwnerProperty ? [group.crmOwnerProperty] : [],
    );
    if (crmOwnerProperties.includes("hubspot_owner_id")) {
      context.addIssue({
        code: "custom",
        path: ["cohostGroups"],
        message:
          "The primary HubSpot owner field is reserved for the routed organizer.",
      });
    }
    if (new Set(crmOwnerProperties).size !== crmOwnerProperties.length) {
      context.addIssue({
        code: "custom",
        path: ["cohostGroups"],
        message: "Map each HubSpot owner property to only one co-host role.",
      });
    }
    if (value.conferenceProvider !== "zoom") return;
    if (!value.zoomJoinUrl) {
      context.addIssue({
        code: "custom",
        path: ["zoomJoinUrl"],
        message: "Add the Zoom room link.",
      });
      return;
    }
    const hostname = new URL(value.zoomJoinUrl).hostname.toLowerCase();
    if (hostname !== "zoom.us" && !hostname.endsWith(".zoom.us")) {
      context.addIssue({
        code: "custom",
        path: ["zoomJoinUrl"],
        message: "Use a zoom.us meeting link.",
      });
    }
  });

export async function PUT(request: Request) {
  const parsed = meetingTypeInput.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Check the meeting type." },
      { status: 400 },
    );
  }
  try {
    const id = await repository.saveMeetingType({
      organizationSlug: process.env.HOT_POTATO_ORG ?? "acme",
      ...parsed.data,
      zoomJoinUrl:
        parsed.data.conferenceProvider === "zoom"
          ? parsed.data.zoomJoinUrl
          : null,
    });
    return NextResponse.json({ id });
  } catch (error) {
    const conflict =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505";
    return NextResponse.json(
      {
        error: conflict
          ? "That scheduling-link slug is already in use."
          : error instanceof Error
            ? error.message
            : "The meeting type could not be saved.",
      },
      { status: conflict ? 409 : 500 },
    );
  }
}
