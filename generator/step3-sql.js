/**
 * Step 3 — translate everything and emit D1 import files.
 *
 *   node generator/step3-sql.js                     # full run (uses the cache)
 *   node generator/step3-sql.js --limit=500         # quick end-to-end check
 *   node generator/step3-sql.js --chunk=8000        # split into importable parts
 *   node generator/step3-sql.js --no-sql            # stats only
 *
 * Output:
 *   data/import.sql          single file (handy for local testing)
 *   data/d1/part-NN.sql      chunked files for the remote import
 *   data/stats.json          counts, category spread, translation cache state
 *
 * WHY CHUNKING EXISTS: D1's free tier allows 100,000 rows written per day. A full
 * import writes one row per server plus FTS5's internal index rows — roughly
 * 150,000-200,000 writes in total, so a single un-chunked import would be cut off
 * partway through. Each part file stays under that daily budget, so the whole
 * dataset can be loaded across consecutive days without paying anything.
 *
 * ORDERING MATTERS: the client caches at most MAX_CACHED_ENTRIES = 2000 entries
 * per source while browsing, so only the first 2000 rows are visible without
 * searching. Installable, titled, described entries are therefore sorted first.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Translator, nameTokens } from './lib/translate.js';
import { buildServedRecord, installability } from '../shared/shape.js';
import { fold } from '../shared/fold.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');
const D1DIR = path.join(DATA, 'd1');

/**
 * Cap on one INSERT statement, in REAL UTF-8 bytes.
 *
 * D1 rejects statements over 100 KB and SQLite raises SQLITE_TOOBIG. Counting
 * `String.length` is not enough: Chinese is 3 bytes per character, so a statement
 * measured as 80k "characters" is ~240 KB on the wire and gets rejected.
 */
const STATEMENT_BYTES = 90 * 1024;

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const bytes = (text) => Buffer.byteLength(text, 'utf8');

function sqlStr(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Build `INSERT INTO table (cols) VALUES (...), (...);` statements under the byte cap. */
function buildInserts(table, columns, rows) {
  const out = [];
  if (!rows.length) return out;
  const head = `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n`;
  let chunk = [];
  let size = bytes(head);
  const flush = () => {
    if (!chunk.length) return;
    out.push(head + chunk.join(',\n') + ';');
    chunk = [];
    size = bytes(head);
  };
  for (const values of rows) {
    const line = `  (${values.map(sqlStr).join(', ')})`;
    const lineBytes = bytes(line);
    if (size + lineBytes > STATEMENT_BYTES) flush();
    chunk.push(line);
    size += lineBytes + 2;
  }
  flush();
  return out;
}

function readRaw(limit) {
  const file = path.join(DATA, 'raw.jsonl');
  if (!fs.existsSync(file)) throw new Error(`missing ${file} — run step1-fetch.js first`);
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a torn last line from an interrupted crawl */
    }
    if (out.length >= limit) break;
  }
  return out;
}

async function main() {
  const limit = Number(arg('limit', '0')) || Infinity;
  const chunkSize = Number(arg('chunk', '0')) || 0;
  const records = readRaw(limit);
  console.log(`loaded ${records.length} raw records`);

  const translator = new Translator({
    batchSize: 30,
    concurrency: 4,
    cachePath: path.join(DATA, 'translation-cache.json'),
  });

  // Brand tokens come from the registry name and are protected per record, so
  // "Propick Integration MCP" keeps its brand while "Business Contact Finder"
  // still translates. See generator/lib/glossary-words.js for the vocabulary test.
  const jobs = [];
  for (const rec of records) {
    const src = rec?.server ?? {};
    const extra = nameTokens(src.name);
    if (typeof src.title === 'string' && src.title.trim()) jobs.push({ text: src.title, extra });
    if (typeof src.description === 'string' && src.description.trim()) jobs.push({ text: src.description, extra });
  }
  console.log(`queued ${jobs.length} strings to translate`);

  const t0 = Date.now();
  const map = await translator.translateJobs(jobs, {
    onProgress: ({ done, total, cacheSize }) => {
      if (done % 5000 === 0 || done === total) process.stdout.write(`    ${done}/${total}  (cache ${cacheSize})\n`);
    },
  });
  const secs = (Date.now() - t0) / 1000;
  console.log(
    `translated in ${secs.toFixed(0)}s | new ${translator.stats.miss} | cached ${translator.stats.hit} | ` +
      `requests ${translator.stats.requests} | failures ${translator.stats.failed}`,
  );

  // ---- build the rows -----------------------------------------------------
  const built = [];
  let unmappable = 0;
  let duplicateIds = 0;
  const dupNames = [];
  const catCount = new Map();
  const idSeen = new Map();

  for (const rec of records) {
    const src = rec?.server ?? {};
    if (!src.name) continue;
    const titleZh = typeof src.title === 'string' ? (map.get(src.title) ?? '') : '';
    const descZh = typeof src.description === 'string' ? (map.get(src.description) ?? '') : '';
    const entry = buildServedRecord(rec, { titleZh, descZh });

    // The client dedupes by derived id, so a second record with the same id would
    // be dropped on their side anyway. Count and skip it here so the pagination
    // cursor stays meaningful.
    if (idSeen.has(entry.id)) {
      duplicateIds += 1;
      if (dupNames.length < 10) dupNames.push(`${src.name}  ==  ${idSeen.get(entry.id)}`);
      continue;
    }
    idSeen.set(entry.id, src.name);

    const inst = installability(entry.served);
    if (!inst.ok) unmappable += 1;
    catCount.set(entry.category, (catCount.get(entry.category) ?? 0) + 1);

    built.push({
      registryId: entry.id,
      sourceName: entry.sourceName,
      category: entry.category,
      transport: inst.transport ?? null,
      installable: inst.ok,
      hasTitle: !!entry.served.title,
      hasDesc: !!entry.served.description,
      record: { server: entry.served, _meta: entry.meta },
    });
  }

  built.sort((a, b) => {
    if (a.installable !== b.installable) return a.installable ? -1 : 1;
    if (a.hasTitle !== b.hasTitle) return a.hasTitle ? -1 : 1;
    if (a.hasDesc !== b.hasDesc) return a.hasDesc ? -1 : 1;
    return a.sourceName.localeCompare(b.sourceName);
  });

  const serverRows = [];
  const searchRows = [];
  let servedBytes = 0;
  built.forEach((item, index) => {
    const id = index + 1;
    const s = item.record.server;
    const json = JSON.stringify(item.record);
    servedBytes += bytes(json);
    serverRows.push([
      id,
      item.registryId,
      s.name,
      item.sourceName,
      s.title ?? null,
      s.description ?? null,
      item.category,
      item.transport,
      json,
    ]);
    // Only title + description are indexed. Those are exactly the fields the host
    // re-filters on locally, so every server-side hit survives that filter and no
    // page slot is wasted. See schema.sql for the full reasoning.
    searchRows.push([id, fold(s.title ?? ''), fold(s.description ?? '')]);
  });

  const avgBytes = built.length ? Math.round(servedBytes / built.length) : 0;
  const stats = {
    generatedAt: new Date().toISOString(),
    entries: built.length,
    installable: built.length - unmappable,
    unmappable,
    duplicateIds,
    duplicateExamples: dupNames,
    withTitle: built.filter((b) => b.hasTitle).length,
    withDescription: built.filter((b) => b.hasDesc).length,
    categories: Object.fromEntries([...catCount].sort((a, b) => b[1] - a[1])),
    servedBytes,
    avgBytesPerRecord: avgBytes,
    responseBytesPerPage: avgBytes * 100,
    statementBytesCap: STATEMENT_BYTES,
    translation: { ...translator.stats, cacheSize: translator.cache.size },
  };
  fs.writeFileSync(path.join(DATA, 'stats.json'), JSON.stringify(stats, null, 2), 'utf8');

  console.log('--------------------------------------------');
  console.log('entries      :', stats.entries);
  console.log('installable  :', stats.installable, `(${((stats.installable / stats.entries) * 100).toFixed(1)}%)`);
  console.log('unmappable   :', stats.unmappable, '(the official source hides these too)');
  console.log('duplicate ids:', stats.duplicateIds, '(skipped; must not appear in output)');
  for (const d of dupNames) console.log('      ', d);
  console.log('with title   :', stats.withTitle, '| with description:', stats.withDescription);
  console.log('categories   :', JSON.stringify(stats.categories));
  console.log('avg record   :', avgBytes, 'bytes  ->  ~', avgBytes * 100, 'bytes per 100-row page');
  console.log(`              (host caps a source response at 4 MB, so ~${(4194304 / (avgBytes * 100)).toFixed(0)}x headroom)`);

  if (has('no-sql')) {
    console.log('--no-sql: skipping SQL output');
    return;
  }

  const header = [
    '-- Generated by generator/step3-sql.js — do not edit by hand.',
    `-- ${stats.entries} entries, ${stats.installable} installable, generated ${stats.generatedAt}.`,
    '-- Schema must already exist (generator/lib/schema.sql drops and recreates it).',
    '',
  ];
  const columns = ['id', 'registry_id', 'name', 'source_name', 'title', 'description', 'category', 'transport', 'json'];
  const searchColumns = ['rowid', 'title', 'description'];

  // Single file, for local verification.
  const single = [
    ...header,
    ...buildInserts('servers', columns, serverRows),
    ...buildInserts('search', searchColumns, searchRows),
    '',
  ];
  const sqlPath = path.join(DATA, 'import.sql');
  fs.writeFileSync(sqlPath, single.join('\n'), 'utf8');

  const stmts = single.filter((s) => s.startsWith('INSERT')).length;
  console.log('wrote', sqlPath, `(${(fs.statSync(sqlPath).size / 1048576).toFixed(1)} MB, ${stmts} statements)`);

  // Chunked files, for the remote import (D1 free tier: 100k rows written/day).
  if (chunkSize > 0) {
    fs.rmSync(D1DIR, { recursive: true, force: true });
    fs.mkdirSync(D1DIR, { recursive: true });
    const parts = [];
    for (let start = 0; start < serverRows.length; start += chunkSize) {
      const end = Math.min(start + chunkSize, serverRows.length);
      const label = String(parts.length + 1).padStart(2, '0');
      const body = [
        ...header,
        `-- Part ${label}: entries ${start + 1}..${end}`,
        '',
        ...buildInserts('servers', columns, serverRows.slice(start, end)),
        ...buildInserts('search', searchColumns, searchRows.slice(start, end)),
        '',
      ].join('\n');
      const name = `part-${label}.sql`;
      fs.writeFileSync(path.join(D1DIR, name), body, 'utf8');
      parts.push({
        name,
        from: start + 1,
        to: end,
        mb: +(fs.statSync(path.join(D1DIR, name)).size / 1048576).toFixed(1),
      });
    }
    fs.writeFileSync(path.join(D1DIR, 'index.json'), JSON.stringify({ chunkSize, parts }, null, 2), 'utf8');
    console.log(`wrote ${parts.length} chunk(s) to ${D1DIR} (${chunkSize} entries each)`);
    for (const p of parts) console.log(`   ${p.name}  ${p.from}..${p.to}  ${p.mb} MB`);
    console.log('   import one part per day to stay inside the free-tier write budget');
  }
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e);
  process.exit(1);
});
