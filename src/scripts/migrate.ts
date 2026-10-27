import { pool } from "@/infrastructure/database/postgres.ts";

const migrationsDirectory = new URL("../../migrations/", import.meta.url);
const migrationFiles = [
  "001_initial_schema.sql",
  "002_transcript_evaluation_flow.sql",
  "003_initial_password_rotation.sql",
];

const client = await pool.connect();

try {
  await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");

  for (const version of migrationFiles) {
    await client.query("BEGIN");

    try {
      const applied = await client.query<{ version: string }>(
        "SELECT version FROM schema_migrations WHERE version = $1",
        [version],
      );

      if (applied.rowCount) {
        console.log(`Already applied: ${version}`);
        await client.query("COMMIT");
        continue;
      }

      const sql = await Deno.readTextFile(new URL(version, migrationsDirectory));
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      await client.query("COMMIT");
      console.log(`Applied: ${version}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  client.release();
  await pool.end();
}
