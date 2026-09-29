#!/usr/bin/env node
/**
 * Make sure data/import.sql exists.
 *
 * Locally that file is produced by generator/step3-sql.js, which needs a ~19
 * minute crawl and a full translation pass first. That is the wrong thing to do
 * inside a build step, so this fetches the pre-built file instead: the refresh
 * workflow publishes it, together with a manifest, as a release asset on every
 * successful run.
 *
 * It runs in two very different places and has to behave in both:
 *
 *   * on a developer machine, where data/import.sql is usually already there
 *     from a local build — then this is a no-op, and it must not even require
 *     a seed url to be configured;
 *   * inside Cloudflare's build environment for the "Deploy to Cloudflare"
 *     button, where the repository is a fresh clone with no data directory at
 *     all and the only way to get a populated database is to download it.
 *
 * That order is why the "already present" check comes first: a configured seed
 * url is only a requirement when a download is actually going to happen.
 *
 * The manifest is what makes the download trustworthy. A truncated import file
 * imports silently and leaves a half-populated marketplace, so the gunzipped
 * bytes are checked against the published sha256 and length before the file is
 * put in place, and the write is atomic so an interrupted run cannot leave a
 * partial file behind for the next run to trust.
 *
 * Flags:
 *   --force        re-download even when data/import.sql is already usable
 *   --url=<gz>     override the seed location (defaults to project.json seedUrl)
 *   --check        report what would happen, download nothing
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadProject } from './lib/project.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');
const TARGET = path.join(DATA, 'import.sql');

/** Below this, a file is a leftover fragment rather than an import. */
const MIN_USABLE_BYTES = 1024 * 1024;

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const FORCE = process.argv.includes('--force');
const CHECK_ONLY = process.argv.includes('--check');

function fail(text, hint) {
  console.error(`\n  ERROR  ${text}`);
  if (hint) console.error(`         ${hint}`);
  process.exit(1);
}

const mb = (n) => (n / 1048576).toFixed(1);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// --------------------------------------------------------- is it already ok? --
// Checked BEFORE the seed url is required, so a machine that already built the
// data locally never needs one.
if (fs.existsSync(TARGET) && !FORCE) {
  const size = fs.statSync(TARGET).size;
  if (size >= MIN_USABLE_BYTES) {
    console.log(`data/import.sql already present (${mb(size)} MB) — nothing to do`);
    process.exit(0);
  }
  console.log(`data/import.sql is only ${size} bytes — treating it as a fragment and re-fetching`);
}

// ------------------------------------------------------------- where to get it --
const PROJECT = loadProject();
const SEED_URL = arg('url', PROJECT.seedUrl);
if (!SEED_URL) {
  fail(
    'data/import.sql is missing, and no seed url is configured to fetch it',
    'add "seedUrl" to project.json, or pass --url=https://…/import.sql.gz,\n' +
      '         or build the data locally:  node generator/step1-fetch.js && node generator/step3-sql.js',
  );
}
// The manifest sits next to the archive so one setting keeps both in sync.
const MANIFEST_URL = SEED_URL.replace(/[^/]+$/, 'MANIFEST.json');

if (CHECK_ONLY) {
  console.log(`--check: data/import.sql is missing (or --force was given)`);
  console.log(`         would download ${SEED_URL}`);
  console.log(`         plus           ${MANIFEST_URL}`);
  console.log(`         into           data/import.sql`);
  process.exit(0);
}

async function download(url, label) {
  process.stdout.write(`  fetching ${label}… `);
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    console.log('');
    fail(`could not reach ${url}`, e.message);
  }
  if (!res.ok) {
    console.log('');
    fail(
      `${url} returned HTTP ${res.status}`,
      res.status === 404
        ? 'the release asset is missing — run the refresh workflow once, which publishes it'
        : 'check the seed url in project.json',
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`${mb(buf.length)} MB`);
  return buf;
}

// ------------------------------------------------------------------- manifest --
const manifestBuf = await download(MANIFEST_URL, 'MANIFEST.json');
let manifest;
try {
  manifest = JSON.parse(manifestBuf.toString('utf8'));
} catch (e) {
  fail('MANIFEST.json is not valid JSON', e.message);
}
const expectedBytes = Number(manifest.bytes);
const expectedSha = String(manifest.sha256 ?? '');
if (!Number.isFinite(expectedBytes) || expectedBytes <= 0 || !/^[0-9a-f]{64}$/.test(expectedSha)) {
  fail(
    'MANIFEST.json is missing a usable bytes/sha256 pair',
    `got bytes=${manifest.bytes} sha256=${manifest.sha256}`,
  );
}
console.log(
  `  manifest: ${mb(expectedBytes)} MB, ${Number(manifest.entries ?? 0).toLocaleString()} entries, hash ${expectedSha.slice(0, 16)}…`,
);

// ------------------------------------------------------------------- archive --
const gz = await download(SEED_URL, SEED_URL.split('/').pop());

process.stdout.write('  decompressing… ');
let sql;
try {
  sql = zlib.gunzipSync(gz);
} catch (e) {
  fail('the downloaded archive is not valid gzip', e.message);
}
console.log(`${mb(sql.length)} MB`);

// ---------------------------------------------------------------- validation --
if (sql.length !== expectedBytes) {
  fail(
    `decompressed size is ${sql.length} bytes but the manifest says ${expectedBytes}`,
    'the download was truncated or the manifest is stale — re-run the refresh workflow',
  );
}
const actual = sha256(sql);
if (actual !== expectedSha) {
  fail(
    'the decompressed file does not match the published hash',
    `expected ${expectedSha}\n         actual   ${actual}`,
  );
}
// Cheap shape check: this is not trying to prove the file is the right dataset,
// only that a dump which happens to hash correctly is not an empty one.
if (!/INSERT\s+INTO\s+servers/i.test(sql.slice(0, 4096))) {
  fail('the archive does not look like an import file', 'expected INSERT INTO servers near the top');
}
console.log(`  hash verified (${actual.slice(0, 16)}…)`);

// --------------------------------------------------------------------- write --
fs.mkdirSync(DATA, { recursive: true });
const tmp = `${TARGET}.tmp`;
fs.writeFileSync(tmp, sql);
fs.renameSync(tmp, TARGET); // atomic: a partial file never becomes the real one
console.log(
  `\n  wrote data/import.sql — ${mb(sql.length)} MB, ${Number(manifest.entries ?? 0).toLocaleString()} entries`,
);
console.log('  ready for: node scripts/deploy.mjs');
