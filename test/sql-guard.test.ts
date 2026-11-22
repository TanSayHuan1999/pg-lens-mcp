import { describe, expect, it } from "vitest";
import { assertIdentifier, assertReadOnlyQuery, SqlGuardError } from "../src/sql-guard.js";

describe("assertReadOnlyQuery — allowed", () => {
  it("allows a plain SELECT", () => {
    expect(assertReadOnlyQuery("SELECT * FROM orders")).toBe("SELECT * FROM orders");
  });

  it("allows a WITH ... SELECT", () => {
    const sql = "WITH t AS (SELECT 1 AS x) SELECT * FROM t";
    expect(assertReadOnlyQuery(sql)).toBe(sql);
  });

  it("allows plain EXPLAIN of a SELECT", () => {
    const sql = "EXPLAIN (FORMAT JSON) SELECT * FROM orders WHERE customer_id = 1";
    expect(assertReadOnlyQuery(sql)).toBe(sql);
  });

  it("strips a trailing semicolon", () => {
    expect(assertReadOnlyQuery("SELECT 1;")).toBe("SELECT 1");
  });

  it("strips comments, so a blocked word inside a comment is inert", () => {
    expect(assertReadOnlyQuery("SELECT 1 /* DROP TABLE orders */")).toBe("SELECT 1");
  });

  it("does not block words that merely contain a keyword (e.g. updated_at)", () => {
    expect(assertReadOnlyQuery("SELECT updated_at, deleted_at FROM orders")).toContain(
      "updated_at",
    );
  });
});

describe("assertReadOnlyQuery — rejected", () => {
  const rejected: Array<[string, string]> = [
    ["INSERT", "INSERT INTO orders VALUES (1)"],
    ["UPDATE", "UPDATE orders SET status = 'x'"],
    ["DELETE", "DELETE FROM orders"],
    ["DROP", "DROP TABLE orders"],
    ["ALTER", "ALTER TABLE orders ADD COLUMN x int"],
    ["CREATE", "CREATE TABLE t (id int)"],
    ["TRUNCATE", "TRUNCATE orders"],
    ["GRANT", "GRANT ALL ON orders TO public"],
    ["SELECT INTO", "SELECT * INTO copy_of_orders FROM orders"],
    ["stacked statements", "SELECT 1; DROP TABLE orders"],
    ["EXPLAIN ANALYZE", "EXPLAIN ANALYZE SELECT * FROM orders"],
    ["empty", "   "],
  ];

  it.each(rejected)("rejects %s", (_label, sql) => {
    expect(() => assertReadOnlyQuery(sql)).toThrow(SqlGuardError);
  });
});

describe("assertIdentifier", () => {
  it("accepts normal identifiers", () => {
    expect(assertIdentifier("orders", "table")).toBe("orders");
    expect(assertIdentifier("order_items2", "table")).toBe("order_items2");
  });

  it("rejects injection attempts", () => {
    expect(() => assertIdentifier("orders; DROP TABLE orders", "table")).toThrow(
      SqlGuardError,
    );
    expect(() => assertIdentifier("orders--", "table")).toThrow(SqlGuardError);
  });
});
