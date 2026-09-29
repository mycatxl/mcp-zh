/**
 * Generate the one-line DevTools snippet that registers this source in the market.
 *
 * WHY A GENERATOR: PI-Desktop never persists MCP market sources — the add-source
 * handler in SettingsPage-DYluaAwwD.js only calls a React state setter, while the
 * skill market next to it does call localStorage.setItem. So a source added
 * through the UI survives until the next remount and then vanishes. Writing
 * localStorage directly is the only way to make it stick.
 *
 * The snippet has to get four things exactly right, or the host's
 * sanitizeMarketSources() silently discards the entry with no error shown:
 *   - the id must match ^[a-z][a-z0-9_-]{0,63}$
 *   - the official source must be present, with its url and kind byte-identical
 *   - OUR entry must come FIRST, because a missing official source gets
 *     unshift()ed to the front, which would put English results ahead of ours
 *   - the value must be idempotent, so re-running does not duplicate anything
 *
 * All of that is verified against the host's own extracted function in
 * test/source-snippet.js. This script only emits the code; the test proves it.
 *
 *   node scripts/make-snippet.mjs            # print it
 *   node scripts/make-snippet.mjs --write    # also write docs/console-snippet.txt
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, sourceUrl, OFFICIAL_SOURCE, ROOT } from './lib/project.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = loadProject();
const URL_ = sourceUrl(PROJECT);

if (!URL_) {
  console.error('project.json has no publicUrl yet — deploy first:');
  console.error('  node scripts/deploy.mjs');
  console.error('');
  console.error('That writes the deployed URL back into project.json, and this script');
  console.error('then generates a snippet pointing at the real endpoint.');
  process.exit(1);
}

const snippet = [
  '(function(){',
  `var K='pi.mcp-market.sources.v1',`,
  `O=${JSON.stringify(OFFICIAL_SOURCE)},`,
  `Z=${JSON.stringify({ id: PROJECT.sourceId, name: PROJECT.sourceName, url: URL_, kind: 'registry' })};`,
  'var c=[];try{c=JSON.parse(localStorage.getItem(K))||[]}catch(e){c=[]}',
  'if(!Array.isArray(c))c=[];',
  // Keep any other custom sources the user added, drop stale copies of ours and
  // of the official entry, then write ours first and the official entry last.
  "var r=c.filter(function(s){return s&&s.id!=='" + PROJECT.sourceId + "'&&s.id!=='official'});",
  'localStorage.setItem(K,JSON.stringify([Z].concat(r,[O])));',
  'return JSON.parse(localStorage.getItem(K)).map(function(s){return s.id}).join(" > ")',
  '})()',
].join('');

const write = process.argv.includes('--write');
if (write) {
  const out = path.join(ROOT, 'docs', 'console-snippet.txt');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${snippet}\n`, 'utf8');
  console.log(`wrote ${out}`);
  console.log('');
}

console.log('Paste this into PI-Desktop DevTools (Settings -> General -> Developer mode, then F12):');
console.log('');
console.log(snippet);
console.log('');
console.log(`Expected output:  ${PROJECT.sourceId} > official`);
console.log('');
console.log('That reads as "our Chinese source is FIRST, the builtin English one last",');
console.log('which is what puts the Chinese cards on the market\'s first page.');
