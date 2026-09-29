#!/usr/bin/env node
/**
 * One-command deploy.
 *
 *   node scripts/deploy.mjs
 *
 * Does everything between "I have a Cloudflare account" and "here is the URL to
 * paste into the market", and is safe to re-run:
 *
 *   1. resolves credentials — an API token if present, otherwise OAuth login
 *   2. creates the D1 database, or reuses it if it already exists
  *   3. writes its id into wrangler.toml
 *   4. applies the schema
 *   5. imports data/import.sql, and checks the REAL rows-written against the quota
 *   6. deploys the Worker and prints the source URL
 *
 * Re-running re-applies the schema (which drops and recreates the two tables) and
 * re-imports, so it doubles as the update path.
 *
 * ---------------------------------------------------------------------------
 * TWO WAYS TO AUTHENTICATE
 *
 *   A) CLOUDFLARE_API_TOKEN in the environment. Non-interactive, no browser.
 *      Create one at  My Profile -> API Tokens -> Create Token -> "Edit
 *      Cloudflare Workers" template (it includes D1 access). Then either:
 *
 *          $env:CLOUDFLARE_API_TOKEN = "..."      # this shell only
 *          setx CLOUDFLARE_API_TOKEN "..."        # persistent (new shells)
 *
 *      On Windows the token is ALSO read straight from HKCU\Environment when it
 *      is not in this process's environment block. That matters because a
 *      long-running app (PI-Desktop, an IDE, a terminal that was already open)
 *      keeps the environment it was started with, so a `setx` afterwards is
 *      invisible to process.env but perfectly readable from the registry.
 *
 *   B) `wrangler login` — opens a browser, you click Authorize, done. Nothing to
 *      copy. The temporary localhost:8976 callback server that wrangler starts
 *      for this exists only during those seconds; it is not part of the deployed
 *      service and disappears as soon as the token is stored.
 *
 * RUN IT WITH `node`, NOT `npm run`. On Windows `npm` is a PowerShell shim
 * (`npm.ps1`) that the default execution policy refuses to run, so `npm install`
 * and `npm run deploy:all` fail with "running scripts is disabled on this system"
 * before any of this code is reached.
 *
 * ---------------------------------------------------------------------------
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
 *   --login-only      resolve credentials, report status, then stop
 *   --check           report what would happen, change nothing
 *   --db=<name>       D1 database name (default mcp-zh)
 *   --worker=<name>   Worker name (default mcp-zh)
 *   --cloud           the database is already provisioned and bound (this is
 *                     what the Deploy to Cloudflare button's `deploy` script
 *                     uses): skip the lookup/create, and address the database
 *                     by BINDING name so a renamed database still works
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, saveProject, sourceUrl } from './lib/project.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const TOML = path.join(ROOT, 'wrangler.toml');
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

const PROJECT = loadProject();
// Defaults come from project.json so a rename or an account switch is a one-line
// edit in one file; the flags remain for ad-hoc deploys.
const DB_NAME = arg('db', PROJECT.databaseName);
const WORKER_NAME = arg('worker', PROJECT.workerName);
const SKIP_IMPORT = has('skip-import');
const LOGIN_ONLY = has('login-only');
const CHECK_ONLY = has('check');
const CLOUD = has('cloud');

function step(n, text) {
  console.log(`\n[${n}] ${text}`);
}

function fail(text, hint) {
  console.error(`\n  ERROR  ${text}`);
  if (hint) console.error(`         ${hint}`);
  process.exit(1);
}

/**
 * The D1 binding name from wrangler.toml.
 *
 * `wrangler d1 execute` accepts either a database name or a binding, and the
 * binding is the only one that keeps working when someone renames the database
 * in Cloudflare's setup form.
 */
function readBinding(tomlPath) {
  const m = /^\s*binding\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(tomlPath, 'utf8'));
  return m ? m[1] : 'DB';
}

/**
 * Read a user-scope environment variable on Windows.
 *
 * A process cannot see variables set after it started, so a `setx` performed
 * while PI-Desktop (or any long-running shell) is open never reaches process.env.
 * The registry value is still current, so it is read directly.
 */
function readUserEnv(name) {
  if (!isWindows) return null;
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `[Environment]::GetEnvironmentVariable('${name}','User')`],
      { encoding: 'utf8', timeout: 20000 },
    );
    const v = out.trim();
    return v ? v : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ token ----
const TOKEN = (() => {
  const fromEnv = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (fromEnv) return { value: fromEnv, source: 'process environment' };
  const fromRegistry = readUserEnv('CLOUDFLARE_API_TOKEN');
  if (fromRegistry) return { value: fromRegistry, source: 'HKCU\\Environment' };
  return null;
})();

/** Wrangler must see the token in ITS environment, not just ours. */
const CHILD_ENV = TOKEN
  ? { ...process.env, CLOUDFLARE_API_TOKEN: TOKEN.value, WRANGLER_SEND_METRICS: 'false' }
  : { ...process.env, WRANGLER_SEND_METRICS: 'false' };

/** Run wrangler through node directly, so the npm shim is never involved. */
function wrangler(args, { capture = false, allowFail = false } = {}) {
  const res = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
     cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
    env: CHILD_ENV,
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
    `run:  ${NPM} install     (npm.ps1 is blocked by the PowerShell execution policy, so use ${NPM})`,
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
console.log(
  `  credentials : ${TOKEN ? `API token from ${TOKEN.source} (ends …${TOKEN.value.slice(-4)})` : 'none — will use OAuth login'}`,
);

// ------------------------------------------------------------------ 1. login
step(1, 'resolving Cloudflare credentials');

let authed = false;
{
  const who = wrangler(['whoami'], { capture: true, allowFail: true });
  const out = who.out;

  if (who.code === 0 && !/not authenticated|not logged in/i.test(out)) {
    authed = true;
    const line = out.split('\n').map((l) => l.trim()).find((l) => l && !l.includes('⛅') && !l.includes('─'));
    console.log(`  ${line ?? 'authenticated'}`);
    if (/API Token/i.test(out)) console.log('  (authenticated via API token)');
  } else if (TOKEN) {
    // A token is present but rejected — say so precisely instead of falling back
    // to a browser prompt that would only confuse things.
    const detail = out.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('🪵') && !l.includes('⛅'));
    console.error('  the API token was rejected by Cloudflare:');
    for (const l of detail.slice(0, 6)) console.error(`    ${l}`);
    console.error('');
    console.error('  common causes:');
    console.error('    - the token was copied incompletely or has whitespace');
    console.error('    - the token lacks the "Edit Cloudflare Workers" permission (needed for D1)');
    console.error('    - the token was deleted or expired in the dashboard');
    console.error('');
    console.error('  fix or remove it, then re-run:');
    console.error('    setx CLOUDFLARE_API_TOKEN ""          (to clear it)');
    process.exit(1);
  } else {
    // In --cloud mode credentials are Cloudflare's responsibility: the build
    // environment injects CLOUDFLARE_API_TOKEN, and there is no browser and no
    // stdin to authorise with. Falling through to `wrangler login` would hang
    // until the job times out and report nothing useful, so this fails fast and
    // names where the token is supposed to come from.
    if (CLOUD) {
      fail(
        'not authenticated, and --cloud never opens a browser',
        "CLOUDFLARE_API_TOKEN is missing from the environment.\n" +
          '         Inside Cloudflare\'s build environment it is injected automatically;\n' +
          '         locally, drop --cloud and run `node scripts/deploy.mjs`.',
      );
    }

    console.log('  no API token, and not logged in.');
    console.log('');
    console.log('  A FREE Cloudflare account is enough — no credit card, no payment method.');
    console.log('  If you do not have one yet, the page that opens has a Sign up link.');
    console.log('');
    console.log('  Opening the browser to authorise wrangler…');
    console.log('  (the localhost:8976 callback server wrangler starts here exists only');
    console.log('   for these few seconds, to receive the authorisation code. It has');
    console.log('   nothing to do with the deployed service, which runs on Cloudflare.)');
    console.log('');

    if (CHECK_ONLY) {
      console.log('  --check: would run `wrangler login` here. Stopping.');
      process.exit(0);
    }

    const login = wrangler(['login'], { allowFail: true });
    if (login.code !== 0) {
      console.log('');
      console.log('  `wrangler login` did not complete.');
      console.log('');
      console.log('  If the browser could not reach this machine (remote shell, container),');
      console.log('  use the device flow instead — it prints a short code to type in the');
      console.log('  browser, and needs no callback to localhost:');
      console.log('');
      console.log('    node node_modules/wrangler/bin/wrangler.js login --device');
      console.log('');
      console.log('  Or create an API token and set it (no browser at all):');
      console.log('    setx CLOUDFLARE_API_TOKEN "..."');
      process.exit(1);
    }

    const again = wrangler(['whoami'], { capture: true, allowFail: true });
    if (again.code !== 0 || /not authenticated/i.test(again.out)) {
      fail('still not logged in after `wrangler login`');
    }
    authed = true;
    console.log(`  ${again.out.trim().split('\n').filter(Boolean).pop()}`);
  }
}

if (!authed) fail('credentials could not be resolved');

if (LOGIN_ONLY) {
  console.log('\n--login-only: credentials are ready, stopping here.');
  process.exit(0);
}

// --------------------------------------------------------------- 2. database
//
// In --cloud mode the database already exists and is already bound: Cloudflare
// created it while setting up the Deploy to Cloudflare button, and rewrote
// database_id in wrangler.toml itself. Looking it up by NAME would break the
// moment someone types a different name into the setup form, so the binding is
// used instead — `wrangler d1 execute` accepts either a name or a binding.
const DB_BINDING = CLOUD ? readBinding(TOML) : DB_NAME;
let databaseId = null;

if (CLOUD) {
  step(2, `using the D1 binding "${DB_BINDING}"`);
  console.log('  --cloud: provisioned and bound during setup; nothing to look up or create');
} else {
  step(2, `resolving D1 database "${DB_NAME}"`);

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

  if (!databaseId && CHECK_ONLY) {
    console.log(`  --check: would create database "${DB_NAME}". Stopping.`);
    process.exit(0);
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
}

// --------------------------------------------------------------- 3. config
// In --cloud mode wrangler.toml is already correct: Cloudflare wrote the real
// database_id into it while provisioning, so rewriting it would be pointless
// and would dirty a checkout that is not ours to edit.
if (CLOUD) {
  step(3, 'wrangler.toml left as it is (--cloud)');
  console.log('  the database id was filled in by Cloudflare during setup');
} else {
  step(3, 'writing wrangler.toml');
  const toml = fs.readFileSync(TOML, 'utf8');
  const next = toml
    .replace(/^name\s*=\s*".*"$/m, `name = "${WORKER_NAME}"`)
    .replace(/^(database_id\s*=\s*)".*"$/m, `$1"${databaseId}"`);
  if (!/database_id\s*=\s*"/.test(next)) fail('wrangler.toml has no database_id line to fill in');
  fs.writeFileSync(TOML, next, 'utf8');
  console.log(`  database_id = ${databaseId}`);
}

if (CHECK_ONLY) {
  console.log('\n--check: everything above was a dry run; stopping before any writes.');
  process.exit(0);
}

// ----------------------------------------------------------------- 4. schema
step(4, 'applying schema (drops and recreates the two tables)');
wrangler(['d1', 'execute', DB_BINDING, '--remote', `--file=${SCHEMA_SQL}`, '-y']);
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
  const imported = wrangler(['d1', 'execute', DB_BINDING, '--remote', `--file=${IMPORT_SQL}`, '-y'], {
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
    ['d1', 'execute', DB_BINDING, '--remote', '--json', '--command',
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

// Record where this actually landed. The workflow and the DevTools snippet both
// read it from project.json, so a successful deploy keeps every copy in sync
// without anyone editing a URL by hand.
if (urlMatch) {
  saveProject({
    publicUrl: urlMatch[0].replace(/\/+$/, ''),
    accountId: PROJECT.accountId ?? null,
    deployedAt: new Date().toISOString(),
  });
}

console.log('\n============================================================');
if (endpoint) {
  console.log('  Done. Add this ONE source in the MCP market:\n');
  console.log(`    URL   ${endpoint}`);
  console.log('    Kind  registry\n');
  console.log('  Market -> Sources -> Add source, paste the URL, kind "registry".');
  console.log('\n  Recorded in project.json, so the snippet and the workflow stay in sync.');
  console.log('  Regenerate the DevTools snippet with: node scripts/make-snippet.mjs');
  console.log('\n  Verify it is live:');
  console.log(`    curl "${endpoint}?version=latest&limit=2"`);
  console.log(`    curl "${endpoint.replace('/servers', '/health')}"`);
} else {
  console.log('  Deployed, but the URL could not be read from the output above.');
  console.log('  It is on the line starting with "Deployed …".');
}
console.log('============================================================');
