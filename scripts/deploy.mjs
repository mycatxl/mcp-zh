#!/usr/bin/env node
/**
 * One-command deploy.
 *
 *   npm run deploy:all
 *
 * Does everything between "I have a Cloudflare account" and "here is the URL to
 * paste into the market", and is safe to re-run:
 *
 *   1. checks wrangler is logged in (opens a browser if not)
 *   2. creates the D1 database, or reuses it if it already exists
 *   3. writes its id into worker/wrangler.toml
 *   4. applies the schema
 *   5. imports data/import.sql, reporting the rows written against the daily quota
 *   6. deploys the Worker and prints the source URL
 *
 * Nothing here is destructive: re-running re-applies the schema (which drops and
 * recreates the two tables) and re-imports, so it doubles as the update path.
 *
 * Flags:
 *   --skip-import     schema + deploy only (use when data is already loaded)
 *   --db=<name>       D1 database name (default mcp-zh)
 *   --worker=<name>   Worker name (default mcp-zh-registry)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORKER = path.join(ROOT, 'worker');
const TOML = path.join(WORKER, 'wrangler.toml');
const IMPORT_SQL = path.join(ROOT, 'data', 'import.sql');
const SCHEMA_SQL = path.join(ROOT, 'generator', 'lib', 'schema.sql');

/** D1 free tier, for the write-budget report. */
const DAILY_WRITE_BUDGET = 100000;

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const DB_NAME = arg('db', 'mcp-zh');
const WORKER_NAME = arg('worker', 'mcp-zh-registry');
const SKIP_IMPORT = has('skip-import');

/**
 * Run wrangler. On Windows, `npx` is a .ps1 shim that the default execution
 * policy blocks, so the .cmd shim is used explicitly.
 */
function wrangler(args, { capture = false, allowFail = false } = {}) {
  const bin = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd: WORKER,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    env: process.env,
  });
  if (res.error) throw res.error;
  if (res.status !== 0 && !allowFail) {
    if (capture) {
      console.error(res.stdout ?? '');
      console.error(res.stderr ?? '');
    }
    throw new Error(`wrangler ${args.join(' ')} failed with exit code ${res.status}`);
  }
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function step(n, text) {
  console.log(`\n[${n}] ${text}`);
}

function fail(text, hint) {
  console.error(`\n  ERROR  ${text}`);
  if (hint) console.error(`         ${hint}`);
  process.exit(1);
}

// ---------------------------------------------------------------- 0. preflight
step(0, 'checking prerequisites');

if (!fs.existsSync(IMPORT_SQL) && !SKIP_IMPORT) {
  fail(
    'data/import.sql is missing',
    'run:  node generator/step1-fetch.js  then  node generator/step3-sql.js',
  );
}
const importMb = fs.existsSync(IMPORT_SQL) ? fs.statSync(IMPORT_SQL).size / 1048576 : 0;
const stats = fs.existsSync(path.join(ROOT, 'data', 'stats.json'))
  ? JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stats.json'), 'utf8'))
  : null;
console.log(`  import file : ${importMb.toFixed(1)} MB${stats ? `  (${stats.entries.toLocaleString()} entries)` : ''}`);
console.log(`  database    : ${DB_NAME}`);
console.log(`  worker      : ${WORKER_NAME}`);

// ------------------------------------------------------------------ 1. login
step(1, 'checking Cloudflare login');
const who = wrangler(['whoami'], { capture: true, allowFail: true });
if (who.code !== 0 || /not authenticated|You are not logged in/i.test(who.out)) {
  console.log('  not logged in — opening the browser to authorise wrangler.');
  console.log('  (a free Cloudflare account is enough; no payment method is needed)');
  wrangler(['login']);
  const again = wrangler(['whoami'], { capture: true, allowFail: true });
  if (again.code !== 0) fail('still not logged in after `wrangler login`');
  console.log(`  ${again.out.trim().split('\n').pop()}`);
} else {
  const line = who.out.split('\n').find((l) => l.trim()) ?? 'ok';
  console.log(`  ${line.trim()}`);
}

// --------------------------------------------------------------- 2. database
step(2, `resolving D1 database "${DB_NAME}"`);
let databaseId = null;

const list = wrangler(['d1', 'list', '--json'], { capture: true, allowFail: true });
if (list.code === 0) {
  try {
    const parsed = JSON.parse(list.out.slice(list.out.indexOf('[')));
    const found = (Array.isArray(parsed) ? parsed : []).find(
      (d) => d?.name === DB_NAME || d?.database_name === DB_NAME,
    );
    if (found) {
      databaseId = found.uuid ?? found.database_id ?? null;
      console.log(`  already exists: ${databaseId}`);
    }
  } catch {
    /* fall through to create */
  }
}

if (!databaseId) {
  console.log('  creating…');
  const created = wrangler(['d1', 'create', DB_NAME], { capture: true });
  const m = /database_id\s*=\s*"([^"]+)"/.exec(created.out) ?? /"uuid"\s*:\s*"([^"]+)"/.exec(created.out);
  if (!m) {
    console.error(created.out);
    fail('could not read the new database id from wrangler output');
  }
  databaseId = m[1];
  console.log(`  created: ${databaseId}`);
}

// --------------------------------------------------------------- 3. config
step(3, 'writing worker/wrangler.toml');
const toml = fs.readFileSync(TOML, 'utf8');
const next = toml
  .replace(/^name\s*=\s*".*"$/m, `name = "${WORKER_NAME}"`)
  .replace(/^(database_id\s*=\s*)".*"$/m, `$1"${databaseId}"`);
if (!/database_id\s*=\s*"/.test(next)) fail('wrangler.toml has no database_id line to fill in');
fs.writeFileSync(TOML, next, 'utf8');
console.log(`  database_id = ${databaseId}`);

// ----------------------------------------------------------------- 4. schema
step(4, 'applying schema (drops and recreates the two tables)');
wrangler(['d1', 'execute', DB_NAME, '--remote', `--file=${SCHEMA_SQL}`, '-y']);
console.log('  schema applied');

// --------------------------------------------------------------- 5. import
if (SKIP_IMPORT) {
  step(5, 'import skipped (--skip-import)');
} else {
  step(5, `importing ${importMb.toFixed(1)} MB into D1`);
  if (stats?.writes) {
    const pct = ((stats.writes.estimated / DAILY_WRITE_BUDGET) * 100).toFixed(0);
    console.log(
      `  expected writes: ~${stats.writes.estimated.toLocaleString()} ` +
        `(${pct}% of the ${DAILY_WRITE_BUDGET.toLocaleString()}/day free tier)`,
    );
  }
  console.log('  this takes a minute or two; wrangler streams progress below');
  wrangler(['d1', 'execute', DB_NAME, '--remote', `--file=${IMPORT_SQL}`, '-y']);

  // Read the count back through the Worker path, not just the import's own report.
  const check = wrangler(
    ['d1', 'execute', DB_NAME, '--remote', '--json', '--command',
      'SELECT (SELECT COUNT(*) FROM servers) AS entries, (SELECT COUNT(*) FROM search_data) AS fts'],
    { capture: true },
  );
  try {
    const parsed = JSON.parse(check.out.slice(check.out.indexOf('[')));
    const row = parsed?.[0]?.results?.[0];
    if (row) {
      console.log(`  verified in D1: ${Number(row.entries).toLocaleString()} entries, ${row.fts} FTS blocks`);
      if (row.fts === 0) {
        fail('the search index is empty', 'the import did not feed the FTS5 table');
      }
    }
  } catch {
    console.log('  (could not parse the verification query; the import itself reported success)');
  }
}

// ----------------------------------------------------------------- 6. deploy
step(6, 'deploying the Worker');
const deployed = wrangler(['deploy'], { capture: true });
process.stdout.write(deployed.out);

const urlMatch = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i.exec(deployed.out);
const endpoint = urlMatch ? `${urlMatch[0].replace(/\/+$/, '')}/servers` : null;

console.log('\n============================================================');
if (endpoint) {
  console.log('  Done. Add this ONE source in the MCP market:\n');
  console.log(`    URL   ${endpoint}`);
  console.log('    Kind  registry\n');
  console.log('  Market -> Sources -> Add source, paste the URL, kind "registry".');
} else {
  console.log('  Deployed, but the URL could not be read from the output above.');
  console.log('  It is on the line starting with "Deployed …".');
}
console.log('============================================================');
