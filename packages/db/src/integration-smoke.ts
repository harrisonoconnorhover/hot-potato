import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "./client.js";
import { HotPotatoRepository } from "./repository.js";

const sql = createDatabase();
const repository = new HotPotatoRepository(sql);

async function jobForDecision(decisionId: string): Promise<number> {
  const [job] = await sql`
    SELECT id FROM jobs
    WHERE type = 'crm.owner.writeback' AND payload->>'decisionId' = ${decisionId}
  `;
  assert.ok(job, "The routing decision must have a writeback job.");
  return Number(job.id);
}

try {
  const request = {
    organizationSlug: "acme",
    externalId: `smoke-${randomUUID()}`,
    lead: {
      email: "integration-test@example.com",
      company: { employee_count: 900, state: "NY" },
    },
    now: new Date("2026-08-24T16:00:00.000Z"),
  } as const;
  const decision = await repository.route(request);
  const repeated = await repository.route(request);
  const found = await repository.decisionByExternalId(
    request.organizationSlug,
    request.externalId,
  );
  const dashboard = await repository.dashboard("acme");

  if (!dashboard.decisions.some((item) => item.id === decision.id)) {
    throw new Error(
      "Persisted decision was not returned by the dashboard query.",
    );
  }
  if (decision.ruleName !== "Enterprise Northeast") {
    throw new Error(`Unexpected matched rule: ${decision.ruleName}`);
  }
  if (decision.id !== repeated.id) {
    throw new Error("Repeated external ID created more than one decision.");
  }
  if (decision.id !== found?.id) {
    throw new Error("Decision lookup did not return the idempotent result.");
  }
  console.log(
    `Integration smoke passed: ${decision.leadEmail} -> ${decision.repEmail}`,
  );

  const routeOwner = (email: string, ownerEmail: string) =>
    repository.route({
      ...request,
      externalId: `writeback-${randomUUID()}`,
      lead: { ...request.lead, email, current_owner_email: ownerEmail },
    });
  const retryEmail = `retry-${randomUUID()}@example.com`;
  const older = await routeOwner(retryEmail, "ada@acme.example");
  const olderJobId = await jobForDecision(older.id);
  await assert.rejects(
    repository.applyCurrentOwnerWriteback(olderJobId, async () => {
      throw new Error("Synthetic provider failure");
    }),
    /Synthetic provider failure/,
  );
  await repository.failJob(olderJobId, "Synthetic provider failure");

  const newer = await routeOwner(
    retryEmail.toUpperCase(),
    "marcus@acme.example",
  );
  const newerJobId = await jobForDecision(newer.id);
  let crmOwner = "";
  const newestResult = await repository.applyCurrentOwnerWriteback(
    newerJobId,
    async () => {
      crmOwner = newer.repEmail;
      return { externalReference: "synthetic:newer" };
    },
  );
  await repository.completeJob(newerJobId, newestResult, newestResult.status);
  const staleResult = await repository.applyCurrentOwnerWriteback(
    olderJobId,
    async () => {
      crmOwner = older.repEmail;
      throw new Error("An obsolete retry must not call the provider.");
    },
  );
  assert.equal(staleResult.status, "superseded");
  assert.equal(crmOwner, "marcus@acme.example");
  await repository.completeJob(olderJobId, staleResult, staleResult.status);
  const afterRetry = await repository.dashboard("acme");
  assert.equal(
    afterRetry.decisions.find((item) => item.id === older.id)?.writebackStatus,
    "superseded",
  );
  console.log(
    "Owner writeback retry smoke passed: failed old write, newer write, obsolete retry skipped.",
  );

  const concurrentEmail = `concurrent-${randomUUID()}@example.com`;
  const first = await routeOwner(concurrentEmail, "ada@acme.example");
  const firstJobId = await jobForDecision(first.id);
  let releaseFirst!: () => void;
  let firstEntered!: () => void;
  const holdFirst = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const writes: string[] = [];
  const firstWrite = repository.applyCurrentOwnerWriteback(
    firstJobId,
    async () => {
      firstEntered();
      await holdFirst;
      writes.push(first.repEmail);
      return { externalReference: "synthetic:first" };
    },
  );
  await entered;
  let secondWrite: Promise<unknown> | undefined;
  try {
    const second = await routeOwner(concurrentEmail, "marcus@acme.example");
    secondWrite = repository.applyCurrentOwnerWriteback(
      await jobForDecision(second.id),
      async () => {
        writes.push(second.repEmail);
        return { externalReference: "synthetic:second" };
      },
    );
    let waiting = false;
    const deadline = Date.now() + 5_000;
    while (!waiting && Date.now() < deadline) {
      const [row] = await sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks locks
          JOIN pg_stat_activity activity ON activity.pid = locks.pid
          WHERE locks.locktype = 'advisory' AND NOT locks.granted
            AND activity.datname = current_database()
        ) AS waiting
      `;
      waiting = Boolean(row?.waiting);
      if (!waiting) await delay(20);
    }
    assert.equal(
      waiting,
      true,
      "The newer write must wait on the contact lock.",
    );
    assert.deepEqual(
      writes,
      [],
      "The newer provider callback must not overtake the old write.",
    );
  } finally {
    releaseFirst();
    await Promise.all([firstWrite, secondWrite]);
  }
  assert.deepEqual(writes, ["ada@acme.example", "marcus@acme.example"]);
  console.log(
    "Owner writeback concurrency smoke passed: in-flight writes finish in assignment order.",
  );
} finally {
  await repository.close();
}
