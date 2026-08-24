import type { Lead } from "@hot-potato/router";

export type RouteRequest = {
  organizationSlug: string;
  externalId?: string;
  lead: Lead;
  now?: Date;
};

export type RouteDecision = {
  id: string;
  leadEmail: string;
  repName: string;
  repEmail: string;
  ruleName: string;
  poolName: string;
  reason: "rule_match" | "owner_preserved";
  createdAt: string;
  writebackStatus: string;
};

export type Dashboard = {
  organization: { name: string; slug: string };
  stats: {
    routesToday: number;
    activeReps: number;
    activeRules: number;
    pendingJobs: number;
  };
  pools: Array<{
    id: string;
    name: string;
    slug: string;
    strategy: string;
    members: Array<{
      name: string;
      email: string;
      weight: number;
      active: boolean;
      assignments: number;
    }>;
  }>;
  rules: Array<{
    id: string;
    name: string;
    priority: number;
    conditions: Record<string, unknown>;
    poolName: string;
  }>;
  decisions: RouteDecision[];
};

export type Job = {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
};
