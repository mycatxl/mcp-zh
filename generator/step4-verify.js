/**
 * Verifies data/import.sql end-to-end against a real SQLite engine:
 * schema + inserts load, then Chinese queries hit the right rows.
 * This mirrors what D1 will do, so a pass here means the Worker will work.
 *
 *   node generator/step4-verify.js [--sql=data/import.sql]
 *
 * IMPORTANT — why this checks `search_data`, not `SELECT COUNT(*) FROM search`:
 * the index is FTS5 with `content='servers'` (external content). For such a
 * table, `SELECT COUNT(*) FROM search` reads the CONTENT table, so it returns
 * the row count of `servers` whether or not a single term was ever indexed.
 * That assertion would pass on a completely empty index. The only real proof is
 * (a) shadow-table rows exist and (b) MATCH actually returns hits — both below.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { toMatch, needsLikeFallback, likePattern } from '../shared/fold.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const sqlPath = path.resolve(ROOT, arg('sql', 'data/import.sql'));
const schemaPath = path.join(HERE, 'lib', 'schema.sql');
const file = path.join(os.tmpdir(), `mcp-zh-verify-${Date.now()}.db`);

console.log('schema  :', schemaPath);
console.log('import  :', sqlPath);

const db = new DatabaseSync(file);
db.exec(fs.readFileSync(schemaPath, 'utf8'));

const t0 = Date.now();
db.exec(fs.readFileSync(sqlPath, 'utf8'));
console.log(`schema + import applied in ${Date.now() - t0} ms`);

const total = db.prepare('SELECT COUNT(*) n FROM servers').get().n;
const installable = db.prepare('SELECT COUNT(*) n FROM servers WHERE transport IS NOT NULL').get().n;
const dataRows = db.prepare('SELECT COUNT(*) n FROM search_data').get().n;
const idxRows = db.prepare('SELECT COUNT(*) n FROM search_idx').get().n;

console.log('--------------------------------------------');
console.log('servers    :', total);
console.log('installable:', installable);
console.log('search_data:', dataRows, '(shadow-table rows; 0 would mean nothing was indexed)');
console.log('search_idx :', idxRows);
console.log('categories :', JSON.stringify(db.prepare('SELECT category, COUNT(*) n FROM servers GROUP BY category ORDER BY n DESC').all()));

// ---- the exact queries the Worker issues --------------------------------
function browse(limit, cursor) {
  return db.prepare('SELECT id, json FROM servers WHERE id > ?1 ORDER BY id LIMIT ?2').all(cursor, limit);
}
function searchQ(query, limit, cursor = 0) {
  if (needsLikeFallback(query)) {
    const pattern = likePattern(query);
    return db
      .prepare(
        `SELECT id, json FROM servers
         WHERE id > ?1 AND (lower(title) LIKE ?2 ESCAPE '\\' OR lower(description) LIKE ?2 ESCAPE '\\')
         ORDER BY id LIMIT ?3`,
      )
      .all(cursor, pattern, limit);
  }
  const match = toMatch(query);
  // Cursor on f.rowid, not s.id — see generator/lib/schema.sql for the plans.
  return db
    .prepare(
      `SELECT s.id AS id, s.json AS json FROM search f JOIN servers s ON s.id = f.rowid
       WHERE search MATCH ?1 AND f.rowid > ?2 ORDER BY f.rowid LIMIT ?3`,
    )
    .all(match, cursor, limit);
}

/** The host re-filters hits locally; a hit that fails here wastes a page slot. */
function passesLocalFilter(server, query) {
  const q = query.trim().toLocaleLowerCase();
  return [server?.title, server?.description, server?.name]
    .filter(Boolean)
    .some((t) => t.toLocaleLowerCase().includes(q));
}

console.log('\n=================== BROWSE ===================');
const page1 = browse(100, 0);
const page2 = browse(100, page1[page1.length - 1].id);
console.log('page 1:', page1.length, 'rows | nextCursor =', page1[page1.length - 1].id);
console.log('page 2:', page2.length, 'rows | first id  =', page2[0]?.id);
const s1 = JSON.parse(page1[0].json);
console.log('first name :', s1.server.name);
console.log('first title:', s1.server.title);
console.log('first desc :', s1.server.description?.slice(0, 70));
console.log('has _meta  :', !!s1._meta);

console.log('\n=================== SEARCH ===================');
const queries = ['数据库', '数据', '智能体', '文档', 'github', 'postgres', 'MCP', '搜索', '安装', '不存在的词xyz'];
let searchEmpty = 0;
for (const q of queries) {
  const t = Date.now();
  let rows;
  try {
    rows = searchQ(q, 20);
  } catch (e) {
    console.log(`  ${q.padEnd(14)} -> ERROR ${e.message}`);
    searchEmpty += 1;
    continue;
  }
  const ms = Date.now() - t;
  const survives = rows.every((r) => passesLocalFilter(JSON.parse(r.json).server, q));
  const titles = rows.slice(0, 2).map((r) => JSON.parse(r.json).server.title).join(' | ');
  console.log(`  ${q.padEnd(14)} -> ${String(rows.length).padStart(3)} hit(s)  ${ms}ms  localFilter=${survives}  ${titles}`);
  if (!rows.length && q !== '不存在的词xyz') searchEmpty += 1;
}

console.log('\n=================== SINGLE CHARACTER (LIKE PATH) ===================');
for (const q of ['库', '云', '码']) {
  const rows = searchQ(q, 10);
  const survives = rows.every((r) => passesLocalFilter(JSON.parse(r.json).server, q));
  console.log(`  ${q} -> ${rows.length} hit(s)  localFilter=${survives}`);
  if (!rows.length) searchEmpty += 1;
}

console.log('\n=================== PAGINATION INTEGRITY ===================');
const seen = new Set();
let cursor = 0;
let pages = 0;
let dupes = 0;
while (pages < 400) {
  const rows = browse(100, cursor);
  if (!rows.length) break;
  for (const r of rows) {
    if (seen.has(r.id)) dupes += 1;
    seen.add(r.id);
  }
  cursor = rows[rows.length - 1].id;
  pages += 1;
}
console.log(`walked ${pages} pages, ${seen.size} unique ids, ${dupes} duplicates (must be 0)`);
console.log(`full walk covered ${seen.size}/${total} rows`);

const ok = dupes === 0 && seen.size === total && dataRows > 0 && searchEmpty === 0;
db.close();
fs.rmSync(file, { force: true });
console.log(ok ? '\nOK' : '\nFAILED');
process.exit(ok ? 0 : 1);
