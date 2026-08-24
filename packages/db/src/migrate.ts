import { readFile } from "node:fs/promises";
import { createDatabase } from "./client.js";

const sql = createDatabase();

try {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const name = "001_initial.sql";
  const [applied] =
    await sql`SELECT name FROM schema_migrations WHERE name = ${name}`;
  if (!applied) {
    const migration = await readFile(
      new URL(`../migrations/${name}`, import.meta.url),
      "utf8",
    );
    await sql.begin(async (transaction) => {
      await transaction.unsafe(migration);
      await transaction`INSERT INTO schema_migrations (name) VALUES (${name})`;
    });
    console.log(`Applied ${name}`);
  } else {
    console.log(`${name} already applied`);
  }
} finally {
  await sql.end();
}
