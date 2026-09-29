/**
 * Step 3 — translate everything and emit the D1 import file.
 *
 *   node generator/step3-sql.js                     # full run (uses the cache)
 *   node generator/step3-sql.js --limit=500         # quick end-to-end check
 *   node generator/step3-sql.js --chunk=8000        # also split into importable parts
 *   node generator/step3-sql.js --no-sql            # stats only
 *
 * Output:
 *   data/import.sql          single file (handed to `wrangler d1 execute`)
 *   data/d1/part-NN.sql      chunked files, only when --chunk is given
 *   data/stats.json          counts, category spread, write budget, cache state
 *
 * ---------------------------------------------------------------------------
 * WHY A SINGLE FILE IS ENOUGH NOW
 *
 * D1's free tier allows 100,000 rows written per day. A full import of 34,279
 * entries actually costs ~68,600 rows written (2.00 per entry), so it fits in one
 * shot with about a third of the budget left over.
 *
 * That 2.00/entry figure is CALIBRATED, not estimated. A first attempt at this
 * file predicted 36,519 by counting the rows that exist at rest (servers plus the
 * FTS5 shadow tables) — but D1 charges per row WRITTEN, and the FTS5 index writes
 * internal rows while terms are added, most of which merge away and leave no
 * trace. The real import reported 68,558. See generator/measure-writes.js.
 *
 * The default FTS5 flavour (storing its own copy of the text plus a per-row
 * docsize) costs roughly three times this and did NOT fit in a day; that is why
 * chunking used to exist. --chunk remains available as a safety valve.
 *
 * ---------------------------------------------------------------------------
 * WHY UNINSTALLABLE RECORDS ARE NOT SERVED AT ALL
 *
 * `mapRegistryServer()` returns null for a record with no npm/pypi package and
 * no usable streamable-http remote, and the client's `ingest()` then drops it.
 * Such a record cannot ever be shown, yet serving it would occupy one of the 100
 * slots in a page and one of the 2000 slots in the browse cache — pushing out a
 * record that COULD be shown. Measured: 2,599 of 36,888 records are like this.
 *
 * The decision is made by the host's OWN extracted function
 * (generator/lib/host-mapper.generated.js), not by a reimplementation, because
 * the host also rejects records for subtler reasons — an env placeholder that is
 * not declared in `requiredEnv`, a command containing "..", a url that is not
 * public https. A hand-written approximation missed 12 of them.
 *
 * ---------------------------------------------------------------------------
 * ORDERING
 *
 * The client caches at most MAX_CACHED_ENTRIES = 2000 entries per source while
 * browsing, so only the first 2000 rows are reachable without searching. Entries
 * are therefore sorted by registry name, which is stable and deterministic, and
 * every served entry is installable and has both a title and a description.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Translator, nameTokens } from './lib/translate.js';
import { buildServedRecord } from '../shared/shape.js';
import { fold } from '../shared/fold.js';
import { mapRegistryServer } from './lib/host-mapper.generated.js';

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

/** D1 free tier, and the measured FTS5 shadow cost of the full dataset. */
const DAILY_WRITE_BUDGET = 100000;

/**
 * Rows written per entry, CALIBRATED against a real Cloudflare import.
 *
 * Counting the physical rows at rest is not the same as what D1 charges. A real
 * import of 34,279 entries reported 68,558 rows written (2.00/entry), while the
 * rows that exist afterwards add up to only 1.08/entry — the FTS5 index writes
 * internal rows as terms are added, and most of those merge away and leave no
 * trace. Charging is per row WRITTEN, so the honest figure is 2.00.
 *
 * See generator/measure-writes.js for the measurement, and
 * data/write-measure.json for the stored result.
 */
const ROWS_WRITTEN_PER_ENTRY = 2.0;

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
    onProgress: ({ mode, done, total, cacheSize }) => {
      if (done % 5000 === 0 || done === total) process.stdout.write(`    [${mode}] ${done}/${total}  (cache ${cacheSize})\n`);
    },
    // Only a run over the whole dataset knows which entries are dead; a --limit
    // run would throw away the rest of the cache.
    prune: limit === Infinity,
  });
  const secs = (Date.now() - t0) / 1000;
  const { routes } = translator.stats;
  console.log(
    `translated in ${secs.toFixed(0)}s | new ${translator.stats.miss} | cached ${translator.stats.hit} | ` +
      `requests ${translator.stats.requests} | failures ${translator.stats.failed}`,
  );
  console.log(
    `routes       : english ${routes.en} | other language ${routes.auto} | chinese/kanji ${routes.han} | ` +
      `detected as english ${translator.stats.detectedEnglish} | second chance ${translator.stats.secondChance}`,
  );

  // ---- build the rows -----------------------------------------------------
  const built = [];
  const dropReasons = new Map();
  const dupNames = [];
  const catCount = new Map();
  const idSeen = new Map();
  let duplicateIds = 0;
  let noTitle = 0;
  let noDesc = 0;

  for (const rec of records) {
    const src = rec?.server ?? {};
    if (!src.name) continue;

    const titleZh = typeof src.title === 'string' ? (map.get(src.title) ?? '') : '';
    const descZh = typeof src.description === 'string' ? (map.get(src.description) ?? '') : '';
    const entry = buildServedRecord(rec, { titleZh, descZh });

    // 1) The client would drop it, so serving it only wastes a page slot.
    //    The host's own mapper decides, not a reimplementation.
    const clientEntry = mapRegistryServer({ server: entry.served, _meta: entry.meta });
    if (!clientEntry) {
      const reason = entry.transportHint ?? 'no installable package or public https remote';
      dropReasons.set(reason, (dropReasons.get(reason) ?? 0) + 1);
      continue;
    }

    // 2) The client dedupes by derived id, first source wins, so a second record
    //    with the same id would be dropped on their side anyway. Skipping it here
    //    keeps the pagination cursor meaningful.
    if (idSeen.has(entry.id)) {
      duplicateIds += 1;
      if (dupNames.length < 10) dupNames.push(`${src.name}  ==  ${idSeen.get(entry.id)}`);
      continue;
    }
    idSeen.set(entry.id, src.name);

    if (!entry.served.title) noTitle += 1;
    if (!entry.served.description) noDesc += 1;
    catCount.set(entry.category, (catCount.get(entry.category) ?? 0) + 1);

    built.push({
      registryId: entry.id,
      sourceName: entry.sourceName,
      category: entry.category,
      transport: clientEntry.transport,
      record: { server: entry.served, _meta: entry.meta },
    });
  }

  built.sort((a, b) => a.sourceName.localeCompare(b.sourceName));

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
    //
    // The values inserted here are FOLDED bigrams, while the content table holds
    // the original Chinese. That is intentional and is the whole point of the
    // external-content setup: FTS5 never reads `servers` at index time, so a
    // `rebuild` command would index the UNFOLDED text and silently break every
    // Chinese search. The index must be fed fold()ed text here.
    searchRows.push([id, fold(s.title ?? ''), fold(s.description ?? '')]);
  });

  const dropped = [...dropReasons.values()].reduce((a, b) => a + b, 0);
  // A stable fingerprint of everything the market will actually see. Two runs
  // over unchanged upstream data produce the same hash, which lets the refresh
  // workflow skip the D1 import — and skip burning 68.6% of the daily write
  // budget — when there is nothing new to publish.
  const contentHash = createHash('sha256')
    .update(serverRows.map((r) => [r[1], r[4] ?? '', r[5] ?? '', r[7] ?? ''].join('\u0001')).join('\n'))
    .digest('hex')
    .slice(0, 16);

  const avgBytes = built.length ? Math.round(servedBytes / built.length) : 0;
  const estimatedWrites = Math.round(serverRows.length * ROWS_WRITTEN_PER_ENTRY);
  const stats = {
    generatedAt: new Date().toISOString(),
    contentHash,
    rawRecords: records.length,
    entries: built.length,
    dropped,
    dropReasons: Object.fromEntries([...dropReasons].sort((a, b) => b[1] - a[1])),
    duplicateIds,
    duplicateExamples: dupNames,
    withoutTitle: noTitle,
    withoutDescription: noDesc,
    categories: Object.fromEntries([...catCount].sort((a, b) => b[1] - a[1])),
    servedBytes,
    avgBytesPerRecord: avgBytes,
    responseBytesPerPage: avgBytes * 100,
    statementBytesCap: STATEMENT_BYTES,
    writes: {
      estimated: estimatedWrites,
      dailyBudget: DAILY_WRITE_BUDGET,
      rowsWrittenPerEntry: ROWS_WRITTEN_PER_ENTRY,
      basis: "calibrated against a real D1 import (see measure-writes.js)",
    },
    translation: { ...translator.stats, cacheSize: translator.cache.size },
  };
  fs.writeFileSync(path.join(DATA, 'stats.json'), JSON.stringify(stats, null, 2), 'utf8');

  console.log('--------------------------------------------');
  console.log('content hash :', stats.contentHash);
  console.log('             : this is what decides whether an import is worth its');
  console.log('             : write budget — if it matches what D1 publishes, nothing happens');
  console.log('raw records  :', stats.rawRecords);
  console.log('served       :', stats.entries, '(every one is installable and visible)');
  console.log('dropped      :', stats.dropped, '(the client would drop these; serving them wastes page slots)');
  for (const [reason, n] of Object.entries(stats.dropReasons)) console.log(`      [${n}] ${reason}`);
  console.log('duplicate ids:', stats.duplicateIds, '(skipped; must not appear in output)');
  for (const d of dupNames) console.log('      ', d);
  console.log('without title:', stats.withoutTitle, '| without description:', stats.withoutDescription);
  console.log('categories   :', JSON.stringify(stats.categories));
  console.log('avg record   :', avgBytes, 'bytes  ->  ~', avgBytes * 100, 'bytes per 100-row page');
  console.log(`              (host caps a source response at 4 MB, so ~${(4194304 / (avgBytes * 100)).toFixed(0)}x headroom)`);
  console.log(
    `writes       : ~${estimatedWrites.toLocaleString()} rows ` +
      `(${ROWS_WRITTEN_PER_ENTRY.toFixed(2)}/entry, calibrated) = ` +
      `${((estimatedWrites / DAILY_WRITE_BUDGET) * 100).toFixed(0)}% of the ${DAILY_WRITE_BUDGET.toLocaleString()}/day ` +
      `free tier — imports in one shot`);

  if (has('no-sql')) {
    console.log('--no-sql: skipping SQL output');
    return;
  }

  const header = [
    '-- Generated by generator/step3-sql.js — do not edit by hand.',
    `-- ${stats.entries} entries, generated ${stats.generatedAt}.`,
    `-- ${stats.dropped} raw records were omitted because the client would drop them anyway.`,
    '-- Schema must already exist (generator/lib/schema.sql drops and recreates it).',
    '-- The `search` rows carry CJK-bigram-folded text, not the original Chinese:',
    '-- the index is FTS5 external-content, so it never reads `servers` itself.',
    '',
  ];
  const columns = ['id', 'registry_id', 'name', 'source_name', 'title', 'description', 'category', 'transport', 'json'];
  const searchColumns = ['rowid', 'title', 'description'];

  // Single file: the whole dataset fits in one day's write budget, so this is
  // what the deploy script imports.
  // The content hash is written as part of the same import, so /health can report
  // what is actually published without reading a single server row.
  const metaSql = [
    'INSERT INTO meta (key, value) VALUES',
    `  ('content_hash', '${stats.contentHash}'),`,
    `  ('published_at', '${stats.generatedAt}'),`,
    `  ('entries', '${stats.entries}')`,
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value;',
  ].join('\n');

  const single = [
    ...header,
    ...buildInserts('servers', columns, serverRows),
    ...buildInserts('search', searchColumns, searchRows),
    metaSql,
    '',
  ];
  const sqlPath = path.join(DATA, 'import.sql');
  fs.writeFileSync(sqlPath, single.join('\n'), 'utf8');

  const stmts = single.filter((s) => s.startsWith('INSERT')).length;
  console.log('wrote', sqlPath, `(${(fs.statSync(sqlPath).size / 1048576).toFixed(1)} MB, ${stmts} statements)`);

  // Chunked files, kept as a safety valve for a smaller daily budget.
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
        // Only the FINAL part writes the hash, so an interrupted multi-part import
        // cannot advertise a hash for data that was never fully loaded.
        ...(end === serverRows.length ? [metaSql] : []),
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
    console.log('   only needed if the daily write budget is smaller than this dataset');
  }
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e);
  process.exit(1);
});
