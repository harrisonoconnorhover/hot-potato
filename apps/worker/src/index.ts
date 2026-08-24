import { setTimeout as delay } from "node:timers/promises";
import { HotPotatoRepository, type Job } from "@hot-potato/db";
import {
  DevelopmentCrmAdapter,
  type CrmAdapter,
} from "@hot-potato/integrations";

const repository = new HotPotatoRepository();
const pollMs = Number(process.env.WORKER_POLL_MS ?? 1_000);
let stopping = false;
const crmAdapters = new Map<string, CrmAdapter>([
  ["development", new DevelopmentCrmAdapter()],
]);

async function handle(job: Job): Promise<void> {
  if (job.type !== "crm.owner.writeback") {
    throw new Error(`Unsupported job type: ${job.type}`);
  }

  const adapter = String(job.payload.adapter ?? "development");
  const crm = crmAdapters.get(adapter);
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
      await handle(job);
      await repository.completeJob(job.id);
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
