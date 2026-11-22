/**
 * SQL guard — the first layer of pg-lens' read-only defence.
 *
 * This is intentionally *not* the only layer: every query also runs inside
 * a READ ONLY transaction with a statement timeout (see db.ts), and the
 * recommended setup is a read-only database user. A text-level guard can
 * be tricked in principle; layered defences are the real design.
 *
 * Rules:
 *  - a single statement only (no stacked `;` statements)
 *  - must start with SELECT, WITH, or EXPLAIN
 *  - EXPLAIN ANALYZE is rejected — plain EXPLAIN only *plans* a query,
 *    EXPLAIN ANALYZE actually *executes* it
 *  - write / DDL keywords are rejected anywhere as whole words
 *  - SELECT ... INTO is rejected (it creates a table)
 */

const BLOCKED_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "merge",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "copy",
  "call",
  "do",
  "vacuum",
  "reindex",
  "cluster",
  "comment",
  "security",
  "into",
] as const;

export class SqlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlGuardError";
  }
}

/** Remove -- line comments and /* block comments so they cannot hide keywords. */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

export function assertReadOnlyQuery(rawSql: string): string {
  if (typeof rawSql !== "string" || rawSql.trim().length === 0) {
    throw new SqlGuardError("Query is empty.");
  }

  const sql = stripComments(rawSql).trim().replace(/;+\s*$/, "");

  if (sql.includes(";")) {
    throw new SqlGuardError("Only a single statement is allowed.");
  }

  const firstWord = sql.match(/^[A-Za-z]+/)?.[0]?.toLowerCase();
  if (firstWord !== "select" && firstWord !== "with" && firstWord !== "explain") {
    throw new SqlGuardError(
      `Only SELECT, WITH, or EXPLAIN statements are allowed (got "${firstWord ?? "unknown"}").`,
    );
  }

  const words = new Set(sql.toLowerCase().match(/[a-z_]+/g) ?? []);

  if (firstWord === "explain" && words.has("analyze")) {
    throw new SqlGuardError(
      "EXPLAIN ANALYZE is not allowed — it executes the query. Use plain EXPLAIN.",
    );
  }

  for (const keyword of BLOCKED_KEYWORDS) {
    if (words.has(keyword)) {
      throw new SqlGuardError(`Blocked keyword in query: ${keyword.toUpperCase()}.`);
    }
  }

  return sql;
}

/** Validate a schema/table identifier before it is used as a query parameter name check. */
const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertIdentifier(value: string, kind: string): string {
  if (!IDENTIFIER_RE.test(value)) {
    throw new SqlGuardError(`Invalid ${kind} name: "${value}".`);
  }
  return value;
}
