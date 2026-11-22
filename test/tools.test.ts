import { describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { describeTable, listTables } from "../src/tools.js";

/** Fake Db that answers by matching a fragment of the SQL text. */
function fakeDb(answers: Array<{ match: string; rows: unknown[] }>): Db {
  return {
    async query(text: string) {
      const found = answers.find((a) => text.includes(a.match));
      if (!found) throw new Error(`Unexpected query: ${text}`);
      return { rows: found.rows as never[] };
    },
  };
}

describe("listTables", () => {
  it("maps rows and converts approx row counts to numbers", async () => {
    const db = fakeDb([
      {
        match: "information_schema.tables",
        rows: [
          { table_schema: "public", table_name: "orders", approx_rows: "20000" },
          { table_schema: "public", table_name: "customers", approx_rows: null },
        ],
      },
    ]);
    const tables = await listTables(db);
    expect(tables).toEqual([
      { schema: "public", table: "orders", approxRows: 20000 },
      { schema: "public", table: "customers", approxRows: null },
    ]);
  });
});

describe("describeTable", () => {
  const db = fakeDb([
    {
      match: "information_schema.columns",
      rows: [
        {
          column_name: "id",
          data_type: "bigint",
          udt_name: "int8",
          is_nullable: "NO",
          column_default: null,
        },
        {
          column_name: "customer_id",
          data_type: "bigint",
          udt_name: "int8",
          is_nullable: "NO",
          column_default: null,
        },
      ],
    },
    {
      match: "pg_indexes",
      rows: [{ indexname: "orders_pkey", indexdef: "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)" }],
    },
    {
      match: "PRIMARY KEY",
      rows: [{ column_name: "id" }],
    },
  ]);

  it("returns columns, indexes and primary key", async () => {
    const desc = await describeTable(db, "orders");
    expect(desc.primaryKey).toEqual(["id"]);
    expect(desc.columns.map((c) => c.name)).toEqual(["id", "customer_id"]);
    expect(desc.indexes).toHaveLength(1);
    // The demo flaw, visible in the data: no index covers customer_id.
    expect(desc.indexes[0].definition).not.toContain("customer_id");
  });

  it("rejects a malicious table name before querying", async () => {
    await expect(describeTable(db, "orders; DROP TABLE orders")).rejects.toThrow();
  });

  it("throws when the table does not exist", async () => {
    const empty = fakeDb([{ match: "information_schema.columns", rows: [] }]);
    await expect(describeTable(empty, "nope")).rejects.toThrow("Table not found");
  });
});
