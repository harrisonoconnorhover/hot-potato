import { describe, expect, it } from "vitest";
import {
  NoEligibleRepError,
  NoMatchingRuleError,
  pickWeightedRep,
  routeLead,
  ruleMatches,
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
});

describe("routing", () => {
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
