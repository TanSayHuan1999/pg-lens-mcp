import { describe, expect, it } from "vitest";
import {
  findRedundantIndexes,
  indexHealth,
  isLeftPrefix,
  type IndexForRedundancy,
} from "../src/tools.js";
import type { Db } from "../src/db.js";

function idx(
  partial: Partial<IndexForRedundancy> & { index: string; columns: string[] },
): IndexForRedundancy {
  return {
    schema: "public",
    table: "orders",
    isPrimary: false,
    isUnique: false,
    ...partial,
  };
}

describe("isLeftPrefix", () => {
  it("detects a strict left-prefix", () => {
    expect(isLeftPrefix(["customer_id"], ["customer_id", "status"])).toBe(true);
    expect(isLeftPrefix(["a", "b"], ["a", "b", "c"])).toBe(true);
  });

  it("rejects equal length, longer, different order and different columns", () => {
    expect(isLeftPrefix(["a"], ["a"])).toBe(false);
    expect(isLeftPrefix(["a", "b"], ["a"])).toBe(false);
    expect(isLeftPrefix(["b", "a"], ["a", "b", "c"])).toBe(false);
    expect(isLeftPrefix(["status"], ["customer_id", "status"])).toBe(false);
    expect(isLeftPrefix([], ["a"])).toBe(false);
  });
});

describe("findRedundantIndexes", () => {
  it("flags an index covered as a left-prefix by a wider composite", () => {
    const result = findRedundantIndexes([
      idx({ index: "idx_orders_customer_id", columns: ["customer_id"] }),
      idx({ index: "idx_orders_customer_status", columns: ["customer_id", "status"] }),
    ]);
    expect(result.get("idx_orders_customer_id")).toBe("idx_orders_customer_status");
    expect(result.has("idx_orders_customer_status")).toBe(false);
  });

  it("flags an exact duplicate, keeping the first", () => {
    const result = findRedundantIndexes([
      idx({ index: "idx_a", columns: ["customer_id"] }),
      idx({ index: "idx_b", columns: ["customer_id"] }),
    ]);
    expect(result.has("idx_a")).toBe(false);
    expect(result.get("idx_b")).toBe("idx_a");
  });

  it("does not flag non-redundant indexes", () => {
    const result = findRedundantIndexes([
      idx({ index: "idx_customer", columns: ["customer_id"] }),
      idx({ index: "idx_status", columns: ["status"] }),
      idx({ index: "idx_created", columns: ["created_at"] }),
    ]);
    expect(result.size).toBe(0);
  });

  it("does not flag an index when the wider index starts with a different column", () => {
    const result = findRedundantIndexes([
      idx({ index: "idx_status", columns: ["status"] }),
      idx({ index: "idx_customer_status", columns: ["customer_id", "status"] }),
    ]);
    expect(result.size).toBe(0);
  });

  it("never flags a primary key, even when a wider index covers it", () => {
    const result = findRedundantIndexes([
      idx({ index: "orders_pkey", columns: ["id"], isPrimary: true, isUnique: true }),
      idx({ index: "idx_id_status", columns: ["id", "status"] }),
    ]);
    expect(result.has("orders_pkey")).toBe(false);
  });

  it("never flags a unique index, even when a wider index covers it", () => {
    const result = findRedundantIndexes([
      idx({ index: "customers_email_key", columns: ["email"], isUnique: true, table: "customers" }),
      idx({ index: "idx_email_name", columns: ["email", "full_name"], table: "customers" }),
    ]);
    expect(result.has("customers_email_key")).toBe(false);
  });

  it("flags a plain duplicate of a unique index, but not the unique index itself", () => {
    const result = findRedundantIndexes([
      idx({ index: "customers_email_key", columns: ["email"], isUnique: true, table: "customers" }),
      idx({ index: "idx_email_plain", columns: ["email"], table: "customers" }),
    ]);
    expect(result.get("idx_email_plain")).toBe("customers_email_key");
    expect(result.has("customers_email_key")).toBe(false);
  });

  it("does not treat indexes on different tables or schemas as covering", () => {
    const result = findRedundantIndexes([
      idx({ index: "idx_a", columns: ["customer_id"], table: "orders" }),
      idx({
        index: "idx_b",
        columns: ["customer_id", "status"],
        table: "order_items",
      }),
      idx({
        index: "idx_c",
        columns: ["customer_id", "status"],
        table: "orders",
        schema: "archive",
      }),
    ]);
    expect(result.size).toBe(0);
  });

  it("ignores expression indexes with no plain columns", () => {
    const result = findRedundantIndexes([
      idx({ index: "idx_expr", columns: [] }),
      idx({ index: "idx_wide", columns: ["customer_id", "status"] }),
    ]);
    expect(result.size).toBe(0);
  });
});

describe("indexHealth (fake Db)", () => {
  function fakeDb(rows: unknown[]): Db {
    return {
      async query(text: string) {
        if (!text.includes("pg_stat_user_indexes")) {
          throw new Error(`Unexpected query: ${text}`);
        }
        return { rows: rows as never[] };
      },
    };
  }

  it("classifies unused, redundant and ok, and sums wasted bytes", async () => {
    const db = fakeDb([
      {
        schemaname: "public",
        tablename: "orders",
        indexname: "orders_pkey",
        idx_scan: 0,
        is_primary: true,
        is_unique: true,
        size_bytes: 16384,
        columns_csv: "id",
      },
      {
        schemaname: "public",
        tablename: "orders",
        indexname: "idx_never_used",
        idx_scan: 0,
        is_primary: false,
        is_unique: false,
        size_bytes: 8192,
        columns_csv: "status",
      },
      {
        schemaname: "public",
        tablename: "orders",
        indexname: "idx_customer",
        idx_scan: 12,
        is_primary: false,
        is_unique: false,
        size_bytes: 8192,
        columns_csv: "customer_id",
      },
      {
        schemaname: "public",
        tablename: "orders",
        indexname: "idx_customer_status",
        idx_scan: 30,
        is_primary: false,
        is_unique: false,
        size_bytes: 16384,
        columns_csv: "customer_id,status",
      },
    ]);
    const result = await indexHealth(db);
    const byName = new Map(result.indexes.map((i) => [i.index, i]));
    expect(byName.get("orders_pkey")?.verdict).toBe("ok");
    expect(byName.get("idx_never_used")?.verdict).toBe("unused");
    expect(byName.get("idx_customer")?.verdict).toBe("redundant");
    expect(byName.get("idx_customer")?.coveredBy).toBe("idx_customer_status");
    expect(byName.get("idx_customer_status")?.verdict).toBe("ok");
    expect(result.summary).toEqual({
      totalIndexes: 4,
      unusedCount: 1,
      redundantCount: 1,
      okCount: 2,
      wastedBytes: 8192 + 8192,
    });
    // Suggestions are text only, and only for flagged indexes.
    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions.join(" ")).toContain("DROP INDEX CONCURRENTLY");
    expect(byName.get("orders_pkey")?.suggestion).toBeUndefined();
  });

  it("never flags a unique index as unused", async () => {
    const db = fakeDb([
      {
        schemaname: "public",
        tablename: "customers",
        indexname: "customers_email_key",
        idx_scan: 0,
        is_primary: false,
        is_unique: true,
        size_bytes: 8192,
        columns_csv: "email",
      },
    ]);
    const result = await indexHealth(db);
    expect(result.indexes[0].verdict).toBe("ok");
    expect(result.summary.wastedBytes).toBe(0);
  });
});
