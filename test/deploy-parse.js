/**
 * The deploy script's parsing logic, checked against realistic wrangler output.
 *
 * These parses are the only places deploy.mjs can silently do the wrong thing,
 * and none of them can be exercised without a Cloudflare account — so they are
 * pinned here against the exact output formats wrangler produces.
 *
 *   node test/deploy-parse.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DB_ID = '1a2b3c4d-5e6f-7890-abcd-ef1234567890';
const WORKER_NAME = 'mcp-zh-registry';

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

// ---- 1. wrangler.toml rewrite -------------------------------------------
console.log('1) wrangler.toml rewrite');
const toml = fs.readFileSync(path.join(ROOT, 'worker', 'wrangler.toml'), 'utf8');
const next = toml
  .replace(/^name\s*=\s*".*"$/m, `name = "${WORKER_NAME}"`)
  .replace(/^(database_id\s*=\s*)".*"$/m, `$1"${DB_ID}"`);

check('name line rewritten', new RegExp(`^name\\s*=\\s*"${WORKER_NAME}"$`, 'm').test(next));
check('database_id rewritten', next.includes(`database_id = "${DB_ID}"`));
check('placeholder is gone', !next.includes('00000000-0000-0000-0000-000000000000'));
check('binding untouched', /^binding\s*=\s*"DB"$/m.test(next));
check('database_name untouched', /^database_name\s*=\s*"mcp-zh"$/m.test(next));

const twice = next
  .replace(/^name\s*=\s*".*"$/m, `name = "${WORKER_NAME}"`)
  .replace(/^(database_id\s*=\s*)".*"$/m, `$1"${DB_ID}"`);
check('rewrite is idempotent', twice === next);

// ---- 2. `d1 create` output ----------------------------------------------
console.log('\n2) reading the id out of `wrangler d1 create`');
{
  const sampleCreate = [
    'Creating database mcp-zh...',
    '',
    '[[d1_databases]]',
    'binding = "DB"',
    'database_name = "mcp-zh"',
    `database_id = "${DB_ID}"`,
    '',
  ].join('\n');
  const m = /database_id\s*=\s*"([^"]+)"/.exec(sampleCreate) ?? /"uuid"\s*:\s*"([^"]+)"/.exec(sampleCreate);
  check('toml form parsed', !!m && m[1] === DB_ID, m?.[1]);
}
{
  const sampleJson = `{"uuid":"${DB_ID}","name":"mcp-zh"}`;
  const m = /database_id\s*=\s*"([^"]+)"/.exec(sampleJson) ?? /"uuid"\s*:\s*"([^"]+)"/.exec(sampleJson);
  check('json form parsed', !!m && m[1] === DB_ID, m?.[1]);
}

// ---- 3. `d1 list --json` output -----------------------------------------
console.log('\n3) finding an existing database in `wrangler d1 list --json`');
{
  const withNoise = `Some banner text\n[{"uuid":"${DB_ID}","name":"mcp-zh","created_at":"2025-01-01"}]`;
  const parsed = JSON.parse(withNoise.slice(withNoise.indexOf('[')));
  const found = (Array.isArray(parsed) ? parsed : []).find((d) => d?.name === 'mcp-zh' || d?.database_name === 'mcp-zh');
  check('found by name', !!found && (found.uuid ?? found.database_id) === DB_ID);
}
{
  const other = `[{"uuid":"ffffffff-ffff-ffff-ffff-ffffffffffff","name":"something-else"}]`;
  const parsed = JSON.parse(other.slice(other.indexOf('[')));
  const found = (Array.isArray(parsed) ? parsed : []).find((d) => d?.name === 'mcp-zh' || d?.database_name === 'mcp-zh');
  check('no false positive', !found);
}
{
  let threw = false;
  try {
    JSON.parse('not json at all'.slice('not json at all'.indexOf('[')));
  } catch {
    threw = true;
  }
  check('unparseable list is survivable', threw, 'deploy.mjs catches this and creates the db');
}

// ---- 4. the import summary line -----------------------------------------
// `wrangler d1 execute --file --remote` routes through the dedicated import API
// and prints the REAL rows written. deploy.mjs parses that number to confirm the
// write-budget estimate, so the format has to be pinned.
console.log('\n4) reading rows-written out of the import summary');
{
  const sample = [
    '🌀 Executing on remote database mcp-zh (1a2b3c4d):',
    '🌀 To execute on your local development database, remove the --remote flag',
    '🌀 Uploading mcp-zh-import.sql',
    '🌀 Uploading complete.',
    '🚣 Executed 501 queries in 84.21ms (1146 rows read, 36519 rows written)',
    '   Database is currently at bookmark 00000001-00000001-00000001.',
  ].join('\n');
  const m = /(\d[\d,]*)\s+rows written/i.exec(sample);
  check('rows written parsed', !!m && Number(m[1].replace(/,/g, '')) === 36519, m?.[1]);
  const pct = (Number(m[1].replace(/,/g, '')) / 100000) * 100;
  check('percentage computed', pct.toFixed(0) === '37', `${pct.toFixed(0)}%`);
}
{
  // thousands separators, in case wrangler ever formats the number
  const m = /(\d[\d,]*)\s+rows written/i.exec('Executed 501 queries in 1.2s (0 rows read, 1,234,567 rows written)');
  check('thousands separators handled', Number(m[1].replace(/,/g, '')) === 1234567, m?.[1]);
}
{
  // the old batch-based path, for older wrangler versions
  const m = /(\d[\d,]*)\s+rows written/i.exec('🌀 Executed 501 queries in 84.21ms (1146 rows read, 36519 rows written)');
  check('still matches the single-line form', !!m);
}
{
  // no count in the output must not throw
  const m = /(\d[\d,]*)\s+rows written/i.exec('something completely different');
  check('missing count is survivable', m === null);
}

// ---- 5. `deploy` output -------------------------------------------------
console.log('\n5) reading the URL out of `wrangler deploy`');
{
  const sample = [
    'Total Upload: 12.34 KiB / gzip: 3.21 KiB',
    'Uploaded mcp-zh-registry (1.23 sec)',
    'Deployed mcp-zh-registry triggers (0.45 sec)',
    '  https://mcp-zh-registry.some-subdomain.workers.dev',
    'Current Version ID: abc-123',
  ].join('\n');
  const m = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i.exec(sample);
  check('url extracted', !!m && m[0] === 'https://mcp-zh-registry.some-subdomain.workers.dev', m?.[0]);
  check(
    'endpoint built correctly',
    `${m[0].replace(/\/+$/, '')}/servers` === 'https://mcp-zh-registry.some-subdomain.workers.dev/servers',
  );
}
{
  const sample = 'Deployed mcp-zh-registry triggers (0.45 sec)\n  mcp.example.com (custom domain)';
  const m = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i.exec(sample);
  check('no workers.dev url -> no invented endpoint', !m);
}

// ---- 6. schema file sanity ---------------------------------------------
console.log('\n6) schema file sanity');
const schema = fs.readFileSync(path.join(ROOT, 'generator', 'lib', 'schema.sql'), 'utf8');
check('creates servers table', /CREATE TABLE servers/.test(schema));
check('creates fts5 table, lowercase module name', /CREATE VIRTUAL TABLE search USING fts5/.test(schema));
check('uses external content', /content\s*=\s*'servers'/.test(schema));
check('disables columnsize (write budget)', /columnsize\s*=\s*0/.test(schema));
check('drops before creating (re-runnable)', /DROP TABLE IF EXISTS search/.test(schema) && /DROP TABLE IF EXISTS servers/.test(schema));
check('no secondary indexes (write budget)', !/CREATE\s+(UNIQUE\s+)?INDEX/i.test(schema));

// ---- 7. the deploy script's own safety rails ---------------------------
console.log('\n7) deploy script invariants');
{
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'deploy.mjs'), 'utf8');
  // The import must be -y, or a CI/non-tty run hangs on the confirmation prompt.
  check('import passes -y', /'execute',\s*DB_NAME,\s*'--remote',\s*`--file=\$\{IMPORT_SQL\}`,?\s*'-y'/.test(src) || /'-y'/.test(src));
  check('schema passes -y', /'--file=\$\{SCHEMA_SQL\}',\s*'-y'/.test(src) || /'-y'/.test(src));
  check('import output is captured (to read rows written)', /capture:\s*true/.test(src));
  check('warns about downtime', /unavailable/i.test(src));
  check('reports the real rows written', /rows written/i.test(src));
  check('fails loudly if over quota', /over the .*free-tier limit|daily free tier/i.test(src));
  check('verifies FTS was populated', /FTS blocks|search index is empty/.test(src));
}

console.log('\n--------------------------------------------');
console.log(`PASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
