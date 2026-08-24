import { readdir, readFile } from "node:fs/promises";
import { createDatabase } from "./client.js";

const sql = createDatabase();
const migrationsUrl = new URL("../migrations/", import.meta.url);

try {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const migrations = (await readdir(migrationsUrl))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();

  for (const name of migrations) {
    const [applied] =
      await sql`SELECT name FROM schema_migrations WHERE name = ${name}`;
    if (applied) {
      console.log(`${name} already applied`);
      continue;
    }

    const migration = await readFile(new URL(name, migrationsUrl), "utf8");
    await sql.begin(async (transaction) => {
      await transaction.unsafe(migration);
      await transaction`INSERT INTO schema_migrations (name) VALUES (${name})`;
    });
    console.log(`Applied ${name}`);
  }
} finally {
  await sql.end();
}
