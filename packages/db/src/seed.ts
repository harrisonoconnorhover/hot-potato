import { createDatabase } from "./client.js";

const sql = createDatabase();
const demoOrganizationSlug = (process.env.HOT_POTATO_ORG ?? "acme").trim();
const demoOrganizationName = (
  process.env.HOT_POTATO_ORG_NAME ?? "Acme Revenue"
).trim();
const demoAvailability = {
  monday: [{ start: "09:00", end: "17:00" }],
  tuesday: [{ start: "09:00", end: "17:00" }],
  wednesday: [{ start: "09:00", end: "17:00" }],
  thursday: [{ start: "09:00", end: "17:00" }],
  friday: [{ start: "09:00", end: "17:00" }],
};

try {
  await sql.begin(async (transaction) => {
    const [organization] = await transaction`
      INSERT INTO organizations (slug, name)
      VALUES (${demoOrganizationSlug}, ${demoOrganizationName})
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
      ["Ada Chen", "ada@acme.example", "America/New_York", 2, "ada-chen"],
      [
        "Marcus Reed",
        "marcus@acme.example",
        "America/New_York",
        1,
        "marcus-reed",
      ],
      [
        "Sofia Patel",
        "sofia@acme.example",
        "America/Chicago",
        1,
        "sofia-patel",
      ],
    ] as const;

    for (const [name, email, timezone, weight, schedulingSlug] of repData) {
      const [rep] = await transaction`
        INSERT INTO reps (
          organization_id, name, email, timezone, weight, availability,
          scheduling_slug
        ) VALUES (
          ${organizationId}, ${name}, ${email}, ${timezone}, ${weight},
          ${transaction.json(demoAvailability)}, ${schedulingSlug}
        )
        ON CONFLICT (organization_id, email) DO UPDATE SET
          name = EXCLUDED.name,
          timezone = EXCLUDED.timezone,
          weight = EXCLUDED.weight,
          availability = EXCLUDED.availability,
          scheduling_slug = EXCLUDED.scheduling_slug,
          active = true
        RETURNING id
      `;
      await transaction`
        INSERT INTO meeting_types (
          organization_id, rep_id, slug, title, description,
          duration_minutes, minimum_notice_minutes, booking_window_days,
          conference_provider, reminder_minutes, active
        ) VALUES (
          ${organizationId}, ${String(rep!.id)}, ${schedulingSlug},
          ${`${name} introduction`}, 'Pick a time that works for you.',
          30, 60, 14, 'none', 1440, true
        )
        ON CONFLICT (organization_id, slug) DO NOTHING
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

    const [poolMeetingType] = await transaction`
      INSERT INTO meeting_types (
        organization_id, pool_id, slug, title, description, duration_minutes,
        minimum_notice_minutes, booking_window_days, conference_provider,
        reminder_minutes
      ) VALUES (
        ${organizationId}, ${poolId}, 'enterprise-intro', 'Enterprise introduction',
        'Meet the right representative for your team.', 30, 60, 14, 'none', 1440
      )
      ON CONFLICT (organization_id, slug) DO UPDATE SET
        pool_id = EXCLUDED.pool_id,
        rep_id = null,
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        active = true,
        updated_at = now()
      RETURNING id
    `;

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

    const routerQuestions = [
      {
        field: "company.employee_count",
        label: "How many people work at your company?",
        type: "number",
        required: true,
        placeholder: "500",
        helpText: "An estimate is fine.",
        options: [],
      },
      {
        field: "company.state",
        label: "Where is your company headquartered?",
        type: "select",
        required: true,
        placeholder: "Choose a state",
        helpText: "This helps us introduce the right regional team.",
        options: ["NY", "NJ", "PA", "MA"],
      },
    ];
    const [routerLink] = await transaction`
      WITH inserted AS (
        INSERT INTO router_links (
          organization_id, name, slug, title, description, button_label,
          no_match_message, accent_color, questions, active
        ) VALUES (
          ${organizationId}, 'Enterprise Smart Router', 'enterprise-router',
          'Meet your enterprise specialist',
          'Tell us a little about your company and book directly with the right team.',
          'Find my best time',
          'Thanks — we will review your details and follow up with the right next step.',
          '#f97316', ${transaction.json(routerQuestions)}, false
        )
        ON CONFLICT (organization_id, slug) DO NOTHING
        RETURNING id
      )
      SELECT id FROM inserted
      UNION ALL
      SELECT id FROM router_links
      WHERE organization_id = ${organizationId} AND slug = 'enterprise-router'
      LIMIT 1
    `;
    await transaction`
      INSERT INTO router_link_destinations (
        router_link_id, pool_id, meeting_type_id
      ) VALUES (
        ${String(routerLink!.id)}, ${poolId}, ${String(poolMeetingType!.id)}
      )
      ON CONFLICT (router_link_id, pool_id) DO NOTHING
    `;
  });
  console.log(`Seeded demo routing workspace: ${demoOrganizationSlug}`);
} finally {
  await sql.end();
}
