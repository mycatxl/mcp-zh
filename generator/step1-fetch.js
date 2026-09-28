/**
 * Step 1 — fetch the whole official registry to disk.
 *
 * Writes data/raw.jsonl (one registry record per line) plus data/raw.meta.json.
 * Streaming to JSONL means a crash or Ctrl-C does not lose the pages already
 * pulled: rerun with --resume to continue from the last cursor.
 *
 *   node generator/step1-fetch.js                 # full crawl
 *   node generator/step1-fetch.js --max-pages=5   # smoke test
 *   node generator/step1-fetch.js --resume        # continue an interrupted crawl
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchAll, getJson, BASE } from './lib/registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const jsonl = path.join(DATA, 'raw.jsonl');
  const metaPath = path.join(DATA, 'raw.meta.json');
  const resume = has('resume');
  const maxPages = Number(arg('max-pages', '0')) || Infinity;

  let out;
  let resumeCursor;
  let startPage = 0;

  if (resume && fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    resumeCursor = meta.nextCursor;
    startPage = meta.page ?? 0;
    out = fs.createWriteStream(jsonl, { flags: 'a' });
    console.log(`resuming from cursor ${resumeCursor} (page ${startPage})`);
  } else {
    out = fs.createWriteStream(jsonl, { flags: 'w' });
    console.log('starting fresh crawl');
  }

  const head = await getJson(`${BASE}?version=latest&limit=1`);
  console.log('endpoint reachable; sample record keys:', Object.keys(head.servers?.[0]?.server ?? {}).join(', '));

  let lastLog = Date.now();
  const started = Date.now();
  let written = 0;

  const finish = await fetchAll({
    limit: 100,
    maxPages,
    resumeFrom: resumeCursor,
    onBatch: (records) => {
      out.write(records.map((r) => JSON.stringify(r)).join('\n') + '\n');
      written += records.length;
    },
    onProgress: ({ page, total, inPage, next }) => {
      if (Date.now() - lastLog > 4000 || page % 50 === 0) {
        const mins = ((Date.now() - started) / 60000).toFixed(1);
        process.stdout.write(`  page ${startPage + page}  collected ${total}  (last page ${inPage})  ${mins}min\n`);
        lastLog = Date.now();
      }
      fs.writeFileSync(
        metaPath,
        JSON.stringify({ page: startPage + page, total, nextCursor: next, at: new Date().toISOString() }, null, 2),
        'utf8',
      );
    },
  });

  await new Promise((res) => out.end(res));

  const lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).length;
  const bytes = fs.statSync(jsonl).size;
  console.log('--------------------------------------------');
  console.log('pages fetched :', finish.page);
  console.log('records this run:', written);
  console.log('lines on disk :', lines);
  console.log('bytes         :', bytes, `(${(bytes / 1048576).toFixed(1)} MB)`);
  console.log('elapsed       :', ((Date.now() - started) / 60000).toFixed(1), 'min');
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e);
  process.exit(1);
});
