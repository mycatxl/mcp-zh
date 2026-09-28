/**
 * Print a human-readable summary of the last build, as a GitHub-flavoured
 * markdown table. Used by the refresh workflow's step summary, and handy locally.
 *
 *   node scripts/summary.mjs            # markdown (for $GITHUB_STEP_SUMMARY)
 *   node scripts/summary.mjs --text     # plain text for a terminal
 *
 * Reads data/stats.json, which generator/step3-sql.js writes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATS = path.join(ROOT, 'data', 'stats.json');

const asText = process.argv.includes('--text');

if (!fs.existsSync(STATS)) {
  console.error(`missing ${STATS} — run: node generator/step3-sql.js`);
  process.exit(1);
}

const s = JSON.parse(fs.readFileSync(STATS, 'utf8'));
const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : String(v ?? '—'));
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%` : '—');

const rows = [
  ['generated at', s.generatedAt ?? '—'],
  ['raw records fetched', n(s.rawRecords)],
  ['served entries', n(s.entries)],
  ['dropped (client would hide them)', n(s.dropped)],
  ['duplicate ids skipped', n(s.duplicateIds)],
  ['without title', n(s.withoutTitle)],
  ['without description', n(s.withoutDescription)],
  ['categories', Object.entries(s.categories ?? {}).map(([k, v]) => `${k} ${n(v)}`).join(', ')],
  ['avg record size', `${n(s.avgBytesPerRecord)} bytes`],
  ['page size (100 records)', `${n(s.responseBytesPerPage)} bytes`],
  ['response headroom vs 4 MB', `${(4194304 / (s.responseBytesPerPage || 1)).toFixed(0)}x`],
  [
    'estimated writes',
    `${n(s.writes?.estimated)} of ${n(s.writes?.dailyBudget)}/day (${pct(s.writes?.estimated, s.writes?.dailyBudget)})`,
  ],
  ['translation cache', n(s.translation?.cacheSize)],
  ['translation failures', n(s.translation?.failed)],
];

if (asText) {
  const width = Math.max(...rows.map((r) => r[0].length));
  for (const [k, v] of rows) console.log(`${k.padEnd(width)}  ${v}`);
  process.exit(0);
}

console.log('| metric | value |');
console.log('| --- | --- |');
for (const [k, v] of rows) console.log(`| ${k} | ${v} |`);

// Surface a broken build loudly rather than burying it in the table.
const problems = [];
if (s.translation?.failed) problems.push(`${n(s.translation.failed)} translation failures`);
if (s.dropped === 0 && s.rawRecords > 0) problems.push('nothing was dropped — suspicious, the client hides some records');
if (s.entries === 0) problems.push('no entries were produced');
if (s.writes?.estimated > (s.writes?.dailyBudget ?? Infinity)) problems.push('import exceeds the daily write budget');

if (problems.length) {
  console.log('');
  console.log('**attention**');
  for (const p of problems) console.log(`- ${p}`);
}
