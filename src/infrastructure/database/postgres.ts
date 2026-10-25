import pg from "pg";

const { Pool } = pg;

const databaseUrl = Deno.env.get("DATABASE_URL");

if (!databaseUrl) {
  console.error("DATABASE_URL env var not found");
}

export const pool = new Pool({
  connectionString: databaseUrl,
});

export type QueryResultRow = Record<string, unknown>;

export async function query<T extends QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, params);
  return result.rows;
}

