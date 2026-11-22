import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Pool } from "pg";
import { withReadOnly } from "./db.js";
import { describeTable, listTables } from "./tools.js";

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
 * Evening 1 tools: list_tables, describe_table.
 * Evening 2 will add: explain_query, suggest_indexes, table_stats.
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

  return server;
}
