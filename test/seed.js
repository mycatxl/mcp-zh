/**
 * The one-click deploy path, pinned.
 *
 * The "Deploy to Cloudflare" button is the one part of this project that cannot
 * be exercised without clicking through Cloudflare's own setup page, so the
 * pieces it depends on are checked here instead:
 *
 *   * the repository layout Cloudflare reads before it provisions anything;
 *   * the two package.json script names it pre-fills its build and deploy
 *     fields from, which have to work in a FRESH CLONE — no data/ directory,
 *     no crawl, no translation cache;
 *   * the seed download's integrity checks, which stand between a truncated
 *     download and a silently half-populated marketplace;
 *   * the --cloud mode of scripts/deploy.mjs, which has to address the database
 *     by BINDING name rather than by name.
 *
 *   node test/seed.js
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadProject, seedManifestUrl } from '../scripts/lib/project.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

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
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---- 1. layout Cloudflare reads before it provisions ---------------------
// The button parses the wrangler config of the repo root to decide which
// resources to create. A config in a subdirectory is not found, and the result
// is a deployed Worker with no database bound to it — which looks like it
// worked until the first query returns nothing.
console.log('1) repository layout the button depends on');
{
  check('wrangler.toml is at the repository root', fs.existsSync(path.join(ROOT, 'wrangler.toml')));
  check('no stray copy under worker/', !fs.existsSync(path.join(ROOT, 'worker', 'wrangler.toml')));

  const toml = read('wrangler.toml');
  check('declares the DB binding', /\[\[d1_databases\]\]/.test(toml) && /^\s*binding\s*=\s*"DB"$/m.test(toml));
  check('names the database', /^\s*database_name\s*=\s*"mcp-zh"$/m.test(toml));
  // A real database id committed to a template repo would point every clone at
  // somebody else's database, so the placeholder has to survive until this
  // checkout has actually deployed. project.json's publicUrl is the signal for
  // "has deployed", so a fork that has deployed is not nagged about it.
  const placeholder = /database_id\s*=\s*"0{8}-0{4}-0{4}-0{4}-0{12}"/.test(toml);
  const everDeployed = !!loadProject().publicUrl;
  check(
    'carries an id for provisioning to replace, and not one of ours',
    placeholder || everDeployed,
    placeholder
      ? 'placeholder'
      : everDeployed
        ? 'real id, allowed: this checkout has deployed'
        : 'committed a real database id without ever deploying',
  );

  // `main` is resolved relative to the config file, so moving the config to the
  // root without fixing this would break the build.
  const main = /^\s*main\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  check('main points at the worker source', main === 'worker/src/index.js', main ?? '(missing)');
  check('that file exists', !!main && fs.existsSync(path.join(ROOT, main)));
}

// ---- 2. the two script names Cloudflare pre-fills ------------------------
// Cloudflare pre-populates its build and deploy fields from these names, so a

// `build` that needs a crawl is a build that fails for every new user.
console.log('\n2) package.json build/deploy are fresh-clone safe');

{
  const pkg = JSON.parse(read('package.json'));
  const build = pkg.scripts.build ?? '';
  const deploy = pkg.scripts.deploy ?? '';

  check('build exists', !!build, build);
  check('deploy exists', !!deploy, deploy);
  check('build does not crawl the registry', !/step1-fetch/.test(build));
  check('build does not translate', !/step3-sql/.test(build));
  check('build does not need data/raw.jsonl', !/raw\.jsonl/.test(build));
  check('build prepares the seed', /scripts\/seed\.mjs/.test(build));
  check('deploy uses --cloud', /--cloud/.test(deploy));
  check('translation moved to its own script', /generator\/step3-sql\.js/.test(pkg.scripts.translate ?? ''));

  // The deploy script needs wrangler at deploy time, and Cloudflare does not
  // guarantee devDependencies are installed — `npm ci --omit=dev` skips them
  // entirely, which would turn a one-click deploy into "wrangler is not
  // found". Hence a real dependency rather than a dev one.
  const lock = JSON.parse(read('package-lock.json'));
  const lockRoot = lock.packages?.[''] ?? {};
  check('wrangler is a runtime dependency, not a dev one', !!pkg.dependencies?.wrangler, pkg.dependencies?.wrangler);
  check('wrangler is not in devDependencies', !pkg.devDependencies?.wrangler);
  check(
    'the lock file records it the same way',
    lockRoot.dependencies?.wrangler === pkg.dependencies?.wrangler && !lockRoot.devDependencies?.wrangler,
    'npm ci fails outright when the two disagree',
  );

  // A build step that silently downloads 43 MB on a machine that already has
  // the data would be a nasty surprise, so seed.mjs has to no-op first. Checked
  // behaviourally in section 5.
  check('seed is also reachable as its own script', /seed\.mjs/.test(pkg.scripts.seed ?? ''));
}

// ---- 3. seed url and manifest derivation --------------------------------
console.log('\n3) seed url -> manifest url');
{
  const project = loadProject();

  check('project.json carries a seed url', typeof project.seedUrl === 'string' && !!project.seedUrl, project.seedUrl);

  const seed = project.seedUrl;
  check('seed url is https', /^https:\/\//.test(seed));
  check('seed url is a release download', /\/releases\/download\//.test(seed));
  check('seed url ends in import.sql.gz', /import\.sql\.gz$/.test(seed));
  check(
    'seed url is tag-pinned, not releases/latest',
    !/\/releases\/latest\//.test(seed),
    'releases/latest would follow whichever release was created most recently',
  );

  const manifest = seedManifestUrl(project);
  check('manifest sits beside the archive', manifest === 'https://github.com/mycatxl/mcp-zh/releases/download/data-latest/MANIFEST.json', manifest ?? '(null)');
  check('manifest derivation is a pure sibling swap', manifest === seed.replace(/[^/]+$/, 'MANIFEST.json'));
  check('no seed url -> null, not a broken url', seedManifestUrl({ seedUrl: null }) === null);
}

// ---- 4. manifest validation, and why it exists ---------------------------
// A truncated import file imports perfectly happily. The hash is the only thing
// standing between that and a marketplace with half the entries in it.
console.log('\n4) manifest validation and the download integrity check');
{
  const valid = /^[0-9a-f]{64}$/;
  const okSha = 'a'.repeat(64);
  check('accepts a 64-hex sha256', valid.test(okSha));
  check('rejects a truncated hash', !valid.test('a'.repeat(63)));
  check('rejects uppercase hex', !valid.test('A'.repeat(64)));
  check('rejects a non-hex hash', !valid.test('z'.repeat(64)));

  // The exact guard seed.mjs applies before trusting the archive.
  const usable = (m) => Number.isFinite(Number(m.bytes)) && Number(m.bytes) > 0 && valid.test(String(m.sha256 ?? ''));
  check('accepts a well-formed manifest', usable({ bytes: 45616699, sha256: okSha }));
  check('rejects a manifest with no bytes', !usable({ sha256: okSha }));
  check('rejects a manifest with zero bytes', !usable({ bytes: 0, sha256: okSha }));
  check('rejects a manifest with no hash', !usable({ bytes: 100 }));

  // Round trip: what seed.mjs computes on the way in must equal what the
  // publisher computed on the way out.
  const payload = Buffer.from('INSERT INTO servers VALUES (1);\n'.repeat(1000));
  const gz = zlib.gzipSync(payload);
  const back = zlib.gunzipSync(gz);
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  check('gzip round trip is byte-exact', back.equals(payload));
  check('hash survives the round trip', sha(back) === sha(payload), sha(payload).slice(0, 16) + '…');
  check('gzip actually shrinks it', gz.length < payload.length, `${payload.length} -> ${gz.length}`);

  // The shape check: a wrong file that happens to hash correctly is not the
  // threat model, an EMPTY one is.
  const looksLikeImport = (s) => /INSERT\s+INTO\s+servers/i.test(s.slice(0, 4096));
  check('recognises an import file', looksLikeImport('-- header\nINSERT INTO servers (id) VALUES (1);'));
  check('rejects an empty dump', !looksLikeImport('-- nothing here\n'));
  check('rejects an unrelated sql file', !looksLikeImport('CREATE TABLE t (a);\n'));
}

// ---- 5. seed.mjs: existing data wins ------------------------------------
// The order matters more than it looks: resolving the seed url first made
// `npm run build` fail on any machine that already had data/import.sql and had
// never configured a url. Local builds must not need the network at all.
console.log('\n5) seed.mjs checks for existing data before requiring a url');
{
  const src = read('scripts/seed.mjs');
  const existingAt = src.indexOf('already present');
  const urlRequirementAt = src.indexOf('no seed url is configured');

  check('both landmarks are present', existingAt !== -1 && urlRequirementAt !== -1);
  check(
    'the existing-file check comes first',
    existingAt !== -1 && urlRequirementAt !== -1 && existingAt < urlRequirementAt,
    'otherwise a local build with data on disk fails on a missing url',
  );
  check('has a --force escape hatch', /--force/.test(src));
  check('has a --check mode', /--check/.test(src));
  check('validates the decompressed length against the manifest', /sql\.length !== expectedBytes/.test(src));
  check('validates the sha256 before writing', /actual !== expectedSha/.test(src));
  check('writes atomically', /renameSync\(tmp, TARGET\)/.test(src));
  check('writes to a .tmp path before renaming it into place', /\$\{TARGET\}\.tmp/.test(src));
}

// ---- 6. --cloud mode addresses the database by binding -------------------
console.log('\n6) deploy.mjs --cloud uses the binding, not the name');
{
  const src = read('scripts/deploy.mjs');

  check('has a cloud flag', /const CLOUD = has\('cloud'\)/.test(src));
  check('resolves the binding from the config', /readBinding\(TOML\)/.test(src));
  check('reads the binding line out of wrangler.toml', /function readBinding/.test(src) && /binding\\s\*=\\s\*/.test(src));
  check('skips the name-based lookup in cloud mode', /const DB_BINDING = CLOUD \? readBinding\(TOML\) : DB_NAME/.test(src));
  check('skips rewriting the config in cloud mode', /wrangler\.toml left as it is/.test(src));

  // A browser prompt inside a build container hangs until the job times out
  // and reports nothing useful, so cloud mode has to fail fast instead.
  check('cloud mode cannot fall through to a browser login', /--cloud never opens a browser/.test(src));

  // --cloud on a checkout that has never deployed would address a binding that
  // points at nothing and die somewhere inside wrangler's own output. It has to
  // say what is actually wrong, and a dry run still has to exit 0.
  check('cloud mode refuses a placeholder database id', /PLACEHOLDER_DB_ID/.test(src));
  check('...and names the command that would work', /Drop --cloud to look the database up/.test(src));
  check('...while a dry run still reports and exits 0', /NOTE {2}--cloud cannot work on this checkout/.test(src));
  check('the placeholder id it compares against is the all-zero one', /PLACEHOLDER_DB_ID = '0{8}-0{4}-0{4}-0{4}-0{12}'/.test(src));
  check(
    'every d1 execute uses the binding',
    (src.match(/d1',\s*'execute',\s*DB_BINDING/g) ?? []).length >= 2 &&
      !/d1',\s*'execute',\s*DB_NAME/.test(src),
    'schema, import and the verification query',
  );
  check('the verification query also uses the binding', /'execute',\s*DB_BINDING,\s*'--remote',\s*'--json'/.test(src));

  // The binding must survive a rename, which is the whole reason it is used.
  const binding = (toml) => /^\s*binding\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? 'DB';
  check('binding found despite other lines', binding('# x\n[[d1_databases]]\nbinding = "MY_DB"\n') === 'MY_DB');
  check('binding unaffected by the database name', binding('binding = "OTHER"\ndatabase_name = "renamed-by-user"\n') === 'OTHER');
  check('falls back to DB when absent', binding('name = "x"\n') === 'DB');
}

// ---- 7. the scripts Cloudflare runs are the ones we think ---------------
console.log('\n7) wrangler invocations still work from the repository root');
{
  const src = read('scripts/deploy.mjs');
  check('wrangler runs from the root, where the config now is', /cwd: ROOT,/.test(src));
  check('the config path is the root one', /const TOML = path\.join\(ROOT, 'wrangler\.toml'\)/.test(src));
  check('no stale WORKER path variable', !/\bconst WORKER = /.test(src));
}

// ---- 8. a dry run must not write anything -------------------------------
// `--check` is documented as "report what would happen, change nothing". It
// used to write wrangler.toml and only THEN test the flag, so a dry run on a
// template checkout stamped somebody's account-specific database id into a
// tracked file — the exact thing the placeholder assertion above guards
// against. Structure is the point: the write has to live in the else-branch of
// a CHECK_ONLY test, not before it.
console.log('\n8) --check does not write wrangler.toml');
{
  const src = read('scripts/deploy.mjs');
  const writeAt = src.indexOf('fs.writeFileSync(TOML');
  const guardAt = writeAt === -1 ? -1 : src.lastIndexOf('if (CHECK_ONLY) {', writeAt);
  // The write must sit in that guard's else-branch.
  const elseAt = guardAt === -1 ? -1 : src.indexOf('} else {', guardAt);

  check('the config is written somewhere', writeAt !== -1);
  check('a dry-run guard precedes the write', guardAt !== -1);
  check(
    'the write is in the guard else-branch, not before it',
    guardAt !== -1 && elseAt !== -1 && guardAt < elseAt && elseAt < writeAt,
    'a guard that runs after the write is not a guard',
  );
  check('the dry run reports what it would have written', /--check: would set database_id/.test(src));
  check('and says nothing was written', /no files were written/.test(src));

  // Behavioural backstop. It holds in every environment: if credentials are
  // missing the run stops earlier, and if they are present it reaches the write
  // and must still not perform it.
  const tomlPath = path.join(ROOT, 'wrangler.toml');
  const before = fs.readFileSync(tomlPath);
  try {
    execFileSync(process.execPath, ['scripts/deploy.mjs', '--check'], { cwd: ROOT, stdio: 'pipe' });
  } catch {
    /* stopping early is fine; writing is not */
  }
  check(
    'running --check left wrangler.toml byte-identical',
    before.equals(fs.readFileSync(tomlPath)),
  );
}

// ---- 9. schema and import are gated together -----------------------------
// Once Cloudflare connects the repository it rebuilds on every push, and the
// refresh workflow pushes daily — so that path runs far more often than it
// has new data. Re-importing identical content would spend ~69% of the daily
// D1 write budget each time, on top of the import the refresh itself does.
//
// The gate has to cover BOTH steps. The schema DROPs and recreates the tables,
// so skipping the import while still applying the schema would leave a live
// marketplace serving from an empty database — worse than the wasted budget.
//
// The schema and the data now travel as ONE file, which is the stronger form of
// the same rule: a failure between the DROP and the INSERTs is impossible.
console.log('\n9) identical content is not re-imported');
{
  const src = read('scripts/deploy.mjs');
  const gateAt = src.indexOf('let reimport = !SKIP_IMPORT');
  const skipAt = src.indexOf('if (!reimport) {', gateAt);
  const bundleAt = src.indexOf("step(4, 'bundling", gateAt);
  const importAt = src.indexOf('`importing ${importMb', gateAt);

  check('the gate exists', gateAt !== -1);
  check('it reads the published hash from D1', /publishedHash\(DB_BINDING\)/.test(src));
  check('the query is against the meta table', /SELECT value FROM meta WHERE key = 'content_hash'/.test(src));

  // Structure: the schema and the import must both live in the else-branch of
  // the SAME gate, so neither can run without the other.
  check('a skip branch exists', skipAt !== -1 && skipAt > gateAt);
  check(
    'the schema is bundled with the data, not applied on its own',
    bundleAt !== -1 && skipAt < bundleAt && /readFileSync\(SCHEMA_SQL/.test(src),
    'applying the schema without the import would empty the live database',
  );
  check('no separate schema call survives', !/--file=\$\{SCHEMA_SQL\}/.test(src));
  check('the import runs after the bundle, in the same branch', importAt !== -1 && bundleAt < importAt);
  check('the skip branch says the database is untouched', /the database is left exactly as it is/.test(src));

  // A missing hash must mean "import". The first run has no meta table at all,
  // and a transient query failure must not read as "already up to date".
  check('publishedHash returns null on failure', /if \(res\.code !== 0\) return null;/.test(src));
  check('...and null is treated as a first run, not as a match', /live === null/.test(src) && /importing as a first run/.test(src));
  check('the comparison only skips on an exact match', /if \(live === localHash\)/.test(src));

  // Escape hatches.
  check('--force defeats the gate', /reimport && CLOUD && !FORCE/.test(src));
  check('--skip-import now leaves the database alone too', /let reimport = !SKIP_IMPORT/.test(src));
  check('both flags are documented', /--force\s{11}re-import even when/.test(src) && /--skip-import\s{5}deploy only/.test(src));
}

// ---- 10. the refresh workflow can actually read the published hash -------
// It used to read /health, which needs the deployed URL — and that URL is in
// project.json, which only ever gets written inside Cloudflare's build
// checkout. Not pushed back to the repository, so it stays null on the
// one-click flow, no hash is ever read, and every daily run re-imports
// identical content. Asking D1 directly removes the whole chain.
console.log('\n10) the refresh workflow reads the hash from D1, not /health');
{
  const script = read('scripts/published-hash.mjs');
  const wf = read('.github/workflows/refresh.yml');

  check('the helper exists and queries meta directly', /SELECT value FROM meta WHERE key = 'content_hash'/.test(script));
  check('it addresses the database by binding', /binding\s*=\s*"\(\[\^"\]\+\)"/.test(script) || /execFileSync\(\s*process\.execPath,\s*\[WRANGLER_BIN, 'd1', 'execute', binding/.test(script));
  check('it prints the hash and nothing else on stdout', /process\.stdout\.write\(hash\)/.test(script));
  check('diagnostics go to stderr, so stdout stays clean', /console\.error\(msg\)/.test(script));

  // Every failure has to mean "publish". Being wrong that way costs one import;
  // being wrong the other way leaves the marketplace stale forever.
  check('a missing meta table is survivable', /try \{/.test(script) && /catch \(e\) \{/.test(script));
  check('...and is treated as a first publish', /treating this as a first publish/.test(script));
  check('a missing token does not hang on an interactive login', /no CLOUDFLARE_API_TOKEN; reporting/.test(script));
  check('it always exits 0', /process\.exit\(0\);/.test(script) && !/process\.exit\(1\)/.test(script));

  // Wiring.
  check('the workflow calls the helper', /node scripts\/published-hash\.mjs/.test(wf));
  check('...and no longer fetches it with curl', !/curl[^\n]*health/i.test(wf));
  check('...nor derives a URL for it', !/sourceUrl\(\)/.test(wf));
  check('...with the credentials it needs', /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/.test(wf));
  check('the hash still reaches the decide step', /echo "hash=\$HASH" >> "\$GITHUB_OUTPUT"/.test(wf));
}

console.log('\n--------------------------------------------');
console.log(`PASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
