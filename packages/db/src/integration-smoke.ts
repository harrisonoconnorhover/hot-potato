import { randomUUID } from "node:crypto";
import { HotPotatoRepository } from "./repository.js";

const repository = new HotPotatoRepository();

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
} finally {
  await repository.close();
}
