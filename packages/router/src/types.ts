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

export type Rep = {
  id: string;
  name: string;
  email: string;
  timezone: string;
  weight: number;
  active: boolean;
  availability: WeeklyAvailability;
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
