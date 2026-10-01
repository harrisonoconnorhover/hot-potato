import { createDatabase } from "./client.js";
import {
  hashOperatorPassword,
  verifyOperatorPassword,
} from "./operator-auth.js";

const organizationSlug = (process.env.HOT_POTATO_ORG ?? "acme").trim();
const organizationName = (
  process.env.HOT_POTATO_ORG_NAME ?? "Hot Potato Workspace"
).trim();
const adminLogin = (process.env.HOT_POTATO_ADMIN_USER ?? "").trim();
const adminName =
  process.env.HOT_POTATO_ADMIN_NAME?.trim() || adminLogin || "Hot Potato owner";
const adminPassword = process.env.HOT_POTATO_ADMIN_PASSWORD ?? "";
const adminPasswordResetRequested = ["1", "true", "yes"].includes(
  (process.env.HOT_POTATO_RESET_ADMIN_PASSWORD ?? "").trim().toLowerCase(),
);

if (
  !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(organizationSlug) ||
  organizationSlug.length > 80
) {
  throw new Error(
    "HOT_POTATO_ORG must be a lowercase slug using letters, numbers, and hyphens.",
  );
}
if (!adminLogin || !adminPassword) {
  throw new Error(
    "Set both HOT_POTATO_ADMIN_USER and HOT_POTATO_ADMIN_PASSWORD before bootstrap.",
  );
}
if (
  adminLogin &&
  (adminLogin.length < 3 ||
    adminLogin.length > 254 ||
    /[\u0000-\u001f\u007f]/.test(adminLogin))
) {
  throw new Error("HOT_POTATO_ADMIN_USER must be 3–254 printable characters.");
}
if (
  adminLogin &&
  (adminName.length < 1 ||
    adminName.length > 120 ||
    /[\u0000-\u001f\u007f]/.test(adminName))
) {
  throw new Error("HOT_POTATO_ADMIN_NAME must be 1–120 printable characters.");
}
if (
  organizationName.length < 1 ||
  organizationName.length > 120 ||
  /[\u0000-\u001f\u007f]/.test(organizationName)
) {
  throw new Error("HOT_POTATO_ORG_NAME must be 1–120 printable characters.");
}

const sql = createDatabase();

try {
  const result = await sql.begin(async (transaction) => {
    const [created] = await transaction`
      INSERT INTO organizations (slug, name)
      VALUES (${organizationSlug}, ${organizationName})
      ON CONFLICT (slug) DO NOTHING
      RETURNING id
    `;
    const [organization] = await transaction`
      SELECT id FROM organizations WHERE slug = ${organizationSlug}
    `;
    if (!organization) throw new Error("The workspace could not be loaded.");
    const [existing] = await transaction`
      SELECT id, password_hash
      FROM operator_accounts
      WHERE login_normalized = ${adminLogin.toLowerCase()}
    `;
    let passwordHash = existing?.passwordHash
      ? String(existing.passwordHash)
      : null;
    let ownerState: "ready" | "password_reset" = "ready";
    if (!passwordHash) {
      passwordHash = await hashOperatorPassword(adminPassword);
    } else if (adminPasswordResetRequested) {
      if (!(await verifyOperatorPassword(adminPassword, passwordHash))) {
        passwordHash = await hashOperatorPassword(adminPassword);
      }
      ownerState = "password_reset";
    }
    const [account] = await transaction`
      INSERT INTO operator_accounts (
        login, display_name, password_hash, active
      ) VALUES (${adminLogin}, ${adminName}, ${passwordHash}, true)
      ON CONFLICT (login_normalized) DO UPDATE
      SET login = EXCLUDED.login,
          display_name = EXCLUDED.display_name,
          password_hash = EXCLUDED.password_hash,
          active = true,
          updated_at = now()
      RETURNING id
    `;
    if (!account) throw new Error("The owner account could not be loaded.");
    await transaction`
      INSERT INTO organization_memberships (
        organization_id, operator_id, role
      ) VALUES (${organization.id}, ${account.id}, 'owner')
      ON CONFLICT (organization_id, operator_id) DO UPDATE
      SET role = CASE
            WHEN ${adminPasswordResetRequested} THEN 'owner'
            ELSE organization_memberships.role
          END,
          active = CASE
            WHEN ${adminPasswordResetRequested} THEN true
            ELSE organization_memberships.active
          END,
          updated_at = CASE
            WHEN ${adminPasswordResetRequested} THEN now()
            ELSE organization_memberships.updated_at
          END
    `;
    if (ownerState === "password_reset") {
      await transaction`
        UPDATE operator_sessions
        SET revoked_at = COALESCE(revoked_at, now())
        WHERE operator_id = ${account.id} AND revoked_at IS NULL
      `;
    }
    return { created: Boolean(created), ownerState };
  });
  console.log(
    result.created
      ? `Created empty Hot Potato workspace: ${organizationSlug}`
      : `Hot Potato workspace ready: ${organizationSlug}`,
  );
  console.log(
    result.ownerState === "password_reset"
      ? `Reset Hot Potato owner login and revoked its sessions: ${adminLogin}`
      : `Hot Potato owner login ready: ${adminLogin}`,
  );
} finally {
  await sql.end();
}
