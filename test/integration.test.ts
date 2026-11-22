import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { withReadOnly } from "../src/db.js";
import { explainQuery, listTables, suggestIndexes, tableStats } from "../src/tools.js";

/**
 * Integration tests against a real seeded Postgres.
 * Skipped unless DATABASE_URL is set — in CI a Postgres service provides
 * it (see .github/workflows/ci.yml); locally, `docker compose up -d`
 * plus the DATABASE_URL from .env.example does the same job.
 */
const url = process.env.DATABASE_URL;

describe.skipIf(!url)("integration — seeded shop database", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: url });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("lists the four shop tables", async () => {
    const tables = await withReadOnly(pool, (db) => listTables(db));
    expect(tables.map((t) => t.table).sort()).toEqual([
      "customers",
      "order_items",
      "orders",
      "products",
    ]);
  });

  it("explains orders-by-customer as a sequential scan", async () => {
    const result = await withReadOnly(pool, (db) =>
      explainQuery(db, "SELECT * FROM orders WHERE customer_id = 42"),
    );
    expect(result.summary.seqScans.map((s) => s.table)).toContain("orders");
  });

  it("suggests an index on orders.customer_id", async () => {
    const result = await withReadOnly(pool, (db) =>
      suggestIndexes(db, "SELECT * FROM orders WHERE customer_id = 42"),
    );
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].createIndexSql).toContain(
      "ON public.orders (customer_id)",
    );
  });

  it("rejects a write query at the guard", async () => {
    await expect(
      withReadOnly(pool, (db) => explainQuery(db, "DELETE FROM orders")),
    ).rejects.toThrow();
  });

  it("reports stats for orders", async () => {
    const stats = await withReadOnly(pool, (db) => tableStats(db, "orders"));
    expect(stats.liveRows).toBeGreaterThan(0);
    expect(stats.totalSizeBytes).toBeGreaterThan(stats.indexesSizeBytes);
  });
});
