# pg-lens-mcp




[![TanSayHuan1999/pg-lens-mcp MCP server](https://glama.ai/mcp/servers/TanSayHuan1999/pg-lens-mcp/badges/score.svg)](https://glama.ai/mcp/servers/TanSayHuan1999/pg-lens-mcp)




A **read-only PostgreSQL explainer** MCP server, written in TypeScript.




Point an AI client (Claude Code, Cursor, Claude Desktop) at a Postgres
database and ask questions like *"what tables are here?"*, *"what does the
orders table look like?"* — and, from Evening 2, *"why is this query slow?"*


## Demo


Watch an AI agent use pg-lens to find why a query is slow — sequential scan on 20,000 rows, missing index on customer_id, and the fix:

https://github.com/user-attachments/assets/6879dab3-0171-4193-bef0-a42ea021a8b3






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





