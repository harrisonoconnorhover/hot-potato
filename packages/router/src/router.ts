import { isRepScheduled } from "./availability.js";
import { NoEligibleRepError, NoMatchingRuleError } from "./errors.js";
import { findMatchingRule } from "./matcher.js";
import type {
  EligibleRoute,
  Lead,
  RouteOptions,
  RouteResult,
  RoutingContext,
} from "./types.js";
import { pickWeightedRep } from "./weighted-round-robin.js";

export function routeLead(
  lead: Lead,
  context: RoutingContext,
  evaluatedAt = new Date(),
  options: RouteOptions = {},
): RouteResult {
  const { rule, reps } = eligibleRepsForLead(lead, context, evaluatedAt);
  const unavailable = new Set(
    (options.unavailableRepEmails ?? []).map((email) =>
      email.toLocaleLowerCase(),
    ),
  );
  const eligibleReps = reps.filter(
    (rep) => !unavailable.has(rep.email.toLocaleLowerCase()),
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

  const rep = pickWeightedRep(
    eligibleReps,
    context.assignmentState[rule.poolId] ?? [],
  );
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
