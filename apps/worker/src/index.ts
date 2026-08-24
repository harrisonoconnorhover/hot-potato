import { setTimeout as delay } from "node:timers/promises";
import { HotPotatoRepository, type Job } from "@hot-potato/db";
import {
  createConnectionTokenManager,
  DevelopmentCrmAdapter,
  HubSpotCrmAdapter,
  type ConnectionTokenManager,
  type CrmAdapter,
  type CrmWritebackResult,
} from "@hot-potato/integrations";

const repository = new HotPotatoRepository();
const pollMs = Number(process.env.WORKER_POLL_MS ?? 1_000);
let stopping = false;
let tokenManager: ConnectionTokenManager | undefined;

function manager(): ConnectionTokenManager {
  return (tokenManager ??= createConnectionTokenManager(repository));
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

async function handle(job: Job): Promise<CrmWritebackResult> {
  if (job.type !== "crm.owner.writeback") {
    throw new Error(`Unsupported job type: ${job.type}`);
  }

  const adapter = String(job.payload.adapter ?? "development");
  const crm = crmAdapter(job);
  if (!crm) {
    throw new Error(`CRM adapter is not configured: ${adapter}`);
  }

  const result = await crm.writeOwner({
    decisionId: String(job.payload.decisionId),
    leadEmail: String(job.payload.leadEmail),
    ownerEmail: String(job.payload.ownerEmail),
  });

  console.log(
    JSON.stringify({
      event: "crm.owner.writeback.completed",
      jobId: job.id,
      adapter,
      leadEmail: job.payload.leadEmail,
      ownerEmail: job.payload.ownerEmail,
      externalReference: result.externalReference,
    }),
  );
  return result;
}

async function run(): Promise<void> {
  console.log("Hot Potato worker ready");
  while (!stopping) {
    const job = await repository.claimJob();
    if (!job) {
      await delay(pollMs);
      continue;
    }

    try {
      const result = await handle(job);
      await repository.completeJob(job.id, {
        externalReference: result.externalReference,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({ event: "job.failed", jobId: job.id, message }),
      );
      await repository.failJob(job.id, message);
    }
  }
}

async function stop(): Promise<void> {
  stopping = true;
  await repository.close();
}

process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

await run();
