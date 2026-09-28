/**
 * How many ROWS does a full import write? That single number decides whether the
 * one-source (registry + D1) deployment needs one day or several.
 *
 * D1's free tier allows 100,000 rows written per day. `servers` is 36,881 rows,
 * but an FTS5 index writes to its own shadow tables too, and those are what can
 * blow the budget. This measures the shadow-table cost of three schema variants
 * on the real dataset, so the choice is made on numbers rather than guesses.
 *
 *   node generator/measure-writes.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { Translator, nameTokens } from './lib/translate.js';
import { buildServedRecord, installability } from '../shared/shape.js';
import { fold } from '../shared/fold.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');

const DAILY_WRITE_BUDGET = 100000;

function readRaw() {
  const file = path.join(DATA, 'raw.jsonl');
  if (!fs.existsSync(file)) throw new Error(`missing ${file} — run step1-fetch.js first`);
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* torn line */
    }
  }
  return out;
}

/** Rebuild the exact rows step3 writes, so measurements match production. */
function buildRows() {
  const translator = new Translator({ cachePath: path.join(DATA, 'translation-cache.json') });
  const rows = [];
  const seen = new Set();
  for (const rec of readRaw()) {
    const src = rec?.server ?? {};
    if (!src.name) continue;
    const extra = nameTokens(src.name);
    const titleZh = typeof src.title === 'string' ? (translator.cache.get(Translator.key(src.title, true, extra)) ?? '') : '';
    const descZh = typeof src.description === 'string' ? (translator.cache.get(Translator.key(src.description, true, extra)) ?? '') : '';
    const built = buildServedRecord(rec, { titleZh, descZh });
    if (seen.has(built.id)) continue;
    seen.add(built.id);
    const inst = installability(built.served);
    if (!inst.ok) continue;
    rows.push({
      registryId: built.id,
      sourceName: built.sourceName,
      served: built.served,
      category: built.category,
      transport: inst.transport ?? null,
    });
  }
  rows.sort((a, b) => a.sourceName.localeCompare(b.sourceName));
  return rows;
}

/** Count rows in every user table, including FTS5 shadow tables. */
function countAllRows(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);
  const counts = new Map();
  for (const t of tables) {
    try {
      counts.set(t, db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n);
    } catch {
      /* virtual table without a count */
    }
  }
  return counts;
}

function measure(label, schemaSql, insertSql) {
  const file = path.join(os.tmpdir(), `writes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseSync(file);
  try {
    db.exec(schemaSql);
    insertSql(db);

    const counts = countAllRows(db);
    const shadow = [...counts].filter(([t]) => /_(data|idx|content|docsize|config)$/.test(t));
    const shadowRows = shadow.reduce((a, [, n]) => a + n, 0);

    // `servers` rows are unavoidable; shadow rows are the FTS overhead.
    const servers = counts.get('servers') ?? 0;
    const terms = counts.get('terms') ?? 0;
    const indexRows = counts.get('term_index') ?? 0;
    const total = [...counts.values()].reduce((a, b) => a + b, 0);

    console.log(`\n--- ${label}`);
    console.log(`    servers rows      : ${servers.toLocaleString()}`);
    if (terms) console.log(`    terms rows        : ${terms.toLocaleString()}`);
    if (indexRows) console.log(`    term_index rows   : ${indexRows.toLocaleString()}`);
    if (shadow.length) {
      for (const [t, n] of shadow.sort((a, b) => b[1] - a[1])) {
        console.log(`    ${t.padEnd(18)}: ${n.toLocaleString()}`);
      }
    }
    console.log(`    TOTAL rows in DB  : ${total.toLocaleString()}`);
    console.log(`    -> writes needed  : ~${total.toLocaleString()}  (${(total / DAILY_WRITE_BUDGET).toFixed(1)} day(s) at 100k/day)`);
    return { label, total, servers, counts };
  } finally {
    db.close();
    fs.rmSync(file, { force: true });
  }
}

function main() {
  const rows = buildRows();
  console.log(`installable rows: ${rows.length.toLocaleString()}`);

  const insertServers = (db) => {
    const stmt = db.prepare(
      'INSERT INTO servers (id, registry_id, name, source_name, title, description, category, transport, json) VALUES (?,?,?,?,?,?,?,?,?)',
    );
    rows.forEach((r, i) => {
      const s = r.served;
      stmt.run(
        i + 1,
        r.registryId,
        s.name,
        r.sourceName,
        s.title ?? null,
        s.description ?? null,
        r.category,
        r.transport,
        JSON.stringify({ server: s, _meta: {} }),
      );
    });
  };

  const results = [];

  // ---- variant 1: current schema (content stored, docsize on) --------------
  results.push(
    measure(
      'V1  fts5 stores content (current schema)',
      `CREATE TABLE servers (id INTEGER PRIMARY KEY, registry_id TEXT NOT NULL, name TEXT NOT NULL,
         source_name TEXT NOT NULL, title TEXT, description TEXT, category TEXT, transport TEXT, json TEXT NOT NULL);
       CREATE VIRTUAL TABLE search USING fts5(title, description, tokenize='unicode61 remove_diacritics 2');`,
      (db) => {
        insertServers(db);
        const ins = db.prepare('INSERT INTO search (rowid, title, description) VALUES (?,?,?)');
        rows.forEach((r, i) => ins.run(i + 1, fold(r.served.title ?? ''), fold(r.served.description ?? '')));
      },
    ),
  );

  // ---- variant 2: external content + no docsize ---------------------------
  results.push(
    measure(
      'V2  fts5 external content, columnsize=0',
      `CREATE TABLE servers (id INTEGER PRIMARY KEY, registry_id TEXT NOT NULL, name TEXT NOT NULL,
         source_name TEXT NOT NULL, title TEXT, description TEXT, category TEXT, transport TEXT, json TEXT NOT NULL);
       CREATE VIRTUAL TABLE search USING fts5(title, description, content='servers', content_rowid='id',
         columnsize=0, tokenize='unicode61 remove_diacritics 2');`,
      (db) => {
        insertServers(db);
        // External-content FTS is populated by feeding the folded text explicitly,
        // because the host columns hold Chinese, not folded tokens.
        const ins = db.prepare('INSERT INTO search (rowid, title, description) VALUES (?,?,?)');
        rows.forEach((r, i) => ins.run(i + 1, fold(r.served.title ?? ''), fold(r.served.description ?? '')));
      },
    ),
  );

  // ---- variant 3: no FTS at all (LIKE scan) -------------------------------
  results.push(
    measure(
      'V3  no fts (LIKE scan, full table read per search)',
      `CREATE TABLE servers (id INTEGER PRIMARY KEY, registry_id TEXT NOT NULL, name TEXT NOT NULL,
         source_name TEXT NOT NULL, title TEXT, description TEXT, category TEXT, transport TEXT, json TEXT NOT NULL);`,
      insertServers,
    ),
  );

  console.log('\n=================== COMPARISON ===================');
  for (const r of results) {
    const days = r.total / DAILY_WRITE_BUDGET;
    console.log(
      `  ${r.label.padEnd(48)} ${String(r.total).padStart(8)} rows  ${days <= 1 ? 'fits in ONE day' : `${Math.ceil(days)} days`}`,
    );
  }

  fs.writeFileSync(
    path.join(DATA, 'write-measure.json'),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), rows: rows.length, dailyBudget: DAILY_WRITE_BUDGET, variants: results.map((r) => ({ label: r.label, total: r.total })) },
      null,
      2,
    ),
    'utf8',
  );
  console.log('\nwrote data/write-measure.json');
}

main();
