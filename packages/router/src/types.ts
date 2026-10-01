export type Lead = {
  email: string;
  current_owner_email?: string;
  [key: string]: unknown;
};

export type Predicate =
  | { eq: string | number | boolean }
  | { in: Array<string | number> }
  | { gte: number }
  | { lte: number }
  | { contains: string }
  | { exists: boolean };

export type Rule = {
  id: string;
  name: string;
  priority: number;
  poolId: string;
  conditions: Record<string, Predicate>;
};

export type TimeRange = {
  start: string;
  end: string;
};

export type WeeklyAvailability = Partial<
  Record<
    | "monday"
    | "tuesday"
    | "wednesday"
    | "thursday"
    | "friday"
    | "saturday"
    | "sunday",
    TimeRange[]
  >
>;

export type DateAvailabilityOverrides = Record<string, TimeRange[]>;

export type Rep = {
  id: string;
  name: string;
  email: string;
  timezone: string;
  weight: number;
  active: boolean;
  availability: WeeklyAvailability;
  availabilityOverrides?: DateAvailabilityOverrides;
};

export type AssignmentState = {
  repId: string;
  assignments: number;
  lastAssignedAt: Date | null;
};

export type RoutingContext = {
  rules: Rule[];
  pools: Record<string, Rep[]>;
  assignmentState: Record<string, AssignmentState[]>;
};

export type RouteReason = "rule_match" | "owner_preserved";

export type RouteResult = {
  rule: Rule;
  rep: Rep;
  reason: RouteReason;
  evaluatedAt: Date;
};

export type RouteOptions = {
  unavailableRepEmails?: string[];
};

export type EligibleRoute = {
  rule: Rule;
  reps: Rep[];
};

export type PredicateOperator =
  | "eq"
  | "in"
  | "gte"
  | "lte"
  | "contains"
  | "exists";

export type RoutingPreviewValue =
  | string
  | number
  | boolean
  | null
  | RoutingPreviewValue[]
  | { [key: string]: RoutingPreviewValue };

export type RoutingPreviewCondition = {
  field: string;
  operator: PredicateOperator;
  expected: RoutingPreviewValue;
  actual: RoutingPreviewValue;
  matched: boolean;
};

export type RoutingPreviewRule = {
  id: string;
  name: string;
  priority: number;
  poolId: string;
  matched: boolean;
  conditions: RoutingPreviewCondition[];
};

export type RoutingPreviewSelectedRule = Pick<
  RoutingPreviewRule,
  "id" | "name" | "priority" | "poolId"
>;

export type RoutingPreviewSelectedRep = Pick<Rep, "id" | "name" | "email">;

export type RoutingPreviewRepExclusionReason =
  | "inactive"
  | "outside_schedule"
  | "unavailable";

export type RoutingPreviewRep = RoutingPreviewSelectedRep & {
  active: boolean;
  scheduled: boolean;
  unavailable: boolean;
  eligible: boolean;
  assignments: number;
  weight: number;
  selected: boolean;
  exclusionReason: RoutingPreviewRepExclusionReason | null;
};

export type RoutingPreviewOutcome = "matched" | "no_match" | "no_eligible_rep";

export type RoutingPreview = {
  outcome: RoutingPreviewOutcome;
  evaluatedAt: string;
  selectedRule: RoutingPreviewSelectedRule | null;
  selectedRep: RoutingPreviewSelectedRep | null;
  reason: RouteReason | null;
  rules: RoutingPreviewRule[];
  reps: RoutingPreviewRep[];
};
