import type { Db } from "./db.js";
import { assertIdentifier } from "./sql-guard.js";

export interface TableSummary {
  schema: string;
  table: string;
  approxRows: number | null;
}

export async function listTables(db: Db, schema?: string): Promise<TableSummary[]> {
  const { rows } = await db.query<{
    table_schema: string;
    table_name: string;
    approx_rows: string | number | null;
  }>(
    `SELECT t.table_schema, t.table_name, c.reltuples::bigint AS approx_rows
       FROM information_schema.tables t
       JOIN pg_namespace n ON n.nspname = t.table_schema
       JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = t.table_name
      WHERE t.table_type = 'BASE TABLE'
        AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
        AND ($1::text IS NULL OR t.table_schema = $1)
      ORDER BY t.table_schema, t.table_name`,
    [schema ?? null],
  );
  return rows.map((r) => ({
    schema: r.table_schema,
    table: r.table_name,
    approxRows: r.approx_rows === null ? null : Number(r.approx_rows),
  }));
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
}

export interface IndexInfo {
  name: string;
  definition: string;
}

export interface TableDescription {
  schema: string;
  table: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  primaryKey: string[];
}

export async function describeTable(
  db: Db,
  table: string,
  schema = "public",
): Promise<TableDescription> {
  assertIdentifier(schema, "schema");
  assertIdentifier(table, "table");

  const columns = await db.query<{
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT column_name, data_type, udt_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [schema, table],
  );

  if (columns.rows.length === 0) {
    throw new Error(`Table not found: ${schema}.${table}`);
  }

  const indexes = await db.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = $1 AND tablename = $2
      ORDER BY indexname`,
    [schema, table],
  );

  const pk = await db.query<{ column_name: string }>(
    `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
      WHERE tc.table_schema = $1 AND tc.table_name = $2
        AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY kcu.ordinal_position`,
    [schema, table],
  );

  return {
    schema,
    table,
    columns: columns.rows.map((c) => ({
      name: c.column_name,
      type: c.data_type === "USER-DEFINED" ? c.udt_name : c.data_type,
      nullable: c.is_nullable === "YES",
      default: c.column_default,
    })),
    indexes: indexes.rows.map((i) => ({ name: i.indexname, definition: i.indexdef })),
    primaryKey: pk.rows.map((r) => r.column_name),
  };
}
