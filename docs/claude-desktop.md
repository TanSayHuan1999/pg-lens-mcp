# Testing pg-lens in Claude Desktop (free plan)

Local MCP servers work in Claude Desktop on a free account — no Claude
Code or Codex subscription needed. This is the Evening 3 real-client test
and demo recording setup.

## On the Mac

1. Install **Node.js LTS** (Apple Silicon) from nodejs.org — pg-lens runs
   on Node.
2. Install **Claude Desktop** from claude.ai/download and sign in with a
   free account.
3. Start the sample database (Docker Desktop must be open):

   ```bash
   cd ~/pg-lens-mcp && docker compose up -d
   ```

4. Add pg-lens to Claude Desktop's config
   (`~/Library/Application Support/Claude/claude_desktop_config.json`):

   ```json
   {
     "mcpServers": {
       "pg-lens": {
         "command": "node",
         "args": ["/Users/sayhuan99/pg-lens-mcp/dist/pg-lens.mjs"],
         "env": {
           "DATABASE_URL": "postgres://pglens:pglens@localhost:5432/shop"
         }
       }
     }
   }
   ```

   The server ships as a single bundled file (`dist/pg-lens.mjs`, built
   with `npm run bundle`), so the Mac needs no `npm install`.

5. Fully quit and reopen Claude Desktop. Ask:

   > Why is fetching orders by customer slow in the shop database?

   Expected: Claude calls `explain_query` / `suggest_indexes`, reports
   the sequential scan on `orders` (cost ~417) and suggests
   `CREATE INDEX idx_orders_customer_id ON public.orders (customer_id);`.

## Before recording the demo

- Make sure the demo flaw is intact: no `idx_orders_customer_id` index
  (drop it if a test created one).
- Re-run `npm run evals` — expect 11/11.
