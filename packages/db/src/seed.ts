import { createDatabase } from "./client.js";

const sql = createDatabase();
const demoAvailability = {
  monday: [{ start: "00:00", end: "24:00" }],
  tuesday: [{ start: "00:00", end: "24:00" }],
  wednesday: [{ start: "00:00", end: "24:00" }],
  thursday: [{ start: "00:00", end: "24:00" }],
  friday: [{ start: "00:00", end: "24:00" }],
  saturday: [{ start: "00:00", end: "24:00" }],
  sunday: [{ start: "00:00", end: "24:00" }],
};

try {
  await sql.begin(async (transaction) => {
    const [organization] = await transaction`
      INSERT INTO organizations (slug, name) VALUES ('acme', 'Acme Revenue')
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;
    const organizationId = String(organization!.id);

    const [pool] = await transaction`
      INSERT INTO routing_pools (organization_id, slug, name)
      VALUES (${organizationId}, 'enterprise-northeast', 'Enterprise Northeast')
      ON CONFLICT (organization_id, slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;
    const poolId = String(pool!.id);

    const repData = [
      ["Ada Chen", "ada@acme.example", "America/New_York", 2],
      ["Marcus Reed", "marcus@acme.example", "America/New_York", 1],
      ["Sofia Patel", "sofia@acme.example", "America/Chicago", 1],
    ] as const;

    for (const [name, email, timezone, weight] of repData) {
      const [rep] = await transaction`
        INSERT INTO reps (
          organization_id, name, email, timezone, weight, availability
        ) VALUES (
          ${organizationId}, ${name}, ${email}, ${timezone}, ${weight},
          ${transaction.json(demoAvailability)}
        )
        ON CONFLICT (organization_id, email) DO UPDATE SET
          name = EXCLUDED.name,
          timezone = EXCLUDED.timezone,
          weight = EXCLUDED.weight,
          availability = EXCLUDED.availability,
          active = true
        RETURNING id
      `;
      await transaction`
        INSERT INTO routing_pool_members (pool_id, rep_id)
        VALUES (${poolId}, ${String(rep!.id)})
        ON CONFLICT DO NOTHING
      `;
      await transaction`
        INSERT INTO assignment_state (pool_id, rep_id)
        VALUES (${poolId}, ${String(rep!.id)})
        ON CONFLICT DO NOTHING
      `;
    }

    await transaction`
      INSERT INTO routing_rules (
        organization_id, name, priority, conditions, pool_id
      ) VALUES (
        ${organizationId},
        'Enterprise Northeast',
        10,
        ${transaction.json({
          "company.employee_count": { gte: 500 },
          "company.state": { in: ["NY", "NJ", "PA", "MA"] },
        })},
        ${poolId}
      )
      ON CONFLICT (organization_id, priority) DO UPDATE SET
        name = EXCLUDED.name,
        conditions = EXCLUDED.conditions,
        pool_id = EXCLUDED.pool_id,
        active = true
    `;
  });
  console.log("Seeded Acme Revenue routing workspace");
} finally {
  await sql.end();
}
