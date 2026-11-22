/**
 * pg-lens evals runner.
 *
 * Runs the fixed cases in evals/cases.json against a real seeded Postgres
 * (DATABASE_URL) and scores each case pass/fail: did the tool the case
 * names produce the expected diagnosis? This is the eval-first check from
 * the project plan — it proves the tools give the right answer on known
 * questions, instead of only looking right in a demo.
 *
 * Usage: DATABASE_URL=postgres://pglens:pglens@localhost:5432/shop npm run evals
 * Exit code 0 = all cases passed, 1 = at least one failure.
 */
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { withReadOnly } from "../src/db.js";
import {
  describeTable,
  explainQuery,
  listTables,
  suggestIndexes,
  tableStats,
} from "../src/tools.js";

interface EvalCase {
  id: string;
  question: string;
  tool: string;
  args?: { table?: string; sql?: string };
  expect: {
    tables?: string[];
    columnsInclude?: string[];
    primaryKey?: string[];
    noIndexOn?: string;
    seqScanOn?: string;
    noSeqScanOn?: string;
    suggestionIncludes?: string;
    noSuggestions?: boolean;
    rejected?: boolean;
    minLiveRows?: number;
  };
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set — evals need the seeded shop database.");
  process.exit(1);
}

const cases: EvalCase[] = JSON.parse(
  await readFile(new URL("./cases.json", import.meta.url), "utf8"),
);

const pool = new Pool({ connectionString: url });
let passed = 0;

async function runCase(c: EvalCase): Promise<string[]> {
  const failures: string[] = [];
  const e = c.expect;
  try {
    await withReadOnly(pool, async (db) => {
      if (c.tool === "list_tables") {
        const tables = (await listTables(db)).map((t) => t.table).sort();
        if (e.tables && JSON.stringify(tables) !== JSON.stringify([...e.tables].sort()))
          failures.push(`tables were ${tables.join(",")}`);
      } else if (c.tool === "describe_table") {
        const d = await describeTable(db, c.args!.table!);
        for (const col of e.columnsInclude ?? [])
          if (!d.columns.some((x) => x.name === col)) failures.push(`missing column ${col}`);
        if (e.primaryKey && JSON.stringify(d.primaryKey) !== JSON.stringify(e.primaryKey))
          failures.push(`primary key was ${d.primaryKey.join(",")}`);
        if (e.noIndexOn && d.indexes.some((i) => i.definition.includes(`(${e.noIndexOn})`)))
          failures.push(`an index on ${e.noIndexOn} exists but the case expects none`);
      } else if (c.tool === "explain_query") {
        const r = await explainQuery(db, c.args!.sql!);
        const seqTables = r.summary.seqScans.map((s) => s.table);
        if (e.seqScanOn && !seqTables.includes(e.seqScanOn))
          failures.push(`expected a seq scan on ${e.seqScanOn}, got [${seqTables.join(",") || "none"}]`);
        if (e.noSeqScanOn && seqTables.includes(e.noSeqScanOn))
          failures.push(`unexpected seq scan on ${e.noSeqScanOn}`);
        if (e.rejected) failures.push("query was accepted but the case expects rejection");
      } else if (c.tool === "suggest_indexes") {
        const r = await suggestIndexes(db, c.args!.sql!);
        if (e.suggestionIncludes && !r.suggestions.some((s) => s.createIndexSql === e.suggestionIncludes))
          failures.push(`suggestions were [${r.suggestions.map((s) => s.createIndexSql).join("; ") || "none"}]`);
        if (e.noSuggestions && r.suggestions.length > 0)
          failures.push(`expected no suggestions, got ${r.suggestions.length}`);
      } else if (c.tool === "table_stats") {
        const s = await tableStats(db, c.args!.table!);
        if (e.minLiveRows !== undefined && s.liveRows < e.minLiveRows)
          failures.push(`liveRows ${s.liveRows} < ${e.minLiveRows}`);
      } else {
        failures.push(`unknown tool ${c.tool}`);
      }
    });
  } catch (err) {
    if (!e.rejected) failures.push(`threw: ${err instanceof Error ? err.message : String(err)}`);
  }
  return failures;
}

for (const c of cases) {
  const failures = await runCase(c);
  if (failures.length === 0) {
    passed++;
    console.log(`PASS  ${c.id}`);
  } else {
    console.log(`FAIL  ${c.id} — ${failures.join("; ")}`);
  }
}

await pool.end();
console.log(`\n${passed}/${cases.length} eval cases passed`);
process.exit(passed === cases.length ? 0 : 1);
