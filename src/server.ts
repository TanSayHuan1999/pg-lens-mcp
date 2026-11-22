import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Pool } from "pg";
import { withReadOnly } from "./db.js";
import {
  describeTable,
  explainQuery,
  indexHealth,
  listTables,
  suggestIndexes,
  tableStats,
} from "./tools.js";

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function errorResult(err: unknown) {
  // Some pg connection failures surface as AggregateError with an empty
  // message — fall back to the error code / string form so the client
  // always gets something actionable.
  let text = err instanceof Error ? err.message : String(err);
  if (!text) {
    const code = (err as { code?: string })?.code;
    text = code ? `Database error (${code})` : String(err);
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text }],
  };
}

/**
 * Build the pg-lens MCP server around a connection pool.
 * Tools: list_tables, describe_table, explain_query, suggest_indexes,
 * table_stats, index_health.
 */
export function createServer(pool: Pool): McpServer {
  const server = new McpServer({ name: "pg-lens-mcp", version: "0.1.0" });

  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description:
        "List the tables in the database (excluding system schemas), with approximate row counts.",
      inputSchema: z.object({
        schema: z
          .string()
          .optional()
          .describe("Only list tables in this schema, e.g. \"public\"."),
      }),
    },
    async ({ schema }) => {
      try {
        const tables = await withReadOnly(pool, (db) => listTables(db, schema));
        return textResult({ tables });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe table",
      description:
        "Describe one table: columns and types, primary key, and existing indexes.",
      inputSchema: z.object({
        table: z.string().describe("Table name, e.g. \"orders\"."),
        schema: z
          .string()
          .optional()
          .describe("Schema name. Defaults to \"public\"."),
      }),
    },
    async ({ table, schema }) => {
      try {
        const description = await withReadOnly(pool, (db) =>
          describeTable(db, table, schema ?? "public"),
        );
        return textResult(description);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "explain_query",
    {
      title: "Explain query",
      description:
        "Run EXPLAIN (FORMAT JSON) for a SELECT query and return a plain summary: total cost, node types, sequential scans, and index scans. The query is planned, never executed, and writes are rejected.",
      inputSchema: z.object({
        query: z
          .string()
          .describe("The SELECT query to explain, e.g. \"SELECT * FROM orders WHERE customer_id = 1\"."),
      }),
    },
    async ({ query }) => {
      try {
        const result = await withReadOnly(pool, (db) => explainQuery(db, query));
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "suggest_indexes",
    {
      title: "Suggest indexes",
      description:
        "Analyse a SELECT query's plan and suggest indexes for sequential scans, with reasoning and the CREATE INDEX statement. Suggestions only — this tool never creates an index.",
      inputSchema: z.object({
        query: z.string().describe("The SELECT query to analyse."),
      }),
    },
    async ({ query }) => {
      try {
        const result = await withReadOnly(pool, (db) => suggestIndexes(db, query));
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "index_health",
    {
      title: "Index health",
      description:
        "Report the health of every index in user schemas: indexes never scanned (excluding primary-key and unique indexes, which enforce integrity) and indexes made redundant by a wider composite index on the same table, with sizes and wasted bytes. Suggestions only — this tool never drops an index.",
      inputSchema: z.object({
        schema: z
          .string()
          .optional()
          .describe("Only check indexes in this schema, e.g. \"public\". Defaults to all user schemas."),
      }),
    },
    async ({ schema }) => {
      try {
        const result = await withReadOnly(pool, (db) => indexHealth(db, schema));
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "table_stats",
    {
      title: "Table stats",
      description:
        "Statistics for one table: live/dead rows, sequential vs index scan counts, and table/index sizes.",
      inputSchema: z.object({
        table: z.string().describe("Table name, e.g. \"orders\"."),
        schema: z.string().optional().describe("Schema name. Defaults to \"public\"."),
      }),
    },
    async ({ table, schema }) => {
      try {
        const result = await withReadOnly(pool, (db) =>
          tableStats(db, table, schema ?? "public"),
        );
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
