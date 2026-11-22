import type { Db } from "./db.js";
import { assertIdentifier, assertReadOnlyQuery } from "./sql-guard.js";
import {
  buildIndexSuggestion,
  findSeqScans,
  flattenPlan,
  indexAlreadyCovers,
  seqScanCandidateColumns,
  summarizePlan,
  type IndexSuggestion,
  type Plan,
  type PlanSummary,
} from "./plan.js";

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

// ---------------------------------------------------------------------------
// Evening 2 tools
// ---------------------------------------------------------------------------

export interface ExplainResult {
  query: string;
  summary: PlanSummary;
  plan: Plan;
}

/** Run EXPLAIN (FORMAT JSON) for a SELECT/WITH query. Never executes it. */
export async function explainQuery(db: Db, rawSql: string): Promise<ExplainResult> {
  const sql = assertReadOnlyQuery(rawSql);
  const firstWord = sql.match(/^[A-Za-z]+/)?.[0]?.toLowerCase();
  if (firstWord === "explain") {
    throw new Error("Pass the SELECT query itself — explain_query adds EXPLAIN for you.");
  }
  const { rows } = await db.query<{ "QUERY PLAN": Plan[] }>(
    `EXPLAIN (FORMAT JSON, COSTS true) ${sql}`,
  );
  const plan = rows[0]?.["QUERY PLAN"]?.[0];
  if (!plan) throw new Error("Postgres returned no plan for this query.");
  return { query: sql, summary: summarizePlan(plan), plan };
}

export interface SuggestResult {
  query: string;
  suggestions: IndexSuggestion[];
  note: string;
}

/**
 * Suggest indexes for a query, from its explain plan.
 * Only *suggests* — pg-lens never creates an index itself.
 */
export async function suggestIndexes(db: Db, rawSql: string): Promise<SuggestResult> {
  const { plan } = await explainQuery(db, rawSql);
  const nodes = flattenPlan(plan.Plan);
  const seqScans = findSeqScans(nodes);

  if (seqScans.length === 0) {
    return {
      query: rawSql,
      suggestions: [],
      note: "No sequential scans in the plan — no index suggestion from the v1 heuristic.",
    };
  }

  const suggestions: IndexSuggestion[] = [];
  const skipped: string[] = [];

  for (const scan of seqScans) {
    const table = scan["Relation Name"] as string;
    const schema = scan["Schema"] ?? "public";
    const columns = seqScanCandidateColumns(scan);
    if (columns.length === 0) {
      skipped.push(`${schema}.${table} (seq scan with no filter/join columns — a full-table read may be intended)`);
      continue;
    }
    const description = await describeTable(db, table, schema);
    if (description.indexes.some((idx) => indexAlreadyCovers(idx.definition, columns))) {
      skipped.push(`${schema}.${table} (an existing index already covers ${columns.join(", ")})`);
      continue;
    }
    suggestions.push(
      buildIndexSuggestion({
        schema,
        table,
        columns,
        planRows: scan["Plan Rows"],
        totalCost: scan["Total Cost"],
      }),
    );
  }

  return {
    query: rawSql,
    suggestions,
    note:
      suggestions.length > 0
        ? "Suggestions only — pg-lens never applies them. Review before running."
        : `No new suggestion. Skipped: ${skipped.join("; ")}`,
  };
}

export interface TableStats {
  schema: string;
  table: string;
  liveRows: number;
  deadRows: number;
  seqScans: number;
  indexScans: number;
  totalSizeBytes: number;
  tableSizeBytes: number;
  indexesSizeBytes: number;
}

export async function tableStats(db: Db, table: string, schema = "public"): Promise<TableStats> {
  assertIdentifier(schema, "schema");
  assertIdentifier(table, "table");
  const { rows } = await db.query<{
    n_live_tup: string | number;
    n_dead_tup: string | number;
    seq_scan: string | number | null;
    idx_scan: string | number | null;
    total_bytes: string | number;
    table_bytes: string | number;
    index_bytes: string | number;
  }>(
    `SELECT s.n_live_tup, s.n_dead_tup, s.seq_scan, s.idx_scan,
            pg_total_relation_size($3::regclass) AS total_bytes,
            pg_relation_size($3::regclass) AS table_bytes,
            pg_indexes_size($3::regclass) AS index_bytes
       FROM pg_stat_user_tables s
      WHERE s.schemaname = $1 AND s.relname = $2`,
    [schema, table, `${schema}.${table}`],
  );
  const row = rows[0];
  if (!row) throw new Error(`Table not found: ${schema}.${table}`);
  return {
    schema,
    table,
    liveRows: Number(row.n_live_tup),
    deadRows: Number(row.n_dead_tup),
    seqScans: Number(row.seq_scan ?? 0),
    indexScans: Number(row.idx_scan ?? 0),
    totalSizeBytes: Number(row.total_bytes),
    tableSizeBytes: Number(row.table_bytes),
    indexesSizeBytes: Number(row.index_bytes),
  };
}
