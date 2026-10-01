import { isRepScheduled } from "./availability.js";
import { NoEligibleRepError, NoMatchingRuleError } from "./errors.js";
import {
  evaluateRuleConditions,
  findMatchingRule,
  rulesInEvaluationOrder,
} from "./matcher.js";
import type {
  EligibleRoute,
  Lead,
  RouteOptions,
  RouteResult,
  RoutingPreview,
  RoutingPreviewRep,
  RoutingPreviewRepExclusionReason,
  RoutingPreviewRule,
  RoutingPreviewSelectedRule,
  RoutingContext,
} from "./types.js";
import { pickWeightedRep } from "./weighted-round-robin.js";

export function routeLead(
  lead: Lead,
  context: RoutingContext,
  evaluatedAt = new Date(),
  options: RouteOptions = {},
): RouteResult {
  const rule = findMatchingRule(lead, context.rules);
  if (!rule) throw new NoMatchingRuleError();
  return routeMatchedRule(
    lead,
    rule,
    context.pools[rule.poolId] ?? [],
    context.assignmentState[rule.poolId] ?? [],
    evaluatedAt,
    options,
  );
}

export function routeMatchedRule(
  lead: Lead,
  rule: RoutingContext["rules"][number],
  reps: RoutingContext["pools"][string],
  assignmentState: RoutingContext["assignmentState"][string],
  evaluatedAt = new Date(),
  options: RouteOptions = {},
): RouteResult {
  const unavailable = new Set(
    (options.unavailableRepEmails ?? []).map((email) =>
      email.toLocaleLowerCase(),
    ),
  );
  const eligibleReps = reps.filter(
    (rep) =>
      isRepScheduled(rep, evaluatedAt) &&
      !unavailable.has(rep.email.toLocaleLowerCase()),
  );
  if (eligibleReps.length === 0) throw new NoEligibleRepError(rule.poolId);

  const currentOwner = lead.current_owner_email?.toLocaleLowerCase();
  const preservedOwner = currentOwner
    ? eligibleReps.find((rep) => rep.email.toLocaleLowerCase() === currentOwner)
    : undefined;

  if (preservedOwner) {
    return {
      rule,
      rep: preservedOwner,
      reason: "owner_preserved",
      evaluatedAt,
    };
  }

  const rep = pickWeightedRep(eligibleReps, assignmentState);
  if (!rep) throw new NoEligibleRepError(rule.poolId);
  return { rule, rep, reason: "rule_match", evaluatedAt };
}

export function eligibleRepsForLead(
  lead: Lead,
  context: RoutingContext,
  evaluatedAt = new Date(),
): EligibleRoute {
  const rule = findMatchingRule(lead, context.rules);
  if (!rule) throw new NoMatchingRuleError();

  const eligibleReps = (context.pools[rule.poolId] ?? []).filter((rep) =>
    isRepScheduled(rep, evaluatedAt),
  );
  if (eligibleReps.length === 0) throw new NoEligibleRepError(rule.poolId);
  return { rule, reps: eligibleReps };
}

function previewRule(
  rule: RoutingContext["rules"][number],
  lead: Lead,
): RoutingPreviewRule {
  const conditions = evaluateRuleConditions(lead, rule);
  return {
    id: rule.id,
    name: rule.name,
    priority: rule.priority,
    poolId: rule.poolId,
    matched: conditions.every((condition) => condition.matched),
    conditions,
  };
}

function selectedRulePreview(
  rule: RoutingContext["rules"][number],
): RoutingPreviewSelectedRule {
  return {
    id: rule.id,
    name: rule.name,
    priority: rule.priority,
    poolId: rule.poolId,
  };
}

function previewRepExclusionReason(input: {
  active: boolean;
  scheduled: boolean;
  unavailable: boolean;
}): RoutingPreviewRepExclusionReason | null {
  if (!input.active) return "inactive";
  if (!input.scheduled) return "outside_schedule";
  if (input.unavailable) return "unavailable";
  return null;
}

export function previewRoute(
  lead: Lead,
  context: RoutingContext,
  evaluatedAt = new Date(),
  options: RouteOptions = {},
): RoutingPreview {
  const rules = rulesInEvaluationOrder(context.rules).map((rule) =>
    previewRule(rule, lead),
  );
  const selectedRule = findMatchingRule(lead, context.rules);

  if (!selectedRule) {
    return {
      outcome: "no_match",
      evaluatedAt: evaluatedAt.toISOString(),
      selectedRule: null,
      selectedRep: null,
      reason: null,
      rules,
      reps: [],
    };
  }

  const unavailableEmails = new Set(
    (options.unavailableRepEmails ?? []).map((email) =>
      email.toLocaleLowerCase(),
    ),
  );
  const assignmentState = new Map(
    (context.assignmentState[selectedRule.poolId] ?? []).map((state) => [
      state.repId,
      state,
    ]),
  );
  const reps: RoutingPreviewRep[] = (
    context.pools[selectedRule.poolId] ?? []
  ).map((rep) => {
    const active = rep.active;
    const scheduled = isRepScheduled(rep, evaluatedAt);
    const unavailable = unavailableEmails.has(rep.email.toLocaleLowerCase());
    const exclusionReason = previewRepExclusionReason({
      active,
      scheduled,
      unavailable,
    });
    return {
      id: rep.id,
      name: rep.name,
      email: rep.email,
      active,
      scheduled,
      unavailable,
      eligible: exclusionReason === null,
      assignments: assignmentState.get(rep.id)?.assignments ?? 0,
      weight: rep.weight,
      selected: false,
      exclusionReason,
    };
  });

  let result: RouteResult;
  try {
    result = routeLead(lead, context, evaluatedAt, options);
  } catch (error) {
    if (!(error instanceof NoEligibleRepError)) throw error;
    return {
      outcome: "no_eligible_rep",
      evaluatedAt: evaluatedAt.toISOString(),
      selectedRule: selectedRulePreview(selectedRule),
      selectedRep: null,
      reason: null,
      rules,
      reps,
    };
  }

  const repsWithSelection = reps.map((rep) => ({
    ...rep,
    selected: rep.id === result.rep.id,
  }));

  return {
    outcome: "matched",
    evaluatedAt: evaluatedAt.toISOString(),
    selectedRule: selectedRulePreview(result.rule),
    selectedRep: {
      id: result.rep.id,
      name: result.rep.name,
      email: result.rep.email,
    },
    reason: result.reason,
    rules,
    reps: repsWithSelection,
  };
}
