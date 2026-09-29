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
 *   node scripts/make-snippet.mjs                        # print it
 *   node scripts/make-snippet.mjs --write                # also write docs/console-snippet.txt
 *   node scripts/make-snippet.mjs --url=https://…        # for a deployment project.json does not know
 *
 * --url exists because the deployed URL is only recorded when a deploy runs
 * HERE. Cloudflare's build checkout writes project.json inside its own
 * workspace and never pushes it back, so after a one-click deploy the
 * repository copy still has no URL and this script would refuse to run. The
 * flag is for exactly that case.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, sourceUrl, OFFICIAL_SOURCE, ROOT } from './lib/project.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = loadProject();

const urlArg = process.argv.find((a) => a.startsWith('--url='));
let URL_ = urlArg ? urlArg.slice('--url='.length).trim() : sourceUrl(PROJECT);
if (URL_) URL_ = URL_.replace(/\/+$/, '');
// Accept the bare Worker origin as well as the full /servers endpoint, because
// the dashboard shows the origin and the market needs the endpoint.
if (URL_ && !/\/servers$/.test(URL_)) URL_ = `${URL_}/servers`;

if (!URL_) {
  console.error('no URL — project.json has no publicUrl, and no --url was given.');
  console.error('');
  console.error('Either deploy from this machine (which records the URL), or pass it:');
  console.error('  node scripts/make-snippet.mjs --url=https://mcp-zh.<your-subdomain>.workers.dev');
  process.exit(1);
}

if (!/^https:\/\/[\w.-]+\/servers$/.test(URL_)) {
  console.error(`that does not look like a registry endpoint: ${URL_}`);
  console.error('expected something like https://mcp-zh.example.workers.dev/servers');
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
