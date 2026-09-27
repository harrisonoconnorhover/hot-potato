import type {
  HotPotatoRepository,
  Job,
  OwnerWritebackResult,
} from "@hot-potato/db";
import type { CrmAdapter } from "@hot-potato/integrations";

export function writeOwnerJob(
  job: Job,
  repository: Pick<HotPotatoRepository, "applyCurrentOwnerWriteback">,
  crm: CrmAdapter,
): Promise<OwnerWritebackResult> {
  return repository.applyCurrentOwnerWriteback(job.id, () =>
    crm.writeOwner({
      decisionId: String(job.payload.decisionId),
      leadEmail: String(job.payload.leadEmail),
      ownerEmail: String(job.payload.ownerEmail),
    }),
  );
}
