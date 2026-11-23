# pg-lens-mcp

A **read-only PostgreSQL explainer** MCP server, written in TypeScript.

Point an AI client (Claude Code, Cursor, Claude Desktop) at a Postgres
database and ask questions like *"what tables are here?"*, *"what does the
orders table look like?"* — and, from Evening 2, *"why is this query slow?"*

The server can **never write to the database**. That is a design choice,
not a missing feature — see *Safety* below.

> All six tools are built and verified end-to-end against a live seeded
> database (below), with unit + integration tests and two layers of evals.

## Tools

| Tool | What it does |
| --- | --- |
| `list_tables` | Tables in the database (system schemas excluded), with approximate row counts |
| `describe_table` | Columns and types, primary key, and existing indexes for one table |
| `explain_query` | EXPLAIN (FORMAT JSON) for a SELECT, summarised: cost, sequential scans, index scans. Planned, never executed |
| `suggest_indexes` | Reads an explain plan and suggests an index, with reasoning — never applies it |
| `table_stats` | Table/index sizes, live/dead rows, sequential vs index scan counts |
| `index_health` | **v0.2:** Global index view across all schemas — flags unused and redundant indexes, with sizes and wasted bytes. Never drops anything |

### What's new in v0.2 — `index_health`

Missing indexes are only half the problem: unused and duplicate indexes tax
every INSERT/UPDATE and waste storage. `index_health` reads
`pg_stat_user_indexes` and the `pg_index` catalog and reports every index in
the database with a verdict:

- `unused` — never scanned (`idx_scan = 0`)
- `redundant` — its columns are a left-prefix of a wider index on the same table
- `ok` — otherwise

Primary-key and unique indexes are **never flagged** — they enforce
integrity even if they are never scanned for lookups. Like `suggest_indexes`,
it only *suggests* a `DROP INDEX` statement for review; pg-lens never runs one.

## Verified end-to-end (live, seeded shop DB)

Query: `SELECT * FROM orders WHERE customer_id = 42` (20,000 orders)

- **Before:** plan cost **417**, sequential scan on `orders`
- `suggest_indexes` → `CREATE INDEX idx_orders_customer_id ON public.orders (customer_id);`
- **After** a human applies that index (the tool never does): cost
  **157.46**, sequential scan gone, Bitmap Index Scan on the new index,
  and `suggest_indexes` now reports nothing to suggest

## Safety — defence in depth

Most Postgres MCP servers expose a generic "run any SQL" tool. pg-lens
deliberately does not. Three layers enforce read-only access:

1. **SQL guard** (`src/sql-guard.ts`) — a single statement only, starting
   with SELECT / WITH / EXPLAIN; write and DDL keywords rejected;
   `EXPLAIN ANALYZE` rejected because it *executes* the query, while plain
   EXPLAIN only plans it.
2. **Read-only transactions** (`src/db.ts`) — every query runs inside
   `BEGIN READ ONLY` with a 5-second statement timeout, so Postgres itself
   refuses writes even if a statement slipped past the guard.
3. **Read-only database user** (recommended setup) — the server only needs
   a user that cannot write in the first place.

## Quick start

### From npm (no clone needed)

Point your MCP client at the published package and give it a
`DATABASE_URL` for the Postgres database you want explained:

```json
{
  "mcpServers": {
    "pg-lens": {
      "command": "npx",
      "args": ["-y", "@sayhuan99/pg-lens-mcp"],
      "env": {
        "DATABASE_URL": "postgres://user:password@localhost:5432/yourdb"
      }
    }
  }
}
```

That config works in Claude Desktop and other MCP clients. From
Claude Code:

```bash
claude mcp add pg-lens --env DATABASE_URL=postgres://user:password@localhost:5432/yourdb -- npx -y @sayhuan99/pg-lens-mcp
```

Use a read-only database user — pg-lens never needs write access.

### From source (with the sample database)

```bash
# 1. Start the sample database (a small "shop" schema, seeded)
docker compose up -d

# 2. Install and run the server
npm install
cp .env.example .env   # sets DATABASE_URL for the sample DB
npm start
```

The sample schema contains a deliberate flaw: `orders.customer_id` has no
index, so orders-by-customer queries do a sequential scan. That is the
slow query the demo diagnoses.

### Use it from Claude Code

```bash
claude mcp add pg-lens --env DATABASE_URL=postgres://pglens:pglens@localhost:5433/shop -- npx tsx src/index.ts
```

### Use it from Claude Desktop (free plan works)

Build the single-file bundle once (`npm run bundle`), then add to
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pg-lens": {
      "command": "node",
      "args": ["/path/to/pg-lens-mcp/dist/pg-lens.mjs"],
      "env": {
        "DATABASE_URL": "postgres://pglens:pglens@localhost:5433/shop"
      }
    }
  }
}
```

Full walkthrough: [docs/claude-desktop.md](docs/claude-desktop.md).

## Evals

Two layers, both run against the seeded database:

- **Tool-level evals** — `evals/cases.json` holds 13 fixed cases: a
  question, the tool that should answer it, and the expected diagnosis
  (e.g. "orders by customer must seq-scan, and the suggestion must be
  `CREATE INDEX idx_orders_customer_id …`"; "a DELETE must be rejected").

  ```bash
  DATABASE_URL=postgres://pglens:pglens@localhost:5433/shop npm run eval
  # 13/13 eval cases passed
  ```

- **Protocol evals** — `evals/protocol-evals.mjs` spawns the server and
  speaks raw MCP over stdio, exactly as a client does: 14 cases covering
  every tool plus the safety rejections.

  ```bash
  DATABASE_URL=postgres://pglens:pglens@localhost:5433/shop npm run eval:protocol
  # 14/14 evals passed
  ```

This is the eval-first check: the tools are scored on known questions
instead of only looking right in a demo.

## Development

```bash
npm test        # vitest — SQL guard, plan parser, tool logic (no database needed)
npm run typecheck
DATABASE_URL=postgres://pglens:pglens@localhost:5433/shop npm test
                # also runs the integration tests against a real seeded
                # Postgres (docker compose up -d first); CI does the same
                # with a Postgres service — see .github/workflows/ci.yml
```

Built on the official MCP TypeScript SDK **v2**
(`@modelcontextprotocol/server` 2.4.0). Most tutorials online still use
the v1 package (`@modelcontextprotocol/sdk`); this project starts on v2
deliberately.

## Layout

- `src/server.ts` — MCP server and tool registration
- `src/tools.ts` — tool logic (unit-testable without a database)
- `src/plan.ts` — EXPLAIN plan parser and index-suggestion logic
- `src/sql-guard.ts` — read-only SQL guard
- `src/db.ts` — connection pool + read-only transaction wrapper
- `scripts/build-bundle.mjs` — esbuild JS-API bundle build (no shell quoting)
- `db/init.sql` — sample shop schema + seed data
- `test/` — vitest tests
- `evals/` — fixed eval cases (tool-level + protocol-level)
- `docs/` — client setup walkthroughs
