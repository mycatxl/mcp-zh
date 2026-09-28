#!/usr/bin/env node
/**
 * One-command deploy.
 *
 *   node scripts/deploy.mjs
 *
 * Does everything between "I have a Cloudflare account" and "here is the URL to
 * paste into the market", and is safe to re-run:
 *
 *   1. checks wrangler is installed and logged in (opens a browser if not)
 *   2. creates the D1 database, or reuses it if it already exists
 *   3. writes its id into worker/wrangler.toml
 *   4. applies the schema
 *   5. imports data/import.sql, and checks the REAL rows-written against the quota
 *   6. deploys the Worker and prints the source URL
 *
 * Re-running re-applies the schema (which drops and recreates the two tables) and
 * re-imports, so it doubles as the update path.
 *
 * RUN IT WITH `node`, NOT `npm run`. On Windows the `npm` command is a PowerShell
 * shim (`npm.ps1`) that the default execution policy refuses to run, so
 * `npm install` / `npm run deploy:all` fail with "running scripts is disabled on
 * this system" before any of this code is reached. Invoking node directly sidesteps
 * that entirely, and the npm scripts remain for machines where npm works.
 *
 * HOW THE IMPORT ACTUALLY WORKS, and why the file size is not a problem:
 * `wrangler d1 execute --file --remote` does not split the SQL and fire it off
 * statement by statement. It md5s the file, asks D1 to initialise an import, PUTs
 * the whole file to a signed R2 URL, then tells D1 to ingest it and polls until
 * done. So a 43 MB file goes up in one request, the import runs in a single
 * transaction, and if it fails the database returns to its previous state — a
 * failed run is always safe to retry. The only hard limits that apply are per
 * STATEMENT (100 KB) and per ROW (2 MB); test/limits.js checks both against the
 * generated file, because a statement over the limit fails with SQLITE_TOOBIG
 * only after the upload has already happened.
 *
 * The database is UNAVAILABLE to serve queries while the import runs, which is
 * why this is a deliberate manual step rather than something the daily workflow
 * does on a cron.
 *
 * Flags:
 *   --skip-import     schema + deploy only (use when data is already loaded)
 *   --login-only      just authorise with Cloudflare, then stop
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
const WRANGLER_BIN = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/** D1 free tier, for the write-budget report. */
const DAILY_WRITE_BUDGET = 100000;

const isWindows = process.platform === 'win32';
/** On Windows `npm` is blocked by the execution policy; the .cmd shim is not. */
const NPM = isWindows ? 'npm.cmd' : 'npm';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const DB_NAME = arg('db', 'mcp-zh');
const WORKER_NAME = arg('worker', 'mcp-zh-registry');
const SKIP_IMPORT = has('skip-import');
const LOGIN_ONLY = has('login-only');

function step(n, text) {
  console.log(`\n[${n}] ${text}`);
}

function fail(text, hint) {
  console.error(`\n  ERROR  ${text}`);
  if (hint) console.error(`         ${hint}`);
  process.exit(1);
}

/** Run wrangler through node directly, so the npm shim is never involved. */
function wrangler(args, { capture = false, allowFail = false } = {}) {
  const res = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
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

// ---------------------------------------------------------------- 0. preflight
step(0, 'checking prerequisites');

// Check this FIRST: without it, every later step fails with a confusing
// "failed with exit code 1" instead of saying what is actually missing.
if (!fs.existsSync(WRANGLER_BIN)) {
  fail(
    'wrangler is not installed (node_modules is missing or incomplete)',
    isWindows
      ? `run:  ${NPM} install     (npm.ps1 is blocked by the PowerShell execution policy, so use ${NPM})`
      : `run:  ${NPM} install`,
  );
}

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
console.log(`  wrangler    : ${WRANGLER_BIN.replace(ROOT + path.sep, '')}`);
console.log(`  import file : ${importMb.toFixed(1)} MB${stats ? `  (${stats.entries.toLocaleString()} entries)` : ''}`);
console.log(`  database    : ${DB_NAME}`);
console.log(`  worker      : ${WORKER_NAME}`);

// ------------------------------------------------------------------ 1. login
step(1, 'checking Cloudflare login');
const who = wrangler(['whoami'], { capture: true, allowFail: true });
const loggedIn = who.code === 0 && !/not authenticated|You are not logged in|not logged in/i.test(who.out);

if (!loggedIn) {
  console.log('  not logged in.');
  console.log('');
  console.log('  A FREE Cloudflare account is enough — no credit card, no payment method.');
  console.log('  If you do not have one yet, the browser page that opens has a Sign up link.');
  console.log('');
  console.log('  Now opening the browser to authorise wrangler…');
  console.log('  (if no browser opens, copy the URL that is printed below into one)');
  console.log('');

  const login = wrangler(['login'], { allowFail: true });
  if (login.code !== 0) {
    fail(
      'wrangler login did not complete',
      're-run this script, or run `node node_modules/wrangler/bin/wrangler.js login` yourself',
    );
  }

  const again = wrangler(['whoami'], { capture: true, allowFail: true });
  if (again.code !== 0 || /not authenticated/i.test(again.out)) {
    fail('still not logged in after `wrangler login`');
  }
  console.log(`  ${again.out.trim().split('\n').filter(Boolean).pop()}`);
} else {
  const line = who.out.split('\n').find((l) => l.trim() && !l.includes('⛅')) ?? 'ok';
  console.log(`  ${line.trim()}`);
}

if (LOGIN_ONLY) {
  console.log('\n--login-only: stopping here.');
  process.exit(0);
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
  console.log('  the database is unavailable while this runs — usually 1-3 minutes.');
  console.log('  the import is a single transaction, so a failure rolls back and is safe to retry.');

  // Captured rather than streamed, because the summary line carries the REAL
  // rows-written count — the only way to confirm the write-budget estimate
  // against what Cloudflare actually charged.
  const imported = wrangler(['d1', 'execute', DB_NAME, '--remote', `--file=${IMPORT_SQL}`, '-y'], {
    capture: true,
  });
  process.stdout.write(imported.out);

  const wrote = /(\d[\d,]*)\s+rows written/i.exec(imported.out);
  if (wrote) {
    const n = Number(wrote[1].replace(/,/g, ''));
    const pct = (n / DAILY_WRITE_BUDGET) * 100;
    console.log('');
    console.log(`  ACTUAL rows written: ${n.toLocaleString()}  (${pct.toFixed(0)}% of the daily free tier)`);
    if (n > DAILY_WRITE_BUDGET) {
      fail(
        `the import wrote ${n.toLocaleString()} rows, over the ${DAILY_WRITE_BUDGET.toLocaleString()}/day free-tier limit`,
        'it will resume working the next day; re-run with --skip-import to just redeploy',
      );
    }
    if (stats?.writes?.estimated) {
      const drift = ((n - stats.writes.estimated) / stats.writes.estimated) * 100;
      const note = Math.abs(drift) < 25 ? 'matches the estimate' : 'DIFFERS from the estimate — update step3';
      console.log(`  estimate was ${stats.writes.estimated.toLocaleString()}  (${drift > 0 ? '+' : ''}${drift.toFixed(0)}% — ${note})`);
    }
  } else {
    console.log('  (could not read a rows-written count from the output)');
  }

  // Read the count back through a separate query, not just the import's own report.
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
      if (Number(row.entries) === 0) fail('the servers table is empty after the import');
      if (Number(row.fts) === 0) fail('the search index is empty', 'the import did not feed the FTS5 table');
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
  console.log('\n  Verify it is live:');
  console.log(`    curl "${endpoint}?version=latest&limit=2"`);
  console.log(`    curl "${endpoint.replace('/servers', '/health')}"`);
} else {
  console.log('  Deployed, but the URL could not be read from the output above.');
  console.log('  It is on the line starting with "Deployed …".');
}
console.log('============================================================');
