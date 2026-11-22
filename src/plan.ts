/**
 * EXPLAIN plan parsing — pure functions, no database access.
 *
 * Postgres EXPLAIN (FORMAT JSON) returns a tree of plan nodes. These
 * helpers flatten the tree and extract the signals pg-lens reasons
 * about: sequential scans, the columns they filter/join on, costs.
 */

export interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Schema"?: string;
  "Alias"?: string;
  "Total Cost"?: number;
  "Plan Rows"?: number;
  "Plan Width"?: number;
  Filter?: string;
  "Hash Cond"?: string;
  "Merge Cond"?: string;
  "Index Cond"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
  [key: string]: unknown;
}

export interface Plan {
  Plan: PlanNode;
  "Planning Time"?: number;
  "Execution Time"?: number;
}

/** Flatten a plan tree into a list of nodes, parents before children. */
export function flattenPlan(node: PlanNode): PlanNode[] {
  const out: PlanNode[] = [node];
  for (const child of node.Plans ?? []) {
    out.push(...flattenPlan(child));
  }
  return out;
}

export function findSeqScans(nodes: PlanNode[]): PlanNode[] {
  return nodes.filter((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"]);
}

const IDENTIFIER = "[A-Za-z_][A-Za-z0-9_]*";

/**
 * Extract candidate index columns from a condition string such as
 * "(customer_id = 42)", "(o.customer_id = c.id)", or
 * "((status)::text = 'paid'::text) AND (created_at > now())".
 *
 * Heuristic, deliberately simple for v1: an identifier that appears on
 * the left of a comparison, or either side of an equality join.
 * Table qualifiers (o.customer_id) are stripped to the column name.
 */
export function extractConditionColumns(condition: string | undefined): string[] {
  if (!condition) return [];
  const columns = new Set<string>();

  // Strip casts first: "(status)::text = 'paid'::text" becomes
  // "(status) = 'paid'", which the patterns below can read.
  const cleaned = condition.replace(/:: *[A-Za-z_][A-Za-z0-9_]*/g, "");

  // left-hand identifier of any comparison:  col = / < / > / <= / >= / <>
  const comparison = new RegExp(
    `\\(?\\s*(?:${IDENTIFIER}\\.)?(${IDENTIFIER})\\s*\\)*\\s*(?:=|<>|!=|<=|>=|<|>)`,
    "g",
  );
  for (const match of cleaned.matchAll(comparison)) {
    columns.add(match[1]);
  }

  // right-hand identifier of an equality (join side):  = other.col
  const joinSide = new RegExp(`=\\s*(?:${IDENTIFIER}\\.)?(${IDENTIFIER})\\b`, "g");
  for (const match of cleaned.matchAll(joinSide)) {
    columns.add(match[1]);
  }

  // Never suggest indexing a literal-ish or expression word that slipped in.
  for (const bad of ["text", "integer", "bigint", "boolean", "now"]) {
    columns.delete(bad);
  }
  return [...columns];
}

/** Columns a seq-scan node filters or joins on — the index candidates. */
export function seqScanCandidateColumns(node: PlanNode): string[] {
  const columns = new Set<string>();
  for (const cond of [node.Filter, node["Hash Cond"], node["Merge Cond"]]) {
    for (const col of extractConditionColumns(cond)) columns.add(col);
  }
  return [...columns];
}

export interface IndexSuggestion {
  table: string;
  schema: string;
  columns: string[];
  createIndexSql: string;
  reasoning: string;
}

export function buildIndexSuggestion(args: {
  schema: string;
  table: string;
  columns: string[];
  planRows?: number;
  totalCost?: number;
}): IndexSuggestion {
  const { schema, table, columns } = args;
  const indexName = `idx_${table}_${columns.join("_")}`;
  return {
    table,
    schema,
    columns,
    createIndexSql: `CREATE INDEX ${indexName} ON ${schema}.${table} (${columns.join(", ")});`,
    reasoning:
      `Sequential scan on ${schema}.${table}` +
      (args.planRows !== undefined ? ` scanning ~${args.planRows} rows` : "") +
      (args.totalCost !== undefined ? ` at cost ${args.totalCost}` : "") +
      `, filtered/joined on ${columns.join(", ")}. ` +
      `An index on (${columns.join(", ")}) should let Postgres use an index scan instead.`,
  };
}

/** True when an existing index definition already starts with these columns. */
export function indexAlreadyCovers(indexDefinition: string, columns: string[]): boolean {
  const match = indexDefinition.match(/\(([^)]+)\)/);
  if (!match) return false;
  const indexed = match[1].split(",").map((c) => c.trim().replace(/"/g, ""));
  return columns.every((col, i) => indexed[i] === col);
}

export interface PlanSummary {
  totalCost: number | null;
  planRows: number | null;
  nodeTypes: string[];
  seqScans: Array<{ table: string; schema: string; filter?: string }>;
  indexScans: Array<{ table: string; indexName?: string }>;
}

export function summarizePlan(plan: Plan): PlanSummary {
  const nodes = flattenPlan(plan.Plan);

  // A Bitmap Index Scan node carries the Index Name but no Relation Name —
  // its table is the parent Bitmap Heap Scan's relation. Walk the tree
  // carrying the nearest ancestor relation so those scans are reported too.
  const indexScans: PlanSummary["indexScans"] = [];
  const walk = (node: PlanNode, ancestorRelation?: string) => {
    const relation = node["Relation Name"] ?? ancestorRelation;
    if (node["Node Type"].includes("Index") && node["Index Name"]) {
      indexScans.push({ table: relation ?? "unknown", indexName: node["Index Name"] });
    }
    for (const child of node.Plans ?? []) walk(child, relation);
  };
  walk(plan.Plan);

  return {
    totalCost: plan.Plan["Total Cost"] ?? null,
    planRows: plan.Plan["Plan Rows"] ?? null,
    nodeTypes: nodes.map((n) => n["Node Type"]),
    seqScans: findSeqScans(nodes).map((n) => ({
      table: n["Relation Name"] as string,
      schema: n["Schema"] ?? "public",
      filter: n.Filter,
    })),
    indexScans,
  };
}
