import { beforeEach, describe, expect, it, vi } from "vitest";

const poolId = "373ae899-b40c-48e7-b68d-6dc21ff163be";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
}));

vi.mock("../app/repository", () => ({
  repository: { saveRoutingRule: mocks.save },
}));

import { PUT } from "../app/api/settings/rules/route";

function request(body: unknown) {
  return new Request("https://schedule.example/api/settings/rules", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function rule(overrides: Record<string, unknown> = {}) {
  return {
    name: "Enterprise",
    priority: 10,
    conditions: { "company.segment": { eq: "enterprise" } },
    poolId,
    active: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.save.mockResolvedValue("31022206-babe-435a-991f-ddd92968e09b");
});

describe("routing-rule settings route", () => {
  it("preserves conditional rules", async () => {
    const response = await PUT(request(rule()));

    expect(response.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith({
      organizationSlug: "acme",
      name: "Enterprise",
      priority: 10,
      conditions: { "company.segment": { eq: "enterprise" } },
      poolId,
      active: true,
    });
  });

  it("requires an explicit catch-all and stores it as an empty condition set", async () => {
    const rejected = await PUT(request(rule({ conditions: {} })));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: "Add at least one condition or choose catch-all.",
    });
    expect(mocks.save).not.toHaveBeenCalled();

    const accepted = await PUT(
      request(
        rule({
          name: "Every other qualified lead",
          priority: 1,
          conditions: {},
          catchAll: true,
        }),
      ),
    );
    expect(accepted.status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Every other qualified lead",
        conditions: {},
      }),
    );
  });

  it("rejects conditions on a catch-all", async () => {
    const response = await PUT(request(rule({ catchAll: true })));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "A catch-all cannot contain conditions.",
    });
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("returns a specific duplicate catch-all message", async () => {
    mocks.save.mockRejectedValue({
      code: "23505",
      constraint_name: "routing_rules_one_catch_all_idx",
    });
    const response = await PUT(
      request(rule({ conditions: {}, catchAll: true })),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error:
        "This workspace already has a catch-all rule. Edit that rule instead.",
    });
  });
});
