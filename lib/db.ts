import { attachDatabasePool } from "@vercel/functions";
import { Pool, type QueryResultRow } from "pg";

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 5000 });
    // Lets Vercel close idle connections before it suspends the function.
    attachDatabasePool(pool);
  }
  return pool;
}

export async function query<T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
