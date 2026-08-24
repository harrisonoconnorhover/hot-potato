import postgres, { type Sql } from "postgres";

const defaultUrl = "postgres://hotpotato:hotpotato@localhost:5432/hotpotato";

export function createDatabase(
  url = process.env.DATABASE_URL ?? defaultUrl,
): Sql {
  return postgres(url, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    transform: { column: postgres.camel.column },
  });
}
