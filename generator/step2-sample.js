/**
 * Step 2 — translate a sample and print a quality report.
 *
 * This is the review gate: nothing is uploaded anywhere, it just shows the
 * Chinese output next to the English source so the glossary and the marker
 * protection can be judged before committing to a full 36k run.
 *
 *   node generator/step2-sample.js              # 200 records
 *   node generator/step2-sample.js --limit=40   # quicker look
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Translator, nameTokens } from './lib/translate.js';
import { buildServedRecord, guessCategory, registryIdFromName, installability } from '../shared/shape.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
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
  const limit = Number(arg('limit', '200'));
  const records = readRaw(limit);
  console.log(`loaded ${records.length} raw records`);

  const translator = new Translator({
    batchSize: 30,
    concurrency: 4,
    cachePath: path.join(DATA, 'translation-cache.json'),
  });

  // Brand tokens are derived from the registry name and protected per record, so
  // "JustIdea Agency" keeps its name while "Business Contact Finder" translates.
  const jobs = [];
  for (const rec of records) {
    const src = rec?.server ?? {};
    const extra = nameTokens(src.name);
    if (typeof src.title === 'string' && src.title.trim()) jobs.push({ text: src.title, extra });
    if (typeof src.description === 'string' && src.description.trim()) jobs.push({ text: src.description, extra });
  }
  console.log(`queued ${jobs.length} strings (titles + descriptions)`);

  const t0 = Date.now();
  const map = await translator.translateJobs(jobs, {
    onProgress: ({ done, total }) => {
      if (done % 150 === 0 || done === total) process.stdout.write(`    ${done}/${total}\n`);
    },
  });
  const secs = (Date.now() - t0) / 1000;

  console.log('--------------------------------------------');
  console.log(`translated in ${secs.toFixed(1)}s  |  engine requests ${translator.stats.requests}  |  failures ${translator.stats.failed}`);
  console.log(`cache hits ${translator.stats.hit}  |  new ${translator.stats.miss}`);
  if (secs > 0) console.log(`rate: ${(translator.stats.miss / secs).toFixed(1)} new strings/s`);

  // ---- build served records and audit them -------------------------------
  const served = [];
  const catDrift = [];
  let idCollisions = 0;
  let unmappable = 0;
  const catBefore = new Map();
  const catAfter = new Map();

  for (const rec of records) {
    const src = rec?.server ?? {};
    const extra = nameTokens(src.name);
    const titleZh = typeof src.title === 'string' ? (map.get(src.title) ?? '') : '';
    const descZh = typeof src.description === 'string' ? (map.get(src.description) ?? '') : '';
    const built = buildServedRecord(rec, { titleZh, descZh });
    const inst = installability(built.served);

    const b = guessCategory(src);
    const a = guessCategory(built.served);
    catBefore.set(b, (catBefore.get(b) ?? 0) + 1);
    catAfter.set(a, (catAfter.get(a) ?? 0) + 1);
    if (a !== b) catDrift.push({ name: src.name, before: b, after: a });
    if (registryIdFromName(src.name) === built.id) idCollisions += 1;
    if (!inst.ok) unmappable += 1;

    served.push({ ...built, installable: inst.ok, transport: inst.transport ?? null });
  }

  const fmt = (m) => [...m.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k}=${v}`).join('  ');
  console.log('--------------------------------------------');
  console.log('category BEFORE :', fmt(catBefore));
  console.log('category AFTER  :', fmt(catAfter));
  console.log('category drift  :', catDrift.length, '(must be 0)');
  console.log('id collisions   :', idCollisions, '(must be 0)');
  console.log('installable     :', records.length - unmappable, `/ ${records.length}  (${(((records.length - unmappable) / records.length) * 100).toFixed(1)}%)`);

  const outPath = path.join(DATA, `sample-${limit}.json`);
  fs.writeFileSync(outPath, JSON.stringify(served, null, 2), 'utf8');
  console.log('wrote', outPath);

  // ---- human-readable review --------------------------------------------
  console.log('\n=================== SIDE BY SIDE (first 20) ===================');
  for (const s of served.slice(0, 20)) {
    const src = records.find((r) => (r?.server?.name ?? '') === s.sourceName)?.server ?? {};
    console.log('--------------------------------------------------');
    console.log('name  :', s.sourceName, ' | id:', s.id);
    console.log('cat   :', s.category, '->', guessCategory(s.served));
    console.log('EN ttl:', src.title ?? '(none)');
    console.log('ZH ttl:', s.served.title);
    console.log('EN dsc:', src.description ?? '(none)');
    console.log('ZH dsc:', s.served.description);
    console.log('trans :', s.transport ?? 'NOT INSTALLABLE');
  }

  // ---- quality heuristics ------------------------------------------------
  const hasCjk = /[\u4e00-\u9fff]/;
  const leftover = served.filter((s) => /\[\[A\d+\]\]/.test(`${s.served.title} ${s.served.description}`));
  const noCjk = served.filter((s) => !hasCjk.test(`${s.served.title} ${s.served.description}`));
  const tooLong = served.filter((s) => (s.served.description ?? '').length > 160);

  console.log('\n=================== QUALITY CHECKS ===================');
  console.log('leftover [[An]] markers :', leftover.length, '(must be 0)');
  for (const s of leftover.slice(0, 5)) console.log('   ', s.sourceName, '|', s.served.description?.slice(0, 80));
  console.log('no Chinese at all       :', noCjk.length);
  for (const s of noCjk.slice(0, 5)) console.log('   ', s.sourceName, '|', (s.served.title ?? '').slice(0, 50));
  console.log('description > 160 chars :', tooLong.length, '(cards truncate visually around there)');
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e);
  process.exit(1);
});
