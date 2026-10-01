import type {
  HotPotatoRepository,
  Job,
  OwnerWritebackResult,
} from "@hot-potato/db";
import type { CrmAdapter } from "@hot-potato/integrations";

export function writeOwnerJob(
  job: Job,
  repository: Pick<HotPotatoRepository, "applyCurrentOwnerWriteback">,
  crm: Pick<CrmAdapter, "writeOwner">,
  signal: AbortSignal,
): Promise<OwnerWritebackResult> {
  return repository.applyCurrentOwnerWriteback(job.id, job.claimToken, () => {
    // A deadline can expire while this job waits for another contact write.
    signal.throwIfAborted();
    return crm.writeOwner({
      decisionId: String(job.payload.decisionId),
      leadEmail: String(job.payload.leadEmail),
      ownerEmail: String(job.payload.ownerEmail),
      signal,
    });
  });
}
