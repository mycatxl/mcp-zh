/**
 * What does a full import REALLY cost in D1 rows-written?
 *
 * A real production import reported 68,558 rows written for 34,279 entries —
 * 1.9x what generator/step3-sql.js predicted (36,519). The prediction counted
 * the physical rows that exist at rest. D1 charges per row WRITTEN during the
 * operation, and those are not the same number.
 *
 * COUNTING TRAP (the reason this file exists in its current shape):
 * `SELECT COUNT(*) FROM search` on an FTS5 table with `content='servers'` reads
 * the CONTENT table, so it reports the row count of `servers` — it is a virtual
 * table and has no rows of its own. Counting it double-counts the dataset and
 * makes the estimate look like it matches when it does not. Only the real shadow
 * tables (search_data, search_idx, search_config) are physical.
 *
 *   node generator/measure-writes.js
 *
 * Output: data/write-measure.json, read by step3-sql.js for its budget report.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');

/** What a real production import to Cloudflare D1 actually reported. */
const PRODUCTION = { entries: 34279, rowsWritten: 68558, sizeMb: 50.91, ms: 5560 };

const DAILY_WRITE_BUDGET = 100000;

/**
 * Count PHYSICAL rows only. A virtual table is skipped: its COUNT(*) reads the
 * content table, which is already counted separately.
 */
function countPhysicalRows(db) {
  const objects = db
    .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'")
    .all();
  const virtual = new Set(
    db
      .prepare("SELECT name FROM pragma_table_list WHERE type = 'virtual'")
      .all()
      .map((r) => r.name),
  );
  const out = new Map();
  for (const { name } of objects) {
    if (virtual.has(name)) continue; // virtual: has no rows of its own
    try {
      out.set(name, db.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n);
    } catch {
      /* not countable */
    }
  }
  return out;
}

function run(schemaSql, fill) {
  const file = path.join(os.tmpdir(), `w-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseSync(file);
  try {
    db.exec(schemaSql);
    const t0 = Date.now();
    fill(db);
    const ms = Date.now() - t0;
    const counts = countPhysicalRows(db);
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    return { counts, total, ms };
  } finally {
    db.close();
    fs.rmSync(file, { force: true });
  }
}

const SCHEMA = `
  CREATE TABLE servers (
    id INTEGER PRIMARY KEY, registry_id TEXT NOT NULL, name TEXT NOT NULL,
    source_name TEXT NOT NULL, title TEXT, description TEXT, category TEXT,
    transport TEXT, json TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE search USING fts5(
    title, description, content='servers', content_rowid='id',
    columnsize=0, tokenize='unicode61 remove_diacritics 2'
  );
`;

// Realistic Chinese text, same shape as the real dataset.
const N = 5000;
const rows = [];
for (let i = 1; i <= N; i++) {
  const title = `中文标题示例 ${i} 数据库工具`;
  const desc = `这是一个用于连接 PostgreSQL 数据库并执行查询的服务器示例，编号 ${i}，支持智能体协作与文档检索。`;
  rows.push({ id: i, title, desc, json: JSON.stringify({ server: { name: `x/y-${i}`, title, description: desc }, _meta: {} }) });
}

// fold() equivalent, inlined so this script does not depend on import order.
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const RUNS = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+|[A-Za-z0-9_@./+#-]+/g;
function fold(text) {
  const out = [];
  for (const run of String(text ?? '').match(RUNS) ?? []) {
    if (CJK.test(run)) {
      if (run.length === 1) out.push(run);
      else for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
    } else out.push(...run.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  }
  return out.join(' ');
}

const result = run(SCHEMA, (db) => {
  const ins = db.prepare('INSERT INTO servers (id,registry_id,name,source_name,title,description,category,transport,json) VALUES (?,?,?,?,?,?,?,?,?)');
  const insFts = db.prepare('INSERT INTO search (rowid,title,description) VALUES (?,?,?)');
  for (const r of rows) {
    ins.run(r.id, `zh-api-${r.id}`, `zh/api/x/y-${r.id}`, `x/y-${r.id}`, r.title, r.desc, 'devtools', 'http', r.json);
    insFts.run(r.id, fold(r.title), fold(r.desc));
  }
});

console.log(`sample: ${N.toLocaleString()} entries inserted in ${result.ms} ms`);
console.log('');
console.log('physical rows at rest (virtual tables excluded):');
for (const [t, n] of [...result.counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t.padEnd(18)} ${String(n).padStart(9)}`);
}
console.log(`  ${'TOTAL'.padEnd(18)} ${String(result.total).padStart(9)}`);
console.log('');

const atRestPerEntry = result.total / N;
const atRestFull = Math.round(atRestPerEntry * PRODUCTION.entries);
const perEntry = PRODUCTION.rowsWritten / PRODUCTION.entries;
const estimateFull = Math.round(perEntry * PRODUCTION.entries);
const ratio = PRODUCTION.rowsWritten / atRestFull;

console.log('=================== PREDICTION vs REALITY ===================');
console.log(`physical rows at rest, extrapolated : ${atRestFull.toLocaleString()}  (${atRestPerEntry.toFixed(2)}/entry)`);
console.log(`actually charged by D1              : ${PRODUCTION.rowsWritten.toLocaleString()}  (${perEntry.toFixed(2)}/entry)`);
console.log(`ratio charged / at-rest             : ${ratio.toFixed(2)}x`);
console.log('');
console.log('D1 charges per row WRITTEN, not per row stored. The gap is the FTS5 index');
console.log('writing internal rows as terms are added; most of those merge away and leave');
console.log('no trace at rest, but they are still charged.');
console.log('');
console.log(`honest cost for ${PRODUCTION.entries.toLocaleString()} entries : ~${estimateFull.toLocaleString()} rows written`);
console.log(`share of the ${DAILY_WRITE_BUDGET.toLocaleString()}/day budget : ${((estimateFull / DAILY_WRITE_BUDGET) * 100).toFixed(0)}%`);
console.log('');

const out = {
  generatedAt: new Date().toISOString(),
  method: 'local SQLite physical-row count (virtual tables excluded), calibrated against a real D1 import',
  sample: { entries: N, ms: result.ms, physicalRowsAtRest: result.total, rowsAtRestPerEntry: +atRestPerEntry.toFixed(3) },
  production: PRODUCTION,
  calibration: {
    rowsAtRestExtrapolated: atRestFull,
    ratioChargedToAtRest: +ratio.toFixed(3),
    rowsWrittenPerEntry: +perEntry.toFixed(3),
  },
  budget: {
    dailyBudget: DAILY_WRITE_BUDGET,
    estimatedForFullImport: estimateFull,
    shareOfDaily: +((estimateFull / DAILY_WRITE_BUDGET) * 100).toFixed(1),
    fitsInOneDay: estimateFull <= DAILY_WRITE_BUDGET,
    fullImportsPerDay: Math.floor(DAILY_WRITE_BUDGET / estimateFull),
  },
};
fs.writeFileSync(path.join(DATA, 'write-measure.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('wrote data/write-measure.json');
console.log('');
console.log(
  out.budget.fitsInOneDay
    ? `VERDICT: a full import fits in one day (${out.budget.shareOfDaily}% of the free tier, ` +
        `${out.budget.fullImportsPerDay} full import(s) per day).`
    : `VERDICT: a full import does NOT fit in one day (${out.budget.shareOfDaily}%).`,
);
