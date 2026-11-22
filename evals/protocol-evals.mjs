// pg-lens-mcp protocol evals: fixed cases run against a live seeded database through the real MCP protocol (spawns the server like a client would).
// Usage: DATABASE_URL=postgres://pglens:pglens@localhost:5433/shop npm run eval
// Spawns the server from source (tsx) exactly as an MCP client would.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2); }

const child = spawn('npx', ['tsx', 'src/index.ts'], {
  cwd: root, env: { ...process.env, DATABASE_URL }, stdio: ['pipe', 'pipe', 'inherit'],
});
let buf = ''; const pending = new Map(); let id = 0;
child.stdout.on('data', d => { buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue; const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } } });
const send = (method, params = {}) => new Promise(res => { const mid = ++id; pending.set(mid, res);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mid, method, params }) + '\n'); });
const notify = (method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
const call = async (name, args) => {
  const r = await send('tools/call', { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? '';
  let json = null; try { json = JSON.parse(text); } catch { /* error text */ }
  return { isError: !!r.result?.isError, text, json };
};

const SLOW = 'SELECT * FROM orders WHERE customer_id = 42';
const BY_PK = 'SELECT * FROM orders WHERE id = 42';
const cases = [
  ['list_tables finds the seeded shop tables', async () => {
    const { json } = await call('list_tables', {});
    const orders = json.tables.find(t => t.table === 'orders');
    return orders && orders.approxRows > 10000 && json.tables.length === 4;
  }],
  ['list_tables schema filter works', async () => {
    const { json } = await call('list_tables', { schema: 'public' });
    return json.tables.every(t => t.schema === 'public') && json.tables.length === 4;
  }],
  ['describe_table orders: columns, PK, only the PK index', async () => {
    const { json } = await call('describe_table', { table: 'orders' });
    return json.columns.some(c => c.name === 'customer_id')
      && json.primaryKey.includes('id')
      && json.indexes.length === 1 && json.indexes[0].name === 'orders_pkey';
  }],
  ['explain_query flags the slow query as a sequential scan', async () => {
    const { json } = await call('explain_query', { query: SLOW });
    return json.summary.seqScans.some(s => s.table === 'orders') && json.summary.totalCost > 300;
  }],
  ['explain_query on a PK lookup uses an index, no seq scan', async () => {
    const { json } = await call('explain_query', { query: BY_PK });
    return json.summary.seqScans.length === 0 && json.summary.indexScans.length > 0;
  }],
  ['suggest_indexes proposes the missing customer_id index', async () => {
    const { json } = await call('suggest_indexes', { query: SLOW });
    return json.suggestions.length === 1
      && json.suggestions[0].createIndexSql.includes('idx_orders_customer_id');
  }],
  ['suggest_indexes stays silent when an index already covers the query', async () => {
    const { json } = await call('suggest_indexes', { query: BY_PK });
    return json.suggestions.length === 0;
  }],
  ['table_stats reports live rows and size for orders', async () => {
    const { json } = await call('table_stats', { table: 'orders' });
    return json.liveRows > 10000 && json.totalSizeBytes > 0;
  }],
  ['safety: a DELETE passed to explain_query is rejected', async () => {
    const { isError } = await call('explain_query', { query: 'DELETE FROM orders WHERE id = 1' });
    return isError;
  }],
  ['safety: a stacked DROP statement is rejected', async () => {
    const { isError } = await call('explain_query', { query: 'SELECT 1; DROP TABLE orders' });
    return isError;
  }],
  ['safety: an UPDATE passed to suggest_indexes is rejected', async () => {
    const { isError } = await call('suggest_indexes', { query: 'UPDATE orders SET total = 0' });
    return isError;
  }],
  ['describe_table on a missing table returns an error, not a crash', async () => {
    const { isError, text } = await call('describe_table', { table: 'no_such_table' });
    return isError && text.includes('not found');
  }],
];

await send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pg-lens-evals', version: '1.0.0' } });
notify('notifications/initialized');
let pass = 0;
for (const [name, fn] of cases) {
  let ok = false, err = '';
  try { ok = !!(await fn()); } catch (e) { err = String(e?.message ?? e); }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${err ? ' — ' + err : ''}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${cases.length} evals passed`);
child.kill();
process.exit(pass === cases.length ? 0 : 1);
