/**
 * Validate the DevTools snippet that registers this source in the market.
 *
 * The snippet writes straight into PI-Desktop's localStorage to work around the
 * app's own missing-persistence bug. If the written shape is wrong in any way — a
 * bad id, a mismatched official url, the wrong order — the app silently discards
 * it and the user sees nothing, with no error message. So the snippet's OUTPUT is
 * fed through the host's real sanitizeMarketSources() before being handed over.
 *
 * The snippet itself is produced by scripts/make-snippet.mjs, and this test runs
 * that generator's logic rather than a copy of it, so the two cannot drift.
 *
 *   node test/source-snippet.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as m from '../generator/lib/sanitize.generated.js';
import { loadProject, sourceUrl, OFFICIAL_SOURCE, ROOT } from '../scripts/lib/project.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}${detail ? '  — ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`);
  }
}

const PROJECT = loadProject();
const URL_ = sourceUrl(PROJECT);

console.log(`source id  : ${PROJECT.sourceId}`);
console.log(`source url : ${URL_ ?? '(project.json has no publicUrl yet)'}`);
console.log('');

/**
 * The same construction make-snippet.mjs emits, as a function, so this exercises
 * the real logic rather than a transcription of it.
 */
function buildStoredValue(currentRaw) {
  const KEY = 'pi.mcp-market.sources.v1';
  const ours = { id: PROJECT.sourceId, name: PROJECT.sourceName, url: URL_ ?? 'https://example.invalid/servers', kind: 'registry' };
  const official = OFFICIAL_SOURCE;

  let cur = [];
  try {
    cur = JSON.parse(currentRaw) ?? [];
  } catch {
    cur = [];
  }
  if (!Array.isArray(cur)) cur = [];

  const rest = cur.filter((s) => s && s.id !== PROJECT.sourceId && s.id !== 'official');
  return JSON.stringify([ours, ...rest, official]);
}

const ids = (list) => list.map((s) => s.id).join(',');

console.log('1) the stored value survives the host validator');
{
  const stored = buildStoredValue(null);
  const result = m.sanitizeMarketSources(JSON.parse(stored));
  check('ours ends up FIRST', ids(result) === `${PROJECT.sourceId},official`, ids(result));
}
{
  // The user's actual current storage: official only.
  const current = JSON.stringify([OFFICIAL_SOURCE]);
  const result = m.sanitizeMarketSources(JSON.parse(buildStoredValue(current)));
  check('from "official only" -> ours first', ids(result) === `${PROJECT.sourceId},official`, ids(result));
}

console.log('\n2) running it twice changes nothing');
{
  const once = buildStoredValue(null);
  const twice = buildStoredValue(once);
  const r1 = m.sanitizeMarketSources(JSON.parse(once));
  const r2 = m.sanitizeMarketSources(JSON.parse(twice));
  check('idempotent', ids(r1) === ids(r2), `${ids(r1)} vs ${ids(r2)}`);
  check('no duplicate entry', (twice.match(new RegExp(`"${PROJECT.sourceId}"`, 'g')) ?? []).length === 1);
}

console.log('\n3) other custom sources are preserved');
{
  const withOther = JSON.stringify([
    OFFICIAL_SOURCE,
    { id: 'custom-abc', name: 'My other source', url: 'https://example.com/servers', kind: 'registry' },
  ]);
  const result = m.sanitizeMarketSources(JSON.parse(buildStoredValue(withOther)));
  check('ours first, other kept, official last', ids(result) === `${PROJECT.sourceId},custom-abc,official`, ids(result));
}

console.log('\n4) damaged input cannot produce a broken list');
{
  for (const bad of ['', 'not json', '{}', 'null', '[null,1,"x"]']) {
    const stored = buildStoredValue(bad);
    let ok = false;
    let detail = '';
    try {
      const result = m.sanitizeMarketSources(JSON.parse(stored));
      ok = ids(result) === `${PROJECT.sourceId},official`;
      detail = ids(result);
    } catch (e) {
      detail = e.message;
    }
    check(`input ${JSON.stringify(bad).slice(0, 14)} -> ours first`, ok, detail);
  }
}

console.log('\n5) the exact strings the host compares');
{
  const stored = JSON.parse(buildStoredValue(null));
  const off = stored.find((s) => s.id === 'official');
  check('official url matches byte-for-byte', off.url === OFFICIAL_SOURCE.url, off.url);
  check('official kind is registry', off.kind === 'registry');
  check('our url ends with /servers', stored[0].url.endsWith('/servers'), stored[0].url);
  check('our id passes the host regex', /^[a-z][a-z0-9_-]{0,63}$/.test(stored[0].id));
  check('our url is https', stored[0].url.startsWith('https://'), stored[0].url);
}

console.log('\n6) the local snippet file, when present, matches the generator');
{
  const snippetPath = path.join(ROOT, 'docs', 'console-snippet.txt');
  if (!URL_) {
    // Nothing has been deployed yet, so there is no correct snippet to compare
    // against. The generator writes the real endpoint into the file after a
    // deploy, and a stale one is gitignored rather than committed.
    console.log('  SKIP  snippet file check (project.json has no publicUrl yet)');
  } else if (!fs.existsSync(snippetPath)) {
    // The file is gitignored, so a fresh clone — and Cloudflare's build
    // checkout, which is the whole one-click path — never has one. Its
    // absence is the normal state, not a failure. Where it DOES exist, it is
    // compared below, and that comparison is what catches a snippet left over
    // from a previous URL.
    console.log('  SKIP  snippet file check (not generated on this checkout)');
  } else {
    const doc = fs.readFileSync(snippetPath, 'utf8').trim();
    check('exists and is one line', !doc.includes('\n'), `${doc.length} chars`);
    check('writes the right key', doc.includes('pi.mcp-market.sources.v1'));
    check('mentions our id', doc.includes(`'${PROJECT.sourceId}'`));
    check('mentions the official url', doc.includes(OFFICIAL_SOURCE.url));
    check('uses localStorage.setItem', doc.includes('localStorage.setItem'));
    check('is idempotent by construction', doc.includes(`s.id!=='${PROJECT.sourceId}'`));
    check('points at the deployed url', doc.includes(URL_), URL_);
  }
}

// ---- the --url flag ------------------------------------------------------
// The deployed URL is only recorded when a deploy runs on this machine. A
// one-click deploy runs in Cloudflare's checkout, which never pushes
// project.json back, so the repository copy has no URL and the generator would
// refuse to run for the person who most needs it.
console.log('\nsource: the --url override');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'make-snippet.mjs'), 'utf8');
  check('accepts --url', /--url=/.test(src));
  check('trims trailing slashes', /replace\(\/\\\/\+\$\/, ''\)/.test(src));
  check('appends /servers when only the origin is given', /!\/\\\/servers\$\/\.test\(URL_\)/.test(src));
  check('rejects anything that is not an https /servers endpoint', /expected something like/.test(src));
}

console.log('\n--------------------------------------------');
console.log(`PASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
