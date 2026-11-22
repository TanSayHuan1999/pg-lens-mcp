import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { withReadOnly } from "../src/db.js";
import {
  explainQuery,
  indexHealth,
  listTables,
  suggestIndexes,
  tableStats,
} from "../src/tools.js";

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

  // Runs last in this file: it creates indexes on orders, which would
  // change the explain/suggest results above. Cleanup is in `finally`
  // so the seeded flaw (no index on orders.customer_id) is restored.
  it("index_health flags unused and redundant indexes, never PK/unique", async () => {
    await pool.query(
      "CREATE INDEX idx_orders_status_unused_test ON orders(status)",
    );
    await pool.query(
      "CREATE INDEX idx_orders_customer_test ON orders(customer_id)",
    );
    await pool.query(
      "CREATE INDEX idx_orders_customer_status_test ON orders(customer_id, status)",
    );
    try {
      const result = await withReadOnly(pool, (db) => indexHealth(db));
      const byName = new Map(result.indexes.map((i) => [i.index, i]));

      expect(byName.get("idx_orders_status_unused_test")?.verdict).toBe("unused");

      const redundant = byName.get("idx_orders_customer_test");
      expect(redundant?.verdict).toBe("redundant");
      expect(redundant?.coveredBy).toBe("idx_orders_customer_status_test");
      expect(redundant?.suggestion).toContain("DROP INDEX CONCURRENTLY");

      // Integrity indexes are never flagged, even with idx_scan = 0.
      expect(byName.get("orders_pkey")?.verdict).toBe("ok");
      expect(byName.get("customers_email_key")?.verdict).toBe("ok");
      expect(byName.get("orders_pkey")?.suggestion).toBeUndefined();

      expect(result.summary.unusedCount).toBeGreaterThanOrEqual(1);
      expect(result.summary.redundantCount).toBeGreaterThanOrEqual(1);
      expect(result.summary.wastedBytes).toBeGreaterThan(0);
    } finally {
      await pool.query("DROP INDEX IF EXISTS idx_orders_status_unused_test");
      await pool.query("DROP INDEX IF EXISTS idx_orders_customer_test");
      await pool.query("DROP INDEX IF EXISTS idx_orders_customer_status_test");
    }
  });
});
