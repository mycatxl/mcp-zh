/**
 * Refresh the dataset from the official registry.
 *
 *   node generator/update.js              # re-crawl everything, merge locally (~19 min)
 *   node generator/update.js --hours=24   # try the server-side delta first (may be slow)
 *
 * WHY A FULL RE-CRAWL IS THE DEFAULT:
 * the registry's `?updated_since=` filter works, but paginating it is extremely
 * slow on the server side — a single 100-record page took over 60 seconds in
 * testing, versus ~0.15 s for the unfiltered listing. Since a full crawl is only
 * ~19 minutes and is what a daily job would run anyway, re-crawling and diffing
 * locally is both faster in practice and far more reliable. The `--hours` path is
 * kept for narrow windows, where a couple of pages is genuinely cheap.
 *
 * Merging is by `server.name` (newest wins), then data/raw.jsonl is rewritten
 * atomically so an interrupted run cannot leave a half-written file. Translation
 * afterwards only costs anything for text that is actually new: the cache is
 * keyed on the source text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAll, getJson, BASE } from './lib/registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');
const RAW = path.join(DATA, 'raw.jsonl');
const META = path.join(DATA, 'update.meta.json');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

/** Server-side delta: only worth it for a narrow window. */
async function fetchDelta(sinceIso, { maxPages = 40, timeoutMs = 60000 } = {}) {
  const out = [];
  let cursor;
  let page = 0;
  while (page < maxPages) {
    const params = new URLSearchParams({ version: 'latest', limit: '100' });
    if (sinceIso) params.set('updated_since', sinceIso);
    if (cursor) params.set('cursor', cursor);
    let body;
    try {
      body = await getJson(`${BASE}?${params}`, { tries: 3, timeoutMs });
    } catch (e) {
      process.stderr.write(`    delta page ${page + 1} failed (${e.message}); stopping here\n`);
      break;
    }
    const servers = Array.isArray(body.servers) ? body.servers : [];
    out.push(...servers);
    page += 1;
    process.stdout.write(`    delta page ${page}: +${servers.length} (total ${out.length})\n`);
    const next = body.metadata?.nextCursor;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return out;
}

function readExisting() {
  const map = new Map();
  let torn = 0;
  if (!fs.existsSync(RAW)) return { map, torn };
  for (const line of fs.readFileSync(RAW, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      const name = rec?.server?.name;
      if (typeof name === 'string' && name) map.set(name, rec);
    } catch {
      torn += 1;
    }
  }
  return { map, torn };
}

async function main() {
  const hoursArg = arg('hours', null);
  const incremental = hoursArg !== null;
  const hours = Number(hoursArg ?? 24);
  const since = incremental ? new Date(Date.now() - hours * 3600 * 1000).toISOString() : null;

  console.log(`mode    : ${incremental ? `server-side delta (last ${hours}h)` : 'full re-crawl'}`);
  if (since) console.log(`since   : ${since}`);

  const before = readExisting();
  console.log(`existing: ${before.map.size} records${before.torn ? ` (${before.torn} torn lines ignored)` : ''}`);

  let fetched = [];
  if (incremental) {
    console.log('fetching delta...');
    fetched = await fetchDelta(since);
    if (!fetched.length) {
      console.log('delta came back empty; falling back to a full re-crawl');
      fetched = [];
    }
  }

  if (!fetched.length) {
    console.log('crawling the full registry (~19 min)...');
    let last = 0;
    const started = Date.now();
    await fetchAll({
      limit: 100,
      onBatch: (records) => {
        fetched.push(...records);
      },
      onProgress: ({ page, total }) => {
        if (Date.now() - last > 20000) {
          const mins = ((Date.now() - started) / 60000).toFixed(1);
          process.stdout.write(`    page ${page}  ${total} records  ${mins}min\n`);
          last = Date.now();
        }
      },
    });
    console.log(`crawled ${fetched.length} records`);
  }

  let added = 0;
  let updated = 0;
  for (const rec of fetched) {
    const name = rec?.server?.name;
    if (typeof name !== 'string' || !name) continue;
    if (before.map.has(name)) updated += 1;
    else added += 1;
    before.map.set(name, rec);
  }

  // Rewrite atomically: a crash mid-write must not destroy the dataset.
  const tmp = `${RAW}.tmp`;
  const stream = fs.createWriteStream(tmp, { flags: 'w' });
  for (const rec of before.map.values()) stream.write(JSON.stringify(rec) + '\n');
  await new Promise((res) => stream.end(res));
  fs.renameSync(tmp, RAW);

  const meta = {
    at: new Date().toISOString(),
    mode: incremental ? 'delta' : 'full',
    windowHours: incremental ? hours : null,
    fetched: fetched.length,
    added,
    updated,
    total: before.map.size,
  };
  fs.writeFileSync(META, JSON.stringify(meta, null, 2), 'utf8');

  console.log('--------------------------------------------');
  console.log('added   :', added);
  console.log('updated :', updated);
  console.log('total   :', before.map.size);
  console.log('wrote   :', RAW, `(${(fs.statSync(RAW).size / 1048576).toFixed(1)} MB)`);
  console.log('');
  console.log('next: node generator/step3-sql.js --chunk=8000');
  console.log('      (only new text hits the translation endpoint; the rest comes from cache)');
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e);
  process.exit(1);
});
