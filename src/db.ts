import { Pool, type PoolClient } from "pg";

/** Minimal query interface, so tools can be unit-tested with a fake client. */
export interface Db {
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 4 });
}

/**
 * Run `fn` inside a READ ONLY transaction with a statement timeout.
 * This is the second layer of the read-only defence (after sql-guard.ts):
 * even if a statement slipped past the guard, Postgres itself refuses
 * any write inside this transaction.
 */
export async function withReadOnly<T>(
  pool: Pool,
  fn: (db: Db) => Promise<T>,
  statementTimeoutMs = 5000,
): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
    const db: Db = {
      query: async (text, params) => {
        const result = await client.query(text, params as never[]);
        return { rows: result.rows as never[] };
      },
    };
    const result = await fn(db);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
