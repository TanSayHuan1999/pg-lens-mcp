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

// ---------------------------------------------------------------------------
// v0.2 tool — index_health
// ---------------------------------------------------------------------------

/** Minimal index shape the redundant-detection helper reasons about. */
export interface IndexForRedundancy {
  schema: string;
  table: string;
  index: string;
  columns: string[];
  isPrimary: boolean;
  isUnique: boolean;
}

/** True when `shorter` is a left-prefix of `longer` (strictly shorter). */
export function isLeftPrefix(shorter: string[], longer: string[]): boolean {
  if (shorter.length === 0 || shorter.length >= longer.length) return false;
  return shorter.every((col, i) => longer[i] === col);
}

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((col, i) => b[i] === col);
}

/**
 * Find indexes made redundant by another index on the same table.
 *
 * Pure function — no database access — so it can be unit-tested directly.
 *
 * Rules:
 * - Primary-key and unique indexes are never flagged: they enforce
 *   integrity even when another index covers their columns.
 * - An index is redundant when another index on the same table covers
 *   its columns as a left-prefix, e.g. (customer_id) is covered by
 *   (customer_id, status).
 * - Exact duplicates: when two indexes have identical columns, the
 *   later one in the list is flagged (the first is kept). If the
 *   duplicate is a PK/unique index, the plain index is flagged instead
 *   and the PK/unique index is never flagged.
 *
 * Returns a map from redundant index name to the covering index name.
 */
export function findRedundantIndexes(
  indexes: IndexForRedundancy[],
): Map<string, string> {
  const redundant = new Map<string, string>();
  for (const candidate of indexes) {
    if (candidate.isPrimary || candidate.isUnique) continue;
    if (candidate.columns.length === 0) continue;
    for (const other of indexes) {
      if (other.index === candidate.index) continue;
      if (other.schema !== candidate.schema || other.table !== candidate.table) {
        continue;
      }
      if (other.columns.length === 0) continue;

      // Wider index covering this one as a left-prefix.
      if (isLeftPrefix(candidate.columns, other.columns)) {
        redundant.set(candidate.index, other.index);
        break;
      }

      // Exact duplicate: flag only the later occurrence so exactly one
      // of the pair is kept. (If `other` appears earlier, candidate is
      // the later one and is flagged; if `other` appears later, this
      // candidate is the keeper and the loop will flag `other` when
      // it becomes the candidate — unless `other` is PK/unique, in
      // which case candidate is flagged here because the keeper must
      // be the integrity-enforcing index.)
      if (sameColumns(candidate.columns, other.columns)) {
        const candidatePos = indexes.indexOf(candidate);
        const otherPos = indexes.indexOf(other);
        if (otherPos < candidatePos || other.isPrimary || other.isUnique) {
          redundant.set(candidate.index, other.index);
          break;
        }
      }
    }
  }
  return redundant;
}

export type IndexVerdict = "unused" | "redundant" | "ok";

export interface IndexHealthEntry {
  schema: string;
  table: string;
  index: string;
  columns: string[];
  sizeBytes: number;
  idxScan: number;
  isPrimary: boolean;
  isUnique: boolean;
  verdict: IndexVerdict;
  /** For redundant indexes, the name of the index that covers this one. */
  coveredBy?: string;
  reason: string;
  /** Suggestion text only — pg-lens never runs it. */
  suggestion?: string;
}

export interface IndexHealthResult {
  indexes: IndexHealthEntry[];
  summary: {
    totalIndexes: number;
    unusedCount: number;
    redundantCount: number;
    okCount: number;
    wastedBytes: number;
  };
  suggestions: string[];
  note: string;
}

/**
 * Report the health of every index in user schemas: indexes that are
 * never scanned (and do not enforce integrity) and indexes made
 * redundant by a wider composite index on the same table.
 *
 * Suggestions only — pg-lens never drops an index itself.
 */
export async function indexHealth(
  db: Db,
  schema?: string,
): Promise<IndexHealthResult> {
  if (schema !== undefined) assertIdentifier(schema, "schema");

  const { rows } = await db.query<{
    schemaname: string;
    tablename: string;
    indexname: string;
    idx_scan: string | number | null;
    is_primary: boolean;
    is_unique: boolean;
    size_bytes: string | number;
    columns_csv: string | null;
  }>(
    `SELECT n.nspname AS schemaname,
            t.relname AS tablename,
            i.relname AS indexname,
            s.idx_scan,
            ix.indisprimary AS is_primary,
            ix.indisunique AS is_unique,
            pg_relation_size(i.oid) AS size_bytes,
            -- string_agg, not ARRAY(...): the pg driver returns name[]
            -- columns as a raw "{a,b}" string instead of a JS array.
            (
              SELECT string_agg(a.attname::text, ',' ORDER BY k.ord)
                FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
                JOIN pg_attribute a
                  ON a.attrelid = t.oid AND a.attnum = k.attnum
            ) AS columns_csv
       FROM pg_stat_user_indexes s
       JOIN pg_class t ON t.oid = s.relid
       JOIN pg_class i ON i.oid = s.indexrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN pg_index ix ON ix.indexrelid = i.oid
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND ($1::text IS NULL OR n.nspname = $1)
      ORDER BY n.nspname, t.relname, i.relname`,
    [schema ?? null],
  );

  const raw = rows.map((r) => ({
    schema: r.schemaname,
    table: r.tablename,
    index: r.indexname,
    columns: r.columns_csv ? r.columns_csv.split(",") : [],
    sizeBytes: Number(r.size_bytes),
    idxScan: Number(r.idx_scan ?? 0),
    isPrimary: Boolean(r.is_primary),
    isUnique: Boolean(r.is_unique),
  }));

  const redundant = findRedundantIndexes(raw);

  const indexes: IndexHealthEntry[] = raw.map((r) => {
    const coveredBy = redundant.get(r.index);
    let verdict: IndexVerdict = "ok";
    let reason = "Index is used and not covered by any wider index.";
    if (r.isPrimary) {
      reason = "Primary key index — enforces integrity, never flagged.";
    } else if (r.isUnique) {
      reason = "Unique index — enforces integrity, never flagged.";
    } else if (coveredBy) {
      verdict = "redundant";
      reason =
        `Columns (${r.columns.join(", ")}) are a left-prefix of index ${coveredBy} ` +
        `on the same table, so this index adds write cost without adding lookup power.` +
        (r.idxScan === 0 ? " It has also never been scanned." : "");
    } else if (r.idxScan === 0) {
      verdict = "unused";
      reason =
        "Never used for an index scan (idx_scan = 0) and does not enforce " +
        "a primary-key or unique constraint, so it only taxes writes.";
    }

    const suggestion =
      verdict === "ok"
        ? undefined
        : `DROP INDEX CONCURRENTLY ${r.schema}.${r.index}; -- review first: ` +
          `check idx_scan over a representative period and confirm no constraint depends on it`;

    return {
      schema: r.schema,
      table: r.table,
      index: r.index,
      columns: r.columns,
      sizeBytes: r.sizeBytes,
      idxScan: r.idxScan,
      isPrimary: r.isPrimary,
      isUnique: r.isUnique,
      verdict,
      ...(coveredBy ? { coveredBy } : {}),
      reason,
      ...(suggestion ? { suggestion } : {}),
    };
  });

  const unusedCount = indexes.filter((i) => i.verdict === "unused").length;
  const redundantCount = indexes.filter((i) => i.verdict === "redundant").length;
  const okCount = indexes.filter((i) => i.verdict === "ok").length;
  const wastedBytes = indexes
    .filter((i) => i.verdict !== "ok")
    .reduce((sum, i) => sum + i.sizeBytes, 0);

  return {
    indexes,
    summary: {
      totalIndexes: indexes.length,
      unusedCount,
      redundantCount,
      okCount,
      wastedBytes,
    },
    suggestions: indexes
      .map((i) => i.suggestion)
      .filter((s): s is string => s !== undefined),
    note:
      "Suggestions only — pg-lens never drops an index. idx_scan counts " +
      "since the last stats reset, so review over a representative period " +
      "before dropping anything.",
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
