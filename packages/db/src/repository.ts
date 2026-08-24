import {
  eligibleRepsForLead,
  routeLead as evaluateRoute,
  type AssignmentState,
  type Rep,
  type RoutingContext,
  type Rule,
} from "@hot-potato/router";
import type { JSONValue, Sql, TransactionSql } from "postgres";
import { createDatabase } from "./client.js";
import type {
  ConnectionStatus,
  Dashboard,
  Job,
  OAuthConnection,
  OAuthProvider,
  RouteDecision,
  RouteRequest,
  SaveOAuthConnection,
} from "./types.js";

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
    availabilitySource:
      row.availabilitySource as RouteDecision["availabilitySource"],
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
                 coalesce(j.status, 'missing') AS writeback_status,
                 rd.availability_source
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
        { unavailableRepEmails: request.unavailableRepEmails },
      );

      await transaction`
        SELECT pg_advisory_xact_lock(hashtext(${preliminary.rule.poolId}))
      `;
      loaded = await routingContext(transaction, organization.id);
      const result = evaluateRoute(request.lead, loaded.context, request.now, {
        unavailableRepEmails: request.unavailableRepEmails,
      });

      const [hubspotConnection] = await transaction`
        SELECT 1 FROM oauth_connections
        WHERE organization_id = ${organization.id} AND provider = 'hubspot'
      `;
      const crmAdapter = hubspotConnection ? "hubspot" : "development";
      const availabilitySource =
        request.availabilitySource ?? "weekly_schedule";

      const [decision] = await transaction`
        INSERT INTO routing_decisions (
          organization_id, external_id, lead_email, lead, rule_id, pool_id, rep_id,
          reason, availability_source
        ) VALUES (
          ${organization.id}, ${request.externalId ?? null}, ${request.lead.email},
          ${transaction.json(request.lead as JSONValue)}, ${result.rule.id}, ${result.rule.poolId},
          ${result.rep.id}, ${result.reason}, ${availabilitySource}
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
            adapter: crmAdapter,
            organizationSlug: organization.slug,
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
        availabilitySource,
      };
    });
  }

  async routeCandidates(
    request: Pick<RouteRequest, "organizationSlug" | "lead" | "now">,
  ): Promise<string[]> {
    const [organization] = (await this.sql`
      SELECT id, name, slug FROM organizations WHERE slug = ${request.organizationSlug}
    `) as unknown as OrganizationRow[];
    if (!organization)
      throw new Error(`Unknown organization: ${request.organizationSlug}`);

    const loaded = await routingContext(this.sql, organization.id);
    return eligibleRepsForLead(
      request.lead,
      loaded.context,
      request.now,
    ).reps.map((rep) => rep.email);
  }

  async decisionByExternalId(
    organizationSlug: string,
    externalId: string,
  ): Promise<RouteDecision | null> {
    const [row] = await this.sql`
      SELECT rd.id, rd.lead_email, rd.reason, rd.created_at, r.name AS rep_name,
             r.email AS rep_email, rr.name AS rule_name, rp.name AS pool_name,
             coalesce(j.status, 'missing') AS writeback_status,
             rd.availability_source
      FROM routing_decisions rd
      JOIN organizations o ON o.id = rd.organization_id
      JOIN reps r ON r.id = rd.rep_id
      JOIN routing_rules rr ON rr.id = rd.rule_id
      JOIN routing_pools rp ON rp.id = rd.pool_id
      LEFT JOIN jobs j ON j.payload->>'decisionId' = rd.id::text
      WHERE o.slug = ${organizationSlug} AND rd.external_id = ${externalId}
    `;
    return row ? decisionFromRow(row) : null;
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
             coalesce(j.status, 'missing') AS writeback_status,
             rd.availability_source
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

  async completeJob(
    id: number,
    result?: Record<string, unknown>,
  ): Promise<void> {
    await this.sql`
      UPDATE jobs SET status = 'completed', completed_at = now(), locked_at = null,
        result = ${result ? this.sql.json(result as JSONValue) : null}
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

  async getOAuthConnection(
    organizationSlug: string,
    provider: OAuthProvider,
  ): Promise<OAuthConnection | null> {
    const [row] = await this.sql`
      SELECT o.slug AS organization_slug, c.provider, c.encrypted_access_token,
             c.encrypted_refresh_token, c.expires_at, c.scopes,
             c.external_account_id, c.external_account_name, c.metadata, c.updated_at
      FROM oauth_connections c
      JOIN organizations o ON o.id = c.organization_id
      WHERE o.slug = ${organizationSlug} AND c.provider = ${provider}
    `;
    if (!row) return null;
    return {
      organizationSlug: String(row.organizationSlug),
      provider: row.provider as OAuthProvider,
      encryptedAccessToken: String(row.encryptedAccessToken),
      encryptedRefreshToken: String(row.encryptedRefreshToken),
      expiresAt: new Date(String(row.expiresAt)),
      scopes: row.scopes as string[],
      externalAccountId: row.externalAccountId
        ? String(row.externalAccountId)
        : null,
      externalAccountName: row.externalAccountName
        ? String(row.externalAccountName)
        : null,
      metadata: row.metadata as Record<string, unknown>,
      updatedAt: new Date(String(row.updatedAt)),
    };
  }

  async saveOAuthConnection(connection: SaveOAuthConnection): Promise<void> {
    const [organization] = await this.sql`
      SELECT id FROM organizations WHERE slug = ${connection.organizationSlug}
    `;
    if (!organization) {
      throw new Error(`Unknown organization: ${connection.organizationSlug}`);
    }

    await this.sql`
      INSERT INTO oauth_connections (
        organization_id, provider, encrypted_access_token, encrypted_refresh_token,
        expires_at, scopes, external_account_id, external_account_name, metadata
      ) VALUES (
        ${organization.id}, ${connection.provider}, ${connection.encryptedAccessToken},
        ${connection.encryptedRefreshToken}, ${connection.expiresAt},
        ${connection.scopes}, ${connection.externalAccountId},
        ${connection.externalAccountName}, ${this.sql.json(connection.metadata as JSONValue)}
      )
      ON CONFLICT (organization_id, provider) DO UPDATE SET
        encrypted_access_token = EXCLUDED.encrypted_access_token,
        encrypted_refresh_token = EXCLUDED.encrypted_refresh_token,
        expires_at = EXCLUDED.expires_at,
        scopes = EXCLUDED.scopes,
        external_account_id = EXCLUDED.external_account_id,
        external_account_name = EXCLUDED.external_account_name,
        metadata = EXCLUDED.metadata,
        updated_at = now()
    `;
  }

  async connectionStatuses(
    organizationSlug: string,
  ): Promise<ConnectionStatus[]> {
    const rows = await this.sql`
      SELECT providers.provider, c.external_account_id, c.external_account_name,
             c.scopes, c.expires_at
      FROM (VALUES ('hubspot'::text), ('google'::text)) AS providers(provider)
      CROSS JOIN organizations o
      LEFT JOIN oauth_connections c
        ON c.organization_id = o.id AND c.provider = providers.provider
      WHERE o.slug = ${organizationSlug}
      ORDER BY providers.provider
    `;
    return rows.map((row) => ({
      provider: row.provider as OAuthProvider,
      connected: Boolean(row.expiresAt),
      accountId: row.externalAccountId ? String(row.externalAccountId) : null,
      accountName: row.externalAccountName
        ? String(row.externalAccountName)
        : null,
      scopes: (row.scopes as string[] | null) ?? [],
      expiresAt: row.expiresAt
        ? new Date(String(row.expiresAt)).toISOString()
        : null,
    }));
  }
}
