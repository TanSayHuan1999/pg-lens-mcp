import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createPool } from "./db.js";
import { createServer } from "./server.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set. See .env.example.");
  process.exit(1);
}

const pool = createPool(connectionString);

// serveStdio takes a factory: the same factory serves both the current
// (2026-07-28) protocol revision and 2025-era clients.
serveStdio(() => createServer(pool));
