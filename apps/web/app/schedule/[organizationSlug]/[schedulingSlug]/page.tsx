import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SchedulingClient } from "../../../../components/scheduling-client";
import { loadPublicSchedule, scheduleView } from "../../../public-scheduling";

export const dynamic = "force-dynamic";

type SchedulingPageProps = {
  params: Promise<{ organizationSlug: string; schedulingSlug: string }>;
  searchParams: Promise<{ time?: string | string[] }>;
};

export async function generateMetadata({
  params,
}: SchedulingPageProps): Promise<Metadata> {
  const { organizationSlug, schedulingSlug } = await params;
  const schedule = await loadPublicSchedule(organizationSlug, schedulingSlug);
  return schedule
    ? {
        title: `Meet with ${schedule.hostName} — Hot Potato`,
        description: schedule.meetingDescription,
      }
    : { title: "Scheduling link not found — Hot Potato" };
}

function suggestedTime(value: string | string[] | undefined): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    return null;
  }
  return value;
}

export default async function SchedulingPage({
  params,
  searchParams,
}: SchedulingPageProps) {
  const { organizationSlug, schedulingSlug } = await params;
  const query = await searchParams;
  const schedule = await loadPublicSchedule(organizationSlug, schedulingSlug);
  if (!schedule) notFound();
  return (
    <SchedulingClient
      schedule={scheduleView(schedule)}
      suggestedTime={suggestedTime(query.time)}
    />
  );
}
