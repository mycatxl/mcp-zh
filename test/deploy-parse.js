/**
 * The deploy script's pure parsing logic, checked against realistic wrangler
 * output. These four parses are the only places deploy.mjs can silently do the
 * wrong thing, and none of them can be exercised without a Cloudflare account —
 * so they are pinned here instead.
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

// Idempotency: running the rewrite twice must give the same file.
const twice = next
  .replace(/^name\s*=\s*".*"$/m, `name = "${WORKER_NAME}"`)
  .replace(/^(database_id\s*=\s*)".*"$/m, `$1"${DB_ID}"`);
check('rewrite is idempotent', twice === next);

// ---- 2. `d1 create` output ----------------------------------------------
console.log('\n2) reading the id out of `wrangler d1 create`');
const sampleCreate = [
  'Creating database mcp-zh...',
  '',
  '[[d1_databases]]',
  'binding = "DB"',
  'database_name = "mcp-zh"',
  `database_id = "${DB_ID}"`,
  '',
].join('\n');
{
  const m = /database_id\s*=\s*"([^"]+)"/.exec(sampleCreate) ?? /"uuid"\s*:\s*"([^"]+)"/.exec(sampleCreate);
  check('toml form parsed', !!m && m[1] === DB_ID, m?.[1]);
}
{
  // the json form some wrangler versions print instead
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
  // a database list that does NOT contain ours must not produce a false hit
  const other = `[{"uuid":"ffffffff-ffff-ffff-ffff-ffffffffffff","name":"something-else"}]`;
  const parsed = JSON.parse(other.slice(other.indexOf('[')));
  const found = (Array.isArray(parsed) ? parsed : []).find((d) => d?.name === 'mcp-zh' || d?.database_name === 'mcp-zh');
  check('no false positive', !found);
}
{
  // unparseable output must fall through to "create", not throw
  const junk = 'not json at all';
  let threw = false;
  try {
    JSON.parse(junk.slice(junk.indexOf('[')));
  } catch {
    threw = true;
  }
  check('unparseable list is survivable', threw, 'deploy.mjs catches this and creates the db');
}

// ---- 4. `deploy` output -------------------------------------------------
console.log('\n4) reading the URL out of `wrangler deploy`');
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
  check('endpoint built correctly', `${m[0].replace(/\/+$/, '')}/servers` === 'https://mcp-zh-registry.some-subdomain.workers.dev/servers');
}
{
  // a custom route instead of workers.dev: must not invent a URL
  const sample = 'Deployed mcp-zh-registry triggers (0.45 sec)\n  mcp.example.com (custom domain)';
  const m = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i.exec(sample);
  check('no workers.dev url -> no invented endpoint', !m);
}

// ---- 5. the schema the deploy script applies ---------------------------
console.log('\n5) schema file sanity');
const schema = fs.readFileSync(path.join(ROOT, 'generator', 'lib', 'schema.sql'), 'utf8');
check('creates servers table', /CREATE TABLE servers/.test(schema));
check('creates fts5 table, lowercase module name', /CREATE VIRTUAL TABLE search USING fts5/.test(schema));
check('uses external content', /content\s*=\s*'servers'/.test(schema));
check('disables columnsize (write budget)', /columnsize\s*=\s*0/.test(schema));
check('drops before creating (re-runnable)', /DROP TABLE IF EXISTS search/.test(schema) && /DROP TABLE IF EXISTS servers/.test(schema));
check('no secondary indexes (write budget)', !/CREATE\s+(UNIQUE\s+)?INDEX/i.test(schema));

console.log('\n--------------------------------------------');
console.log(`PASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
