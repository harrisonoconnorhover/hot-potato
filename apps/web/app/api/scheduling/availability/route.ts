import { z } from "zod";
import {
  cachedAvailablePublicSlots,
  loadPublicSchedule,
} from "../../../public-scheduling";
import {
  enforcePublicRateLimits,
  publicClientAddress,
  publicError,
  publicJson,
} from "../../../public-api";
import { repository } from "../../../repository";

const availabilityRequest = z.object({
  organization: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80),
  rep: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(80),
});

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = availabilityRequest.safeParse({
    organization: url.searchParams.get("organization"),
    rep: url.searchParams.get("rep"),
  });
  if (!parsed.success) {
    return publicError(404, "Scheduling link not found.", "not_found");
  }

  const schedule = await loadPublicSchedule(
    parsed.data.organization,
    parsed.data.rep,
  );
  if (!schedule) {
    return publicError(404, "Scheduling link not found.", "not_found");
  }

  try {
    const limited = await enforcePublicRateLimits(
      repository,
      schedule.organizationSlug,
      [
        {
          scope: "scheduling_availability_ip_link",
          identifier: `${publicClientAddress(request)}:${schedule.schedulingSlug}`,
          limit: 90,
          windowSeconds: 10 * 60,
        },
      ],
    );
    if (limited) return limited;
    const slots = await cachedAvailablePublicSlots(schedule);
    return publicJson({ slots });
  } catch (error) {
    console.error(
      "Public calendar availability failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return publicError(
      503,
      "Available times could not be loaded. Please try again.",
      "service_unavailable",
    );
  }
}
