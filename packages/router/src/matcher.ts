import type {
  Lead,
  Predicate,
  PredicateOperator,
  RoutingPreviewCondition,
  RoutingPreviewValue,
  Rule,
} from "./types.js";

function getValue(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, source);
}

function matchesPredicate(value: unknown, predicate: Predicate): boolean {
  if ("eq" in predicate) return value === predicate.eq;
  if ("in" in predicate) return predicate.in.includes(value as string | number);
  if ("gte" in predicate)
    return typeof value === "number" && value >= predicate.gte;
  if ("lte" in predicate)
    return typeof value === "number" && value <= predicate.lte;
  if ("contains" in predicate)
    return (
      typeof value === "string" &&
      value.toLocaleLowerCase().includes(predicate.contains.toLocaleLowerCase())
    );
  if ("exists" in predicate)
    return predicate.exists
      ? value !== undefined && value !== null
      : value == null;
  return false;
}

function predicateParts(predicate: Predicate): {
  operator: PredicateOperator;
  expected: RoutingPreviewValue;
} {
  if ("eq" in predicate)
    return { operator: "eq", expected: jsonSafeValue(predicate.eq) };
  if ("in" in predicate)
    return { operator: "in", expected: jsonSafeValue(predicate.in) };
  if ("gte" in predicate)
    return { operator: "gte", expected: jsonSafeValue(predicate.gte) };
  if ("lte" in predicate)
    return { operator: "lte", expected: jsonSafeValue(predicate.lte) };
  if ("contains" in predicate)
    return {
      operator: "contains",
      expected: jsonSafeValue(predicate.contains),
    };
  return {
    operator: "exists",
    expected: jsonSafeValue(predicate.exists),
  };
}

function jsonSafeValue(value: unknown): RoutingPreviewValue {
  if (value === undefined) return null;

  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? null
      : (JSON.parse(serialized) as RoutingPreviewValue);
  } catch {
    return null;
  }
}

export function evaluateRuleConditions(
  lead: Lead,
  rule: Rule,
): RoutingPreviewCondition[] {
  return Object.entries(rule.conditions).map(([field, predicate]) => {
    const actual = getValue(lead, field);
    const { operator, expected } = predicateParts(predicate);
    return {
      field,
      operator,
      expected,
      actual: jsonSafeValue(actual),
      matched: matchesPredicate(actual, predicate),
    };
  });
}

export function ruleMatches(lead: Lead, rule: Rule): boolean {
  return Object.entries(rule.conditions).every(([path, predicate]) =>
    matchesPredicate(getValue(lead, path), predicate),
  );
}

export function isCatchAllRule(rule: Rule): boolean {
  return Object.keys(rule.conditions).length === 0;
}

export function rulesInEvaluationOrder(rules: Rule[]): Rule[] {
  return [...rules].sort((left, right) => {
    const catchAllOrder =
      Number(isCatchAllRule(left)) - Number(isCatchAllRule(right));
    if (catchAllOrder !== 0) return catchAllOrder;
    return left.priority - right.priority;
  });
}

export function findMatchingRule(lead: Lead, rules: Rule[]): Rule | undefined {
  return rulesInEvaluationOrder(rules).find((rule) => ruleMatches(lead, rule));
}
