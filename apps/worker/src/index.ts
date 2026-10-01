import { setTimeout as delay } from "node:timers/promises";
import { HotPotatoRepository, type Job } from "@hot-potato/db";
import {
  createConnectionTokenManager,
  createRepCalendarTokenManager,
  DevelopmentCrmAdapter,
  DevelopmentEmailAdapter,
  GoogleRepCalendarAdapter,
  HubSpotCrmAdapter,
  MicrosoftRepCalendarAdapter,
  SmtpEmailAdapter,
  type ConnectionTokenManager,
  type CrmAdapter,
  type CrmRoleOwner,
  type CalendarEventInput,
  type EmailAdapter,
  type RepCalendarTokenManager,
} from "@hot-potato/integrations";
import {
  bookingEmailShouldSend,
  calendarMutationShouldRun,
  reconciliationNeedsFinalization,
  requiredCalendarExternalAccountId,
} from "./calendar-job.js";
import { bookingEmail } from "./booking-email.js";
import { writeOwnerJob } from "./owner-writeback.js";

const repository = new HotPotatoRepository();
const pollMs = Number(process.env.WORKER_POLL_MS ?? 1_000);
const publicCleanupIntervalMs = 60 * 60_000;
const configuredJobOperationDeadlineMs = Number(
  process.env.WORKER_OPERATION_TIMEOUT_MS ?? 120_000,
);
const jobOperationDeadlineMs = Math.max(
  30_000,
  Math.min(
    Number.isFinite(configuredJobOperationDeadlineMs)
      ? configuredJobOperationDeadlineMs
      : 120_000,
    240_000,
  ),
);
let stopping = false;
let nextPublicCleanupAt = 0;
let tokenManager: ConnectionTokenManager | undefined;
let repTokenManager: RepCalendarTokenManager | undefined;
let configuredEmailAdapter: EmailAdapter | undefined;

function manager(): ConnectionTokenManager {
  return (tokenManager ??= createConnectionTokenManager(repository));
}

function repManager(): RepCalendarTokenManager {
  return (repTokenManager ??= createRepCalendarTokenManager(repository));
}

function crmAdapter(job: Job): CrmAdapter | undefined {
  const adapter = String(job.payload.adapter ?? "development");
  if (adapter === "development") return new DevelopmentCrmAdapter();
  if (adapter === "hubspot") {
    return new HubSpotCrmAdapter(() =>
      manager().accessToken(String(job.payload.organizationSlug), "hubspot"),
    );
  }
  return undefined;
}

function emailAdapter(): EmailAdapter {
  if (configuredEmailAdapter) return configuredEmailAdapter;
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM;
  if (!host || !from) {
    return (configuredEmailAdapter = new DevelopmentEmailAdapter());
  }
  return (configuredEmailAdapter = new SmtpEmailAdapter({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
    from,
    operationTimeoutMs: Math.max(1_000, jobOperationDeadlineMs - 1_000),
  }));
}

function additionalAttendeeEmails(
  payload: Record<string, unknown>,
): string[] | undefined {
  const value = payload.additionalAttendeeEmails;
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 5 ||
    value.some((email) => typeof email !== "string")
  ) {
    throw new Error("Calendar job additional attendee data is invalid.");
  }
  return value as string[];
}

function cohostEmails(payload: Record<string, unknown>): string[] | undefined {
  const value = payload.cohostEmails;
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 10 ||
    value.some((email) => typeof email !== "string")
  ) {
    throw new Error("Calendar job co-host data is invalid.");
  }
  return value as string[];
}

function crmRoleOwners(payload: Record<string, unknown>): CrmRoleOwner[] {
  const value = payload.roleOwners;
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    throw new Error("CRM role writeback data is invalid.");
  }
  const properties = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("CRM role writeback data is invalid.");
    }
    const role = item as Record<string, unknown>;
    if (
      typeof role.propertyName !== "string" ||
      !/^[a-z][a-z0-9_]{0,99}$/.test(role.propertyName) ||
      role.propertyName === "hubspot_owner_id" ||
      typeof role.ownerEmail !== "string" ||
      properties.has(role.propertyName)
    ) {
      throw new Error("CRM role writeback data is invalid.");
    }
    properties.add(role.propertyName);
    return {
      propertyName: role.propertyName,
      ownerEmail: role.ownerEmail,
    };
  });
}

function calendarEventInput(job: Job, signal: AbortSignal): CalendarEventInput {
  return {
    subject: String(job.payload.subject),
    startsAt: new Date(String(job.payload.startsAt)),
    endsAt: new Date(String(job.payload.endsAt)),
    attendeeEmail: job.payload.attendeeEmail
      ? String(job.payload.attendeeEmail)
      : undefined,
    attendeeName: job.payload.attendeeName
      ? String(job.payload.attendeeName)
      : undefined,
    additionalAttendeeEmails: additionalAttendeeEmails(job.payload),
    cohostEmails: cohostEmails(job.payload),
    description: job.payload.description
      ? String(job.payload.description)
      : undefined,
    transactionId: String(job.payload.externalId),
    conferenceProvider: job.payload.conferenceProvider
      ? (String(
          job.payload.conferenceProvider,
        ) as CalendarEventInput["conferenceProvider"])
      : undefined,
    conferenceUrl: job.payload.conferenceUrl
      ? String(job.payload.conferenceUrl)
      : undefined,
    signal,
  };
}

async function handle(
  job: Job,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  if (job.type === "calendar.event.create.reconcile") {
    const provider = String(job.payload.provider);
    if (provider !== "google" && provider !== "microsoft") {
      throw new Error(`Calendar adapter is not configured: ${provider}`);
    }
    const organizationSlug = String(job.payload.organizationSlug);
    const repId = String(job.payload.repId);
    const expectedAccountId = requiredCalendarExternalAccountId(job.payload);
    const getAccessToken = () =>
      repManager().accessToken(
        organizationSlug,
        repId,
        provider,
        expectedAccountId,
      );
    const calendar =
      provider === "google"
        ? new GoogleRepCalendarAdapter(getAccessToken)
        : new MicrosoftRepCalendarAdapter(getAccessToken);
    const startsAt = new Date(String(job.payload.startsAt));
    const endsAt = new Date(String(job.payload.endsAt));
    const shouldFinalize = reconciliationNeedsFinalization(
      job.payload.reconciliationIntent,
      endsAt,
    );
    const event = await calendar.findEventByTransactionId({
      transactionId: String(job.payload.externalId),
      startsAt,
      endsAt,
      signal,
    });
    if (!event) return { found: false };
    if (!shouldFinalize) {
      return { found: true, ...event };
    }

    const finalized = await calendar.createEvent(
      calendarEventInput(job, signal),
    );
    if (finalized.externalEventId !== event.externalEventId) {
      throw new Error(
        "Calendar reconciliation finalized a different provider event.",
      );
    }
    const conferenceProvider = String(job.payload.conferenceProvider ?? "none");
    if (
      (conferenceProvider === "google_meet" ||
        conferenceProvider === "microsoft_teams") &&
      !finalized.conferenceUrl
    ) {
      throw new Error(
        "Calendar reconciliation did not finalize the required native conference.",
      );
    }
    return { found: true, ...finalized };
  }
  if (job.type === "calendar.event.create") {
    const provider = String(job.payload.provider);
    if (provider !== "google" && provider !== "microsoft") {
      throw new Error(
        `Calendar adapter is not configured: ${String(job.payload.provider)}`,
      );
    }
    const organizationSlug = String(job.payload.organizationSlug);
    const repId = String(job.payload.repId);
    if (!calendarMutationShouldRun(job.payload)) {
      throw new Error(
        "The meeting window ended before calendar creation completed; provider reconciliation is required.",
      );
    }
    const expectedAccountId = requiredCalendarExternalAccountId(job.payload);
    const getAccessToken = () =>
      repManager().accessToken(
        organizationSlug,
        repId,
        provider,
        expectedAccountId,
      );
    const calendar =
      provider === "google"
        ? new GoogleRepCalendarAdapter(getAccessToken)
        : new MicrosoftRepCalendarAdapter(getAccessToken);
    const result = await calendar.createEvent(calendarEventInput(job, signal));
    console.log(
      JSON.stringify({
        event: "calendar.event.create.completed",
        jobId: job.id,
        provider,
        repId,
        externalEventId: result.externalEventId,
      }),
    );
    return result;
  }

  if (
    job.type === "calendar.event.update" ||
    job.type === "calendar.event.cancel"
  ) {
    const provider = String(job.payload.provider);
    if (provider !== "google" && provider !== "microsoft") {
      throw new Error(`Calendar adapter is not configured: ${provider}`);
    }
    const organizationSlug = String(job.payload.organizationSlug);
    const repId = String(job.payload.repId);
    const expectedAccountId = requiredCalendarExternalAccountId(job.payload);
    const getAccessToken = () =>
      repManager().accessToken(
        organizationSlug,
        repId,
        provider,
        expectedAccountId,
      );
    const calendar =
      provider === "google"
        ? new GoogleRepCalendarAdapter(getAccessToken)
        : new MicrosoftRepCalendarAdapter(getAccessToken);
    const externalEventId = String(job.payload.externalEventId);
    if (job.type === "calendar.event.cancel") {
      await calendar.cancelEvent(externalEventId, signal);
      return { externalEventId };
    }
    if (!calendarMutationShouldRun(job.payload)) {
      throw new Error(
        "The requested meeting window ended before the calendar update completed.",
      );
    }
    return calendar.updateEvent(externalEventId, {
      subject: String(job.payload.subject),
      startsAt: new Date(String(job.payload.startsAt)),
      endsAt: new Date(String(job.payload.endsAt)),
      attendeeEmail: String(job.payload.attendeeEmail),
      attendeeName: String(job.payload.attendeeName),
      additionalAttendeeEmails: additionalAttendeeEmails(job.payload),
      cohostEmails: cohostEmails(job.payload),
      description: String(job.payload.description ?? ""),
      transactionId: String(job.payload.externalId),
      conferenceProvider: String(job.payload.conferenceProvider) as
        | "none"
        | "google_meet"
        | "microsoft_teams"
        | "zoom",
      conferenceUrl: job.payload.conferenceUrl
        ? String(job.payload.conferenceUrl)
        : undefined,
      signal,
    });
  }

  if (job.type.startsWith("email.booking.")) {
    signal.throwIfAborted();
    if (!bookingEmailShouldSend(job.type, job.payload)) {
      return { skipped: true, reason: "meeting_window_ended" };
    }
    const result = await emailAdapter().send(bookingEmail(job), signal);
    console.log(
      JSON.stringify({
        event: `${job.type}.completed`,
        jobId: job.id,
        adapter: emailAdapter().key,
      }),
    );
    return result;
  }

  if (
    job.type !== "crm.owner.writeback" &&
    job.type !== "crm.roles.writeback"
  ) {
    throw new Error(`Unsupported job type: ${job.type}`);
  }

  const adapter = String(job.payload.adapter ?? "development");
  const crm = crmAdapter(job);
  if (!crm) {
    throw new Error(`CRM adapter is not configured: ${adapter}`);
  }

  signal.throwIfAborted();
  if (job.type === "crm.roles.writeback") {
    const roleOwners = crmRoleOwners(job.payload);
    const result = await crm.writeRoles({
      bookingId: String(job.payload.bookingId),
      leadEmail: String(job.payload.leadEmail),
      roleOwners,
      signal,
    });
    console.log(
      JSON.stringify({
        event: "crm.roles.writeback.completed",
        jobId: job.id,
        adapter,
        leadEmail: job.payload.leadEmail,
        properties: roleOwners.map((role) => role.propertyName),
        externalReference: result.externalReference,
      }),
    );
    return { externalReference: result.externalReference };
  }
  const result = await writeOwnerJob(job, repository, crm, signal);

  console.log(
    JSON.stringify({
      event: `crm.owner.writeback.${result.status}`,
      jobId: job.id,
      adapter,
      leadEmail: job.payload.leadEmail,
      ownerEmail: job.payload.ownerEmail,
      ...(result.status === "completed"
        ? { externalReference: result.externalReference }
        : {}),
    }),
  );
  return result;
}

async function handleWithDeadline(job: Job): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      handle(job, controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(
            new Error(
              `Job operation exceeded ${jobOperationDeadlineMs}ms deadline.`,
            ),
          );
        }, jobOperationDeadlineMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function run(): Promise<void> {
  console.log("Hot Potato worker ready");
  while (!stopping) {
    const now = Date.now();
    if (now >= nextPublicCleanupAt) {
      nextPublicCleanupAt = now + publicCleanupIntervalMs;
      try {
        const cleaned = await repository.cleanupExpiredPublicRouterData(
          new Date(now),
        );
        if (
          cleaned.deletedSessions > 0 ||
          cleaned.redactedSessions > 0 ||
          cleaned.deletedRateBuckets > 0 ||
          cleaned.deletedRepOAuthAttempts > 0
        ) {
          console.log(
            JSON.stringify({ event: "public_router.cleanup", ...cleaned }),
          );
        }
      } catch (error) {
        nextPublicCleanupAt = now + 60_000;
        console.error(
          JSON.stringify({
            event: "public_router.cleanup.failed",
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      }
    }
    let job: Job | null;
    try {
      job = await repository.claimJob();
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "job.claim.failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      await delay(pollMs);
      continue;
    }
    if (!job) {
      await delay(pollMs);
      continue;
    }

    try {
      const result = await handleWithDeadline(job);
      const completed = await repository.completeJob(
        job.id,
        job.claimToken,
        result,
      );
      if (!completed) {
        console.warn(
          JSON.stringify({ event: "job.completion.stale", jobId: job.id }),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({ event: "job.failed", jobId: job.id, message }),
      );
      try {
        const failed = await repository.failJob(
          job.id,
          job.claimToken,
          message,
        );
        if (!failed) {
          console.warn(
            JSON.stringify({ event: "job.failure.stale", jobId: job.id }),
          );
        }
      } catch (recordError) {
        console.error(
          JSON.stringify({
            event: "job.failure.record.failed",
            jobId: job.id,
            message:
              recordError instanceof Error
                ? recordError.message
                : String(recordError),
          }),
        );
        await delay(pollMs);
      }
    }
  }
}

function stop(): void {
  stopping = true;
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

try {
  await run();
} finally {
  await repository.close();
}
