/**
 * Why do some served titles contain no Chinese, or Chinese mixed with English?
 *
 * Uses the SAME lookup path as step3-sql.js (translateJobs -> map keyed by the
 * source text), not a direct cache probe. The earlier version of this check read
 * translator.cache.get(Translator.key(...)) directly, which produces false
 * "missing translation" reports whenever a title's protected-token set differs
 * between two records that share the same title.
 *
 * Buckets:
 *   pure-zh        fully translated, no latin left
 *   zh-brand       Chinese plus a protected brand/technical token  (by design)
 *   zh-suspect     Chinese plus a latin word that is NOT a brand and NOT a known
 *                  technical term — a partially translated title (a defect)
 *   en-brand       no Chinese at all, but the title is just a brand name (by design)
 *   en-defect      no Chinese and the title is ordinary prose (a defect)
 *
 *   node generator/check-titles.js [--examples=N]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Translator, GLOBAL_BRANDS } from './lib/translate.js';
import { GENERIC_WORDS, nameTokens } from './lib/glossary-words.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const showExamples = Number(arg('examples', '12'));

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const LATIN = /[A-Za-z][A-Za-z0-9.+#_-]*/g;

/** Technical tokens that are legitimately left in latin script. */
const KEEP_LATIN = new Set([
  'mcp', 'api', 'ai', 'sdk', 'cli', 'sql', 'json', 'xml', 'yaml', 'html', 'css', 'js', 'ts',
  'http', 'https', 'url', 'uri', 'rest', 'graphql', 'grpc', 'oauth', 'jwt', 'ssh', 'ftp', 'dns',
  'aws', 'gcp', 'azure', 'docker', 'k8s', 'kubernetes', 'git', 'github', 'gitlab', 'npm', 'pypi',
  'python', 'node', 'nodejs', 'rust', 'go', 'java', 'php', 'ruby', 'swift', 'kotlin', 'sql',
  'postgres', 'postgresql', 'mysql', 'mongo', 'mongodb', 'redis', 'sqlite', 'elasticsearch',
  'kafka', 'rabbitmq', 'supabase', 'snowflake', 'bigquery', 'clickhouse', 'duckdb',
  'openai', 'anthropic', 'claude', 'gpt', 'llm', 'slack', 'notion', 'jira', 'linear', 'asana',
  'stripe', 'shopify', 'salesforce', 'hubspot', 'zendesk', 'intercom', 'twilio', 'sendgrid',
  'aws', 's3', 'ec2', 'lambda', 'cloudflare', 'vercel', 'netlify', 'heroku', 'railway',
  'react', 'vue', 'svelte', 'angular', 'nextjs', 'nuxt', 'vite', 'webpack', 'tailwind',
  'vs', 'code', 'ide', 'ci', 'cd', 'os', 'ui', 'ux', 'pdf', 'csv', 'excel', 'word',
  'bing', 'google', 'youtube', 'twitter', 'facebook', 'instagram', 'linkedin', 'tiktok',
  'chrome', 'firefox', 'safari', 'edge', 'linux', 'windows', 'macos', 'ubuntu', 'debian',
  'ios', 'android', 'web', 'app', 'server', 'client', 'host', 'cloud', 'data', 'file',
]);
/** Product names the translator protects on purpose are not defects either. */
const GLOBAL_LOWER = new Set(GLOBAL_BRANDS.map((b) => b.toLowerCase()));

const raw = fs
  .readFileSync(path.join(DATA, 'raw.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

// Same path as step3: build the job list and resolve it from the cache only.
const translator = new Translator({ cachePath: path.join(DATA, 'translation-cache.json') });
const jobs = [];
for (const rec of raw) {
  const src = rec?.server ?? {};
  const extra = nameTokens(src.name);
  if (typeof src.title === 'string' && src.title.trim()) jobs.push({ text: src.title, extra });
}
const map = translator.resolveJobs(jobs);
console.log(`translation map size: ${map.size.toLocaleString()}   (cache ${translator.cache.size.toLocaleString()})`);
console.log('');

const buckets = {
  'pure-zh': [],
  'zh-brand': [],
  'zh-suspect': [],
  'en-brand': [],
  'en-defect': [],
};

const brandTokenCache = new Map();
function brandTokens(name) {
  if (!brandTokenCache.has(name)) {
    const t = [...nameTokens(name)].map((x) => x.toLowerCase());
    brandTokenCache.set(name, new Set(t));
  }
  return brandTokenCache.get(name);
}

let total = 0;
for (const rec of raw) {
  const src = rec?.server ?? {};
  const title = typeof src.title === 'string' ? src.title.trim() : '';
  if (!title) continue;
  total += 1;

  const zh = map.get(title) ?? '';
  const served = zh || title;
  const brands = brandTokens(src.name);

  const latin = [...new Set((served.match(LATIN) ?? []).map((w) => w.toLowerCase()))];
  const suspicious = latin.filter(
    (w) => w.length > 2 && !brands.has(w) && !KEEP_LATIN.has(w) && !GLOBAL_LOWER.has(w) && !GENERIC_WORDS?.has?.(w),
  );

  if (!CJK.test(served)) {
    // No Chinese anywhere. Is the whole title a brand, or is it prose?
    const words = title.split(/\s+/).filter(Boolean);
    const looksLikeProse = words.length >= 4 && title.length > 28;
    buckets[looksLikeProse ? 'en-defect' : 'en-brand'].push({ name: src.name, en: title, zh: served, latin });
    continue;
  }

  if (latin.length === 0) buckets['pure-zh'].push({ name: src.name, en: title, zh: served, latin });
  else if (suspicious.length === 0) buckets['zh-brand'].push({ name: src.name, en: title, zh: served, latin });
  else buckets['zh-suspect'].push({ name: src.name, en: title, zh: served, latin, suspicious });
}

const pct = (n) => `${((n / total) * 100).toFixed(1)}%`;
console.log(`titles examined: ${total.toLocaleString()}`);
console.log('');
console.log('=================== TITLE COMPOSITION ===================');
for (const [k, v] of Object.entries(buckets)) {
  console.log(`  ${k.padEnd(12)} ${String(v.length).padStart(7)}  ${pct(v.length)}`);
}
const good = buckets['pure-zh'].length + buckets['zh-brand'].length + buckets['en-brand'].length;
const bad = buckets['zh-suspect'].length + buckets['en-defect'].length;
console.log('');
console.log(`  by design    ${String(good).padStart(7)}  ${pct(good)}`);
console.log(`  DEFECTS      ${String(bad).padStart(7)}  ${pct(bad)}`);

for (const k of ['zh-suspect', 'en-defect']) {
  console.log('');
  console.log(`=================== ${k} (${buckets[k].length.toLocaleString()}) ===================`);
  for (const e of buckets[k].slice(0, showExamples)) {
    if (k === 'zh-suspect') {
      console.log(`  "${e.en}"`);
      console.log(`    -> "${e.zh}"   untranslated: ${e.suspicious.join(', ')}`);
    } else {
      console.log(`  ${e.name}`);
      console.log(`    -> "${e.en}"`);
    }
  }
}

console.log('');
console.log(`=================== zh-brand (by design, ${buckets['zh-brand'].length.toLocaleString()}) ===================`);
for (const e of buckets['zh-brand'].slice(0, showExamples)) console.log(`  "${e.en}"  ->  "${e.zh}"`);

const out = {
  generatedAt: new Date().toISOString(),
  total,
  counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
  defects: bad,
  suspectExamples: buckets['zh-suspect'].slice(0, 60).map((e) => ({ en: e.en, zh: e.zh, untranslated: e.suspicious })),
  defectExamples: buckets['en-defect'].slice(0, 60).map((e) => ({ name: e.name, en: e.en })),
};
fs.writeFileSync(path.join(DATA, 'title-audit.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('');
console.log('wrote data/title-audit.json');
