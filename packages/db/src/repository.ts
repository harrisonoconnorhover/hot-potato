import {
  routeLead as evaluateRoute,
  type AssignmentState,
  type Rep,
  type RoutingContext,
  type Rule,
} from "@hot-potato/router";
import type { JSONValue, Sql, TransactionSql } from "postgres";
import { createDatabase } from "./client.js";
import type { Dashboard, Job, RouteDecision, RouteRequest } from "./types.js";

type OrganizationRow = { id: string; name: string; slug: string };
type RuleRow = {
  id: string;
  name: string;
  priority: number;
  poolId: string;
  poolName: string;
  conditions: Rule["conditions"];
};
type RepRow = Rep & { poolId: string };
type AssignmentStateRow = AssignmentState & { poolId: string };

async function routingContext(
  sql: Sql | TransactionSql,
  organizationId: string,
): Promise<{ context: RoutingContext; rules: RuleRow[] }> {
  const rules = (await sql`
    SELECT rr.id, rr.name, rr.priority, rr.conditions, rr.pool_id, rp.name AS pool_name
    FROM routing_rules rr
    JOIN routing_pools rp ON rp.id = rr.pool_id
    WHERE rr.organization_id = ${organizationId} AND rr.active = true
    ORDER BY rr.priority ASC
  `) as unknown as RuleRow[];

  const reps = (await sql`
    SELECT r.id, r.name, r.email, r.timezone, r.weight, r.active, r.availability,
           rpm.pool_id
    FROM reps r
    JOIN routing_pool_members rpm ON rpm.rep_id = r.id
    JOIN routing_pools rp ON rp.id = rpm.pool_id
    WHERE rp.organization_id = ${organizationId}
  `) as unknown as RepRow[];

  const state = (await sql`
    SELECT ast.pool_id, ast.rep_id, ast.assignments, ast.last_assigned_at
    FROM assignment_state ast
    JOIN routing_pools rp ON rp.id = ast.pool_id
    WHERE rp.organization_id = ${organizationId}
  `) as unknown as AssignmentStateRow[];

  const pools: Record<string, Rep[]> = {};
  for (const rep of reps) {
    const { poolId, ...member } = rep;
    (pools[poolId] ??= []).push(member);
  }

  const assignmentState: Record<string, AssignmentState[]> = {};
  for (const item of state) {
    const { poolId, ...repState } = item;
    (assignmentState[poolId] ??= []).push(repState);
  }

  return {
    context: {
      rules: rules.map(({ poolName: _poolName, ...rule }) => rule),
      pools,
      assignmentState,
    },
    rules,
  };
}

function decisionFromRow(row: Record<string, unknown>): RouteDecision {
  return {
    id: String(row.id),
    leadEmail: String(row.leadEmail),
    repName: String(row.repName),
    repEmail: String(row.repEmail),
    ruleName: String(row.ruleName),
    poolName: String(row.poolName),
    reason: row.reason as RouteDecision["reason"],
    createdAt: new Date(String(row.createdAt)).toISOString(),
    writebackStatus: String(row.writebackStatus),
  };
}

export class HotPotatoRepository {
  constructor(private readonly sql: Sql = createDatabase()) {}

  async close(): Promise<void> {
    await this.sql.end();
  }

  async health(): Promise<boolean> {
    const [row] = await this.sql`SELECT 1 AS healthy`;
    return row?.healthy === 1;
  }

  async route(request: RouteRequest): Promise<RouteDecision> {
    return this.sql.begin(async (transaction) => {
      const [organization] = (await transaction`
        SELECT id, name, slug FROM organizations WHERE slug = ${request.organizationSlug}
      `) as unknown as OrganizationRow[];
      if (!organization) {
        throw new Error(`Unknown organization: ${request.organizationSlug}`);
      }

      if (request.externalId) {
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtext(${`${organization.id}:${request.externalId}`})
          )
        `;
        const [existing] = await transaction`
          SELECT rd.id, rd.lead_email, rd.reason, rd.created_at, r.name AS rep_name,
                 r.email AS rep_email, rr.name AS rule_name, rp.name AS pool_name,
                 coalesce(j.status, 'missing') AS writeback_status
          FROM routing_decisions rd
          JOIN reps r ON r.id = rd.rep_id
          JOIN routing_rules rr ON rr.id = rd.rule_id
          JOIN routing_pools rp ON rp.id = rd.pool_id
          LEFT JOIN jobs j ON j.payload->>'decisionId' = rd.id::text
          WHERE rd.organization_id = ${organization.id}
            AND rd.external_id = ${request.externalId}
          LIMIT 1
        `;
        if (existing) return decisionFromRow(existing);
      }

      let loaded = await routingContext(transaction, organization.id);
      const preliminary = evaluateRoute(
        request.lead,
        loaded.context,
        request.now,
      );

      await transaction`
        SELECT pg_advisory_xact_lock(hashtext(${preliminary.rule.poolId}))
      `;
      loaded = await routingContext(transaction, organization.id);
      const result = evaluateRoute(request.lead, loaded.context, request.now);

      const [decision] = await transaction`
        INSERT INTO routing_decisions (
          organization_id, external_id, lead_email, lead, rule_id, pool_id, rep_id, reason
        ) VALUES (
          ${organization.id}, ${request.externalId ?? null}, ${request.lead.email},
          ${transaction.json(request.lead as JSONValue)}, ${result.rule.id}, ${result.rule.poolId},
          ${result.rep.id}, ${result.reason}
        )
        ON CONFLICT (organization_id, external_id)
        DO UPDATE SET external_id = EXCLUDED.external_id
        RETURNING id, created_at
      `;

      await transaction`
        INSERT INTO assignment_state (pool_id, rep_id, assignments, last_assigned_at)
        VALUES (${result.rule.poolId}, ${result.rep.id}, 1, ${result.evaluatedAt})
        ON CONFLICT (pool_id, rep_id) DO UPDATE SET
          assignments = assignment_state.assignments + 1,
          last_assigned_at = EXCLUDED.last_assigned_at
      `;

      await transaction`
        INSERT INTO jobs (organization_id, type, payload)
        VALUES (
          ${organization.id},
          'crm.owner.writeback',
          ${transaction.json({
            adapter: "development",
            decisionId: decision!.id,
            leadEmail: request.lead.email,
            ownerEmail: result.rep.email,
          })}
        )
      `;

      const ruleRow = loaded.rules.find((rule) => rule.id === result.rule.id)!;
      return {
        id: String(decision!.id),
        leadEmail: request.lead.email,
        repName: result.rep.name,
        repEmail: result.rep.email,
        ruleName: result.rule.name,
        poolName: ruleRow.poolName,
        reason: result.reason,
        createdAt: new Date(String(decision!.createdAt)).toISOString(),
        writebackStatus: "pending",
      };
    });
  }

  async dashboard(organizationSlug: string): Promise<Dashboard> {
    const [organization] = (await this.sql`
      SELECT id, name, slug FROM organizations WHERE slug = ${organizationSlug}
    `) as unknown as OrganizationRow[];
    if (!organization)
      throw new Error(`Unknown organization: ${organizationSlug}`);

    const [stats] = await this.sql`
      SELECT
        (SELECT count(*)::int FROM routing_decisions WHERE organization_id = ${organization.id}
          AND created_at >= date_trunc('day', now())) AS routes_today,
        (SELECT count(*)::int FROM reps WHERE organization_id = ${organization.id} AND active) AS active_reps,
        (SELECT count(*)::int FROM routing_rules WHERE organization_id = ${organization.id} AND active) AS active_rules,
        (SELECT count(*)::int FROM jobs WHERE organization_id = ${organization.id}
          AND status IN ('pending', 'processing')) AS pending_jobs
    `;

    const poolRows = await this.sql`
      SELECT rp.id, rp.name, rp.slug, rp.strategy, r.name AS rep_name, r.email,
             r.weight, r.active, coalesce(ast.assignments, 0)::int AS assignments
      FROM routing_pools rp
      LEFT JOIN routing_pool_members rpm ON rpm.pool_id = rp.id
      LEFT JOIN reps r ON r.id = rpm.rep_id
      LEFT JOIN assignment_state ast ON ast.pool_id = rp.id AND ast.rep_id = r.id
      WHERE rp.organization_id = ${organization.id}
      ORDER BY rp.name, r.name
    `;

    const pools = new Map<string, Dashboard["pools"][number]>();
    for (const row of poolRows) {
      const id = String(row.id);
      const pool = pools.get(id) ?? {
        id,
        name: String(row.name),
        slug: String(row.slug),
        strategy: String(row.strategy),
        members: [],
      };
      if (row.email) {
        pool.members.push({
          name: String(row.repName),
          email: String(row.email),
          weight: Number(row.weight),
          active: Boolean(row.active),
          assignments: Number(row.assignments),
        });
      }
      pools.set(id, pool);
    }

    const rules = await this.sql`
      SELECT rr.id, rr.name, rr.priority, rr.conditions, rp.name AS pool_name
      FROM routing_rules rr
      JOIN routing_pools rp ON rp.id = rr.pool_id
      WHERE rr.organization_id = ${organization.id} AND rr.active
      ORDER BY rr.priority
    `;

    const decisionRows = await this.sql`
      SELECT rd.id, rd.lead_email, rd.reason, rd.created_at, r.name AS rep_name,
             r.email AS rep_email, rr.name AS rule_name, rp.name AS pool_name,
             coalesce(j.status, 'missing') AS writeback_status
      FROM routing_decisions rd
      JOIN reps r ON r.id = rd.rep_id
      JOIN routing_rules rr ON rr.id = rd.rule_id
      JOIN routing_pools rp ON rp.id = rd.pool_id
      LEFT JOIN jobs j ON j.payload->>'decisionId' = rd.id::text
      WHERE rd.organization_id = ${organization.id}
      ORDER BY rd.created_at DESC
      LIMIT 12
    `;

    return {
      organization: { name: organization.name, slug: organization.slug },
      stats: {
        routesToday: Number(stats?.routesToday ?? 0),
        activeReps: Number(stats?.activeReps ?? 0),
        activeRules: Number(stats?.activeRules ?? 0),
        pendingJobs: Number(stats?.pendingJobs ?? 0),
      },
      pools: [...pools.values()],
      rules: rules.map((rule) => ({
        id: String(rule.id),
        name: String(rule.name),
        priority: Number(rule.priority),
        conditions: rule.conditions as Record<string, unknown>,
        poolName: String(rule.poolName),
      })),
      decisions: decisionRows.map((row) => decisionFromRow(row)),
    };
  }

  async claimJob(): Promise<Job | null> {
    const [job] = await this.sql.begin(
      async (transaction) =>
        transaction`
        WITH next_job AS (
          SELECT id FROM jobs
          WHERE (status = 'pending' AND run_at <= now())
             OR (status = 'processing' AND locked_at < now() - interval '5 minutes')
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE jobs SET status = 'processing', locked_at = now(), attempts = attempts + 1
        WHERE id = (SELECT id FROM next_job)
        RETURNING id, type, payload, attempts
      `,
    );
    if (!job) return null;
    return {
      id: Number(job.id),
      type: String(job.type),
      payload: job.payload as Record<string, unknown>,
      attempts: Number(job.attempts),
    };
  }

  async completeJob(id: number): Promise<void> {
    await this.sql`
      UPDATE jobs SET status = 'completed', completed_at = now(), locked_at = null
      WHERE id = ${id}
    `;
  }

  async failJob(id: number, error: string): Promise<void> {
    await this.sql`
      UPDATE jobs SET
        status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END,
        run_at = now() + (interval '10 seconds' * greatest(attempts, 1)),
        locked_at = null,
        last_error = ${error}
      WHERE id = ${id}
    `;
  }
}
