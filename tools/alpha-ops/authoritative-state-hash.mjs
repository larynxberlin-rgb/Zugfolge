import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const postgres = createRequire(new URL("../../packages/db/package.json", import.meta.url))("postgres");

const urls = process.argv.slice(2);
if (urls.length === 0) throw new Error("usage: node authoritative-state-hash.mjs DATABASE_URL [...]");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const hashes = [];
for (const url of urls) {
  const sql = postgres(url, { max: 1 });
  try {
    const tables = await sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `;
    const state = [];
    for (const { table_name: tableName } of tables) {
      if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) throw new Error(`Unsafe table name '${tableName}'.`);
      const rows = await sql.unsafe(`select to_jsonb(t) as row from public."${tableName}" t order by to_jsonb(t)::text`);
      state.push({ table: tableName, rows: rows.map((entry) => entry.row) });
    }
    const hash = createHash("sha256").update(canonical(state)).digest("hex");
    hashes.push(hash);
    process.stdout.write(`${JSON.stringify({ database: new URL(url).pathname.slice(1), tableCount: state.length, rowCount: state.reduce((sum, table) => sum + table.rows.length, 0), stateHash: hash })}\n`);
  } finally {
    await sql.end();
  }
}
if (new Set(hashes).size > 1) {
  process.stderr.write("Authoritative state hashes differ.\n");
  process.exitCode = 1;
}
