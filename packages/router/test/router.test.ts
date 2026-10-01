import { describe, expect, it } from "vitest";
import {
  NoEligibleRepError,
  NoMatchingRuleError,
  pickWeightedRep,
  previewRoute,
  routeLead,
  routeMatchedRule,
  ruleMatches,
  withoutBusyIntervals,
  type Rep,
  type RoutingContext,
  type Rule,
} from "../src/index.js";

const alwaysOpen = {
  monday: [{ start: "00:00", end: "23:59" }],
};

const reps: Rep[] = [
  {
    id: "ada",
    name: "Ada Chen",
    email: "ada@example.com",
    timezone: "UTC",
    weight: 2,
    active: true,
    availability: alwaysOpen,
  },
  {
    id: "marcus",
    name: "Marcus Reed",
    email: "marcus@example.com",
    timezone: "UTC",
    weight: 1,
    active: true,
    availability: alwaysOpen,
  },
];

const enterpriseRule: Rule = {
  id: "enterprise",
  name: "Enterprise Northeast",
  priority: 10,
  poolId: "enterprise-ne",
  conditions: {
    "company.employee_count": { gte: 500 },
    "company.state": { in: ["NY", "NJ", "PA", "MA"] },
  },
};

const context: RoutingContext = {
  rules: [enterpriseRule],
  pools: { "enterprise-ne": reps },
  assignmentState: {
    "enterprise-ne": [
      { repId: "ada", assignments: 2, lastAssignedAt: null },
      { repId: "marcus", assignments: 2, lastAssignedAt: null },
    ],
  },
};

const monday = new Date("2026-08-24T12:00:00.000Z");

describe("rule matching", () => {
  it("matches nested CRM-style fields and operators", () => {
    expect(
      ruleMatches(
        {
          email: "buyer@example.com",
          company: { employee_count: 900, state: "NY" },
        },
        enterpriseRule,
      ),
    ).toBe(true);
  });

  it("rejects a lead outside the rule", () => {
    expect(
      ruleMatches(
        {
          email: "buyer@example.com",
          company: { employee_count: 50, state: "NY" },
        },
        enterpriseRule,
      ),
    ).toBe(false);
  });

  it("previews every condition and every predicate operator", () => {
    const lead = {
      email: "buyer@example.com",
      qualified: true,
      company: {
        segment: "enterprise",
        employee_count: 900,
        annual_revenue: 1_000_000,
        name: "Acme Industries",
        phone: "+1-212-555-0199",
      },
    };
    const operatorRule: Rule = {
      id: "all-operators",
      name: "All operators",
      priority: 20,
      poolId: "enterprise-ne",
      conditions: {
        qualified: { eq: true },
        "company.segment": { in: ["enterprise", "mid-market"] },
        "company.employee_count": { gte: 500 },
        "company.annual_revenue": { lte: 2_000_000 },
        "company.name": { contains: "ACME" },
        "company.phone": { exists: true },
        "company.fax": { exists: false },
      },
    };
    const rejectedRule: Rule = {
      id: "rejected",
      name: "Rejected first rule",
      priority: 10,
      poolId: "enterprise-ne",
      conditions: { "company.segment": { eq: "startup" } },
    };
    const fallbackRule: Rule = {
      id: "fallback",
      name: "Fallback",
      priority: 30,
      poolId: "enterprise-ne",
      conditions: {},
    };

    const preview = previewRoute(
      lead,
      {
        ...context,
        rules: [fallbackRule, operatorRule, rejectedRule],
      },
      monday,
    );

    expect(preview.rules.map((rule) => [rule.id, rule.matched])).toEqual([
      ["rejected", false],
      ["all-operators", true],
      ["fallback", true],
    ]);
    expect(preview.selectedRule?.id).toBe("all-operators");
    expect(preview.rules[1]?.conditions).toEqual([
      {
        field: "qualified",
        operator: "eq",
        expected: true,
        actual: true,
        matched: true,
      },
      {
        field: "company.segment",
        operator: "in",
        expected: ["enterprise", "mid-market"],
        actual: "enterprise",
        matched: true,
      },
      {
        field: "company.employee_count",
        operator: "gte",
        expected: 500,
        actual: 900,
        matched: true,
      },
      {
        field: "company.annual_revenue",
        operator: "lte",
        expected: 2_000_000,
        actual: 1_000_000,
        matched: true,
      },
      {
        field: "company.name",
        operator: "contains",
        expected: "ACME",
        actual: "Acme Industries",
        matched: true,
      },
      {
        field: "company.phone",
        operator: "exists",
        expected: true,
        actual: "+1-212-555-0199",
        matched: true,
      },
      {
        field: "company.fax",
        operator: "exists",
        expected: false,
        actual: null,
        matched: true,
      },
    ]);
    expect(JSON.parse(JSON.stringify(preview))).toEqual(preview);
  });
});

describe("routing", () => {
  it("evaluates the catch-all after every conditional rule", () => {
    const catchAll: Rule = {
      id: "catch-all",
      name: "Every other qualified lead",
      priority: 1,
      poolId: "enterprise-ne",
      conditions: {},
    };
    const rules = [catchAll, enterpriseRule];
    const specificLead = {
      email: "buyer@example.com",
      company: { employee_count: 900, state: "NY" },
    };
    const fallbackLead = {
      email: "buyer@example.com",
      company: { employee_count: 20, state: "VT" },
    };

    expect(routeLead(specificLead, { ...context, rules }, monday).rule.id).toBe(
      "enterprise",
    );
    expect(routeLead(fallbackLead, { ...context, rules }, monday).rule.id).toBe(
      "catch-all",
    );
    expect(
      previewRoute(specificLead, { ...context, rules }, monday).rules.map(
        (rule) => rule.id,
      ),
    ).toEqual(["enterprise", "catch-all"]);
  });

  it("chooses the least-served weighted rep", () => {
    const result = routeLead(
      {
        email: "buyer@example.com",
        company: { employee_count: 900, state: "NY" },
      },
      context,
      monday,
    );

    expect(result.rep.id).toBe("ada");
    expect(result.reason).toBe("rule_match");
  });

  it("preserves an eligible current owner", () => {
    const result = routeLead(
      {
        email: "buyer@example.com",
        current_owner_email: "marcus@example.com",
        company: { employee_count: 900, state: "NY" },
      },
      context,
      monday,
    );

    expect(result.rep.id).toBe("marcus");
    expect(result.reason).toBe("owner_preserved");
  });

  it("excludes reps reported busy by a calendar provider", () => {
    const result = routeLead(
      {
        email: "buyer@example.com",
        company: { employee_count: 900, state: "NY" },
      },
      context,
      monday,
      { unavailableRepEmails: ["ada@example.com"] },
    );

    expect(result.rep.id).toBe("marcus");
  });

  it("fails explicitly when no rule matches", () => {
    expect(() =>
      routeLead(
        {
          email: "buyer@example.com",
          company: { employee_count: 12, state: "CA" },
        },
        context,
        monday,
      ),
    ).toThrow(NoMatchingRuleError);
  });

  it("fails explicitly when all matched reps are unavailable", () => {
    expect(() =>
      routeLead(
        {
          email: "buyer@example.com",
          company: { employee_count: 900, state: "NY" },
        },
        context,
        new Date("2026-08-23T12:00:00.000Z"),
      ),
    ).toThrow(NoEligibleRepError);
  });

  it("previews the same weighted winner without changing routing state", () => {
    const lead = {
      email: "buyer@example.com",
      company: { employee_count: 900, state: "NY" },
    };
    const originalState = structuredClone(context.assignmentState);
    const preview = previewRoute(lead, context, monday);
    const result = routeLead(lead, context, monday);

    expect(preview).toMatchObject({
      outcome: "matched",
      evaluatedAt: monday.toISOString(),
      selectedRule: {
        id: result.rule.id,
        name: result.rule.name,
        priority: result.rule.priority,
        poolId: result.rule.poolId,
      },
      selectedRep: {
        id: result.rep.id,
        name: result.rep.name,
        email: result.rep.email,
      },
      reason: result.reason,
    });
    expect(preview.reps).toEqual([
      {
        id: "ada",
        name: "Ada Chen",
        email: "ada@example.com",
        active: true,
        scheduled: true,
        unavailable: false,
        eligible: true,
        assignments: 2,
        weight: 2,
        selected: true,
        exclusionReason: null,
      },
      {
        id: "marcus",
        name: "Marcus Reed",
        email: "marcus@example.com",
        active: true,
        scheduled: true,
        unavailable: false,
        eligible: true,
        assignments: 2,
        weight: 1,
        selected: false,
        exclusionReason: null,
      },
    ]);
    expect(context.assignmentState).toEqual(originalState);
  });

  it("previews owner preservation with the same reason as routing", () => {
    const lead = {
      email: "buyer@example.com",
      current_owner_email: "MARCUS@example.com",
      company: { employee_count: 900, state: "NY" },
    };

    const preview = previewRoute(lead, context, monday);
    const result = routeLead(lead, context, monday);

    expect(preview.outcome).toBe("matched");
    expect(preview.selectedRep?.id).toBe(result.rep.id);
    expect(preview.reason).toBe("owner_preserved");
    expect(preview.reason).toBe(result.reason);
  });

  it("selects from only the live candidates for an already matched rule", () => {
    const result = routeMatchedRule(
      {
        email: "buyer@example.com",
        current_owner_email: "ada@example.com",
      },
      enterpriseRule,
      [reps[1]!],
      context.assignmentState[enterpriseRule.poolId]!,
      monday,
    );

    expect(result.rep.id).toBe("marcus");
    expect(result.reason).toBe("rule_match");
  });

  it("explains every rep eligibility input", () => {
    const previewContext: RoutingContext = {
      rules: [enterpriseRule],
      pools: {
        "enterprise-ne": [
          { ...reps[0]!, id: "inactive", active: false, weight: 3 },
          {
            ...reps[0]!,
            id: "off-hours",
            email: "off-hours@example.com",
            availability: {
              sunday: [{ start: "00:00", end: "23:59" }],
            },
          },
          {
            ...reps[0]!,
            id: "busy",
            email: "busy@example.com",
            weight: 4,
          },
          {
            ...reps[1]!,
            id: "winner",
            email: "winner@example.com",
          },
        ],
      },
      assignmentState: {
        "enterprise-ne": [
          { repId: "inactive", assignments: 7, lastAssignedAt: null },
          { repId: "off-hours", assignments: 6, lastAssignedAt: null },
          { repId: "busy", assignments: 5, lastAssignedAt: null },
          { repId: "winner", assignments: 4, lastAssignedAt: null },
        ],
      },
    };

    const preview = previewRoute(
      {
        email: "buyer@example.com",
        company: { employee_count: 900, state: "NY" },
      },
      previewContext,
      monday,
      { unavailableRepEmails: ["BUSY@example.com"] },
    );

    expect(preview.outcome).toBe("matched");
    expect(
      preview.reps.map((rep) => ({
        id: rep.id,
        active: rep.active,
        scheduled: rep.scheduled,
        unavailable: rep.unavailable,
        eligible: rep.eligible,
        assignments: rep.assignments,
        weight: rep.weight,
        selected: rep.selected,
        exclusionReason: rep.exclusionReason,
      })),
    ).toEqual([
      {
        id: "inactive",
        active: false,
        scheduled: false,
        unavailable: false,
        eligible: false,
        assignments: 7,
        weight: 3,
        selected: false,
        exclusionReason: "inactive",
      },
      {
        id: "off-hours",
        active: true,
        scheduled: false,
        unavailable: false,
        eligible: false,
        assignments: 6,
        weight: 2,
        selected: false,
        exclusionReason: "outside_schedule",
      },
      {
        id: "busy",
        active: true,
        scheduled: true,
        unavailable: true,
        eligible: false,
        assignments: 5,
        weight: 4,
        selected: false,
        exclusionReason: "unavailable",
      },
      {
        id: "winner",
        active: true,
        scheduled: true,
        unavailable: false,
        eligible: true,
        assignments: 4,
        weight: 1,
        selected: true,
        exclusionReason: null,
      },
    ]);
  });

  it("returns a no-match preview instead of throwing", () => {
    const preview = previewRoute(
      {
        email: "buyer@example.com",
        company: { employee_count: 12, state: "CA" },
      },
      context,
      monday,
    );

    expect(preview).toMatchObject({
      outcome: "no_match",
      selectedRule: null,
      selectedRep: null,
      reason: null,
      reps: [],
    });
    expect(preview.rules[0]?.matched).toBe(false);
    expect(preview.rules[0]?.conditions).toHaveLength(2);
  });

  it("returns a no-eligible-rep preview with exclusions", () => {
    const preview = previewRoute(
      {
        email: "buyer@example.com",
        company: { employee_count: 900, state: "NY" },
      },
      context,
      monday,
      { unavailableRepEmails: reps.map((rep) => rep.email) },
    );

    expect(preview).toMatchObject({
      outcome: "no_eligible_rep",
      selectedRule: { id: "enterprise" },
      selectedRep: null,
      reason: null,
    });
    expect(preview.reps).toHaveLength(2);
    expect(preview.reps.every((rep) => !rep.eligible)).toBe(true);
    expect(
      preview.reps.every((rep) => rep.exclusionReason === "unavailable"),
    ).toBe(true);
    expect(preview.reps.every((rep) => !rep.selected)).toBe(true);
  });
});

describe("weighted round robin", () => {
  it("honors a two-to-one weight over a sequence", () => {
    const state = new Map(reps.map((rep) => [rep.id, 0]));
    const sequence: string[] = [];

    for (let index = 0; index < 6; index += 1) {
      const selected = pickWeightedRep(
        reps,
        reps.map((rep) => ({
          repId: rep.id,
          assignments: state.get(rep.id) ?? 0,
          lastAssignedAt: null,
        })),
      );
      expect(selected).toBeDefined();
      sequence.push(selected!.id);
      state.set(selected!.id, (state.get(selected!.id) ?? 0) + 1);
    }

    expect(sequence.filter((id) => id === "ada")).toHaveLength(4);
    expect(sequence.filter((id) => id === "marcus")).toHaveLength(2);
  });
});

describe("meeting buffers", () => {
  const slot = {
    startsAt: new Date("2026-09-02T15:00:00.000Z"),
    endsAt: new Date("2026-09-02T15:30:00.000Z"),
  };

  it("protects preparation and recovery time without changing the event", () => {
    const busy = [
      {
        startsAt: new Date("2026-09-02T14:40:00.000Z"),
        endsAt: new Date("2026-09-02T14:50:00.000Z"),
      },
      {
        startsAt: new Date("2026-09-02T15:40:00.000Z"),
        endsAt: new Date("2026-09-02T15:50:00.000Z"),
      },
    ];

    expect(withoutBusyIntervals([slot], busy)).toEqual([slot]);
    expect(
      withoutBusyIntervals([slot], busy, {
        beforeMinutes: 15,
        afterMinutes: 15,
      }),
    ).toEqual([]);
    expect(slot).toEqual({
      startsAt: new Date("2026-09-02T15:00:00.000Z"),
      endsAt: new Date("2026-09-02T15:30:00.000Z"),
    });
  });

  it("keeps exact buffer boundaries half-open", () => {
    expect(
      withoutBusyIntervals(
        [slot],
        [
          {
            startsAt: new Date("2026-09-02T14:30:00.000Z"),
            endsAt: new Date("2026-09-02T14:45:00.000Z"),
          },
          {
            startsAt: new Date("2026-09-02T15:45:00.000Z"),
            endsAt: new Date("2026-09-02T16:00:00.000Z"),
          },
        ],
        { beforeMinutes: 15, afterMinutes: 15 },
      ),
    ).toEqual([slot]);
  });
});
