# pg-lens-mcp

A **read-only PostgreSQL explainer** MCP server, written in TypeScript.

Point an AI client (Claude Code, Cursor, Claude Desktop) at a Postgres
database and ask questions like *"what tables are here?"*, *"what does the
orders table look like?"* — and, from Evening 2, *"why is this query slow?"*

The server can **never write to the database**. That is a design choice,
not a missing feature — see *Safety* below.

> Status: Evening 2 of 3 — all five tools are built and tested, including a
> live end-to-end run (below). Evening 3 adds evals, a recorded demo, CI
> verification on GitHub, and publishing.

## Tools

| Tool | What it does |
| --- | --- |
| `list_tables` | Tables in the database (system schemas excluded), with approximate row counts |
| `describe_table` | Columns and types, primary key, and existing indexes for one table |
| `explain_query` | EXPLAIN (FORMAT JSON) for a SELECT, summarised: cost, sequential scans, index scans. Planned, never executed |
| `suggest_indexes` | Reads an explain plan and suggests an index, with reasoning — never applies it |
| `table_stats` | Table/index sizes, live/dead rows, sequential vs index scan counts |

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

(Or add the same command/env to your client's MCP config for Cursor /
Claude Desktop.)

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
(`@modelcontextprotocol/server`, protocol revision 2026-07-28). Most
tutorials online still use the v1 package (`@modelcontextprotocol/sdk`);
this project starts on v2 deliberately.

## Layout

- `src/server.ts` — MCP server and tool registration
- `src/tools.ts` — tool logic (unit-testable without a database)
- `src/sql-guard.ts` — read-only SQL guard
- `src/db.ts` — connection pool + read-only transaction wrapper
- `db/init.sql` — sample shop schema + seed data
- `test/` — vitest tests
