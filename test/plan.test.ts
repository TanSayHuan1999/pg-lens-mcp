import { describe, expect, it } from "vitest";
import {
  buildIndexSuggestion,
  extractConditionColumns,
  findSeqScans,
  flattenPlan,
  indexAlreadyCovers,
  seqScanCandidateColumns,
  summarizePlan,
  type Plan,
} from "../src/plan.js";

// Fixtures are trimmed copies of real EXPLAIN (FORMAT JSON) output from
// the seeded shop database (PostgreSQL 16).
const seqScanPlan: Plan = {
  Plan: {
    "Node Type": "Seq Scan",
    "Relation Name": "orders",
    Alias: "orders",
    "Total Cost": 417.0,
    "Plan Rows": 100,
    Filter: "(customer_id = 42)",
  },
};

const joinPlan: Plan = {
  Plan: {
    "Node Type": "Hash Join",
    "Total Cost": 426.12,
    "Plan Rows": 100,
    "Hash Cond": "(o.customer_id = c.id)",
    Plans: [
      {
        "Node Type": "Seq Scan",
        "Relation Name": "orders",
        Alias: "o",
        "Total Cost": 367.0,
        "Plan Rows": 20000,
      },
      {
        "Node Type": "Hash",
        "Total Cost": 5.5,
        "Plan Rows": 1,
        Plans: [
          {
            "Node Type": "Index Scan",
            "Relation Name": "customers",
            Alias: "c",
            "Index Name": "customers_email_key",
            "Total Cost": 8.3,
            "Plan Rows": 1,
          },
        ],
      },
    ],
  },
};

describe("flattenPlan / findSeqScans", () => {
  it("flattens a nested join plan", () => {
    expect(flattenPlan(joinPlan.Plan).map((n) => n["Node Type"])).toEqual([
      "Hash Join",
      "Seq Scan",
      "Hash",
      "Index Scan",
    ]);
  });

  it("finds seq scans with their relation", () => {
    const scans = findSeqScans(flattenPlan(joinPlan.Plan));
    expect(scans).toHaveLength(1);
    expect(scans[0]["Relation Name"]).toBe("orders");
  });
});

describe("extractConditionColumns", () => {
  it("reads a simple equality filter", () => {
    expect(extractConditionColumns("(customer_id = 42)")).toEqual(["customer_id"]);
  });

  it("reads both sides of a join condition, stripping qualifiers", () => {
    expect(extractConditionColumns("(o.customer_id = c.id)")).toEqual(
      expect.arrayContaining(["customer_id", "id"]),
    );
  });

  it("handles casted text comparisons", () => {
    expect(extractConditionColumns("((status)::text = 'paid'::text)")).toEqual(["status"]);
  });

  it("returns nothing for undefined", () => {
    expect(extractConditionColumns(undefined)).toEqual([]);
  });
});

describe("seqScanCandidateColumns + buildIndexSuggestion", () => {
  it("suggests an index on the filtered column", () => {
    const node = seqScanPlan.Plan;
    const columns = seqScanCandidateColumns(node);
    expect(columns).toEqual(["customer_id"]);
    const suggestion = buildIndexSuggestion({
      schema: "public",
      table: "orders",
      columns,
      planRows: node["Plan Rows"],
      totalCost: node["Total Cost"],
    });
    expect(suggestion.createIndexSql).toBe(
      "CREATE INDEX idx_orders_customer_id ON public.orders (customer_id);",
    );
    expect(suggestion.reasoning).toContain("Sequential scan on public.orders");
  });

  it("a join seq scan with no filter yields no candidates (full-table read)", () => {
    const ordersScan = flattenPlan(joinPlan.Plan)[1];
    expect(seqScanCandidateColumns(ordersScan)).toEqual([]);
  });
});

describe("indexAlreadyCovers", () => {
  it("detects an existing leading-column index", () => {
    expect(
      indexAlreadyCovers(
        "CREATE INDEX idx_orders_customer_id ON public.orders USING btree (customer_id)",
        ["customer_id"],
      ),
    ).toBe(true);
  });

  it("does not match a different column", () => {
    expect(
      indexAlreadyCovers(
        "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)",
        ["customer_id"],
      ),
    ).toBe(false);
  });
});

describe("summarizePlan", () => {
  it("summarises the seq scan plan", () => {
    const summary = summarizePlan(seqScanPlan);
    expect(summary.totalCost).toBe(417.0);
    expect(summary.seqScans).toEqual([
      { table: "orders", schema: "public", filter: "(customer_id = 42)" },
    ]);
    expect(summary.indexScans).toEqual([]);
  });

  it("summarises index scans in the join plan", () => {
    const summary = summarizePlan(joinPlan);
    expect(summary.indexScans).toEqual([
      { table: "customers", indexName: "customers_email_key" },
    ]);
  });

  it("reports a Bitmap Index Scan under its parent heap scan's table", () => {
    // Real shape from Postgres 16 after the suggested index is applied:
    // the Bitmap Index Scan node has an Index Name but no Relation Name.
    const bitmapPlan: Plan = {
      Plan: {
        "Node Type": "Bitmap Heap Scan",
        "Relation Name": "orders",
        "Total Cost": 157.46,
        "Plan Rows": 100,
        Plans: [
          {
            "Node Type": "Bitmap Index Scan",
            "Index Name": "idx_orders_customer_id",
            "Total Cost": 5.04,
            "Plan Rows": 100,
          },
        ],
      },
    };
    const summary = summarizePlan(bitmapPlan);
    expect(summary.seqScans).toEqual([]);
    expect(summary.indexScans).toEqual([
      { table: "orders", indexName: "idx_orders_customer_id" },
    ]);
  });
});
