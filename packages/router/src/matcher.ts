import type { Lead, Predicate, Rule } from "./types.js";

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

export function ruleMatches(lead: Lead, rule: Rule): boolean {
  return Object.entries(rule.conditions).every(([path, predicate]) =>
    matchesPredicate(getValue(lead, path), predicate),
  );
}

export function findMatchingRule(lead: Lead, rules: Rule[]): Rule | undefined {
  return [...rules]
    .sort((left, right) => left.priority - right.priority)
    .find((rule) => ruleMatches(lead, rule));
}
