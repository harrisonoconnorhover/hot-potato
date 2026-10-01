import type { Job } from "@hot-potato/db";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function meetingTime(payload: Record<string, unknown>): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: String(payload.timezone ?? "UTC"),
    timeZoneName: "short",
  }).format(new Date(String(payload.startsAt)));
}

export function bookingEmail(job: Job) {
  const kind = job.type.replace("email.booking.", "");
  const title = String(job.payload.meetingTitle);
  const repName = String(job.payload.repName);
  const when = meetingTime(job.payload);
  const appUrl = (process.env.APP_URL ?? "http://localhost:3000").replace(
    /\/$/,
    "",
  );
  const managePath =
    typeof job.payload.managePath === "string" &&
    /^\/schedule\/manage\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      job.payload.managePath,
    )
      ? job.payload.managePath
      : null;
  const manageUrl = managePath ? `${appUrl}${managePath}` : null;
  const conferenceUrl = job.payload.conferenceUrl
    ? String(job.payload.conferenceUrl)
    : null;
  const subject =
    kind === "cancelled"
      ? `Cancelled: ${title}`
      : kind === "rescheduled"
        ? `Rescheduled: ${title}`
        : kind === "reminder"
          ? `Reminder: ${title}`
          : `Confirmed: ${title}`;
  const statusLine =
    kind === "cancelled"
      ? `Your meeting with ${repName} has been cancelled.`
      : kind === "rescheduled"
        ? `Your meeting with ${repName} has been rescheduled to ${when}.`
        : kind === "reminder"
          ? `Your meeting with ${repName} starts ${when}.`
          : `Your meeting with ${repName} is confirmed for ${when}.`;
  const text = [
    `Hi ${String(job.payload.attendeeName)},`,
    "",
    statusLine,
    ...(conferenceUrl && kind !== "cancelled"
      ? ["", `Join: ${conferenceUrl}`]
      : []),
    ...(manageUrl && kind !== "cancelled" ? ["", `Manage: ${manageUrl}`] : []),
    "",
    `Scheduled by ${String(job.payload.organizationName)} with Hot Potato.`,
  ].join("\n");
  const html = `<p>Hi ${escapeHtml(String(job.payload.attendeeName))},</p><p>${escapeHtml(statusLine)}</p>${conferenceUrl && kind !== "cancelled" ? `<p><a href="${escapeHtml(conferenceUrl)}">Join the meeting</a></p>` : ""}${manageUrl && kind !== "cancelled" ? `<p><a href="${escapeHtml(manageUrl)}">Reschedule or cancel</a></p>` : ""}<p><small>Scheduled by ${escapeHtml(String(job.payload.organizationName))} with Hot Potato.</small></p>`;
  return {
    to: String(job.payload.to),
    subject,
    text,
    html,
  };
}
