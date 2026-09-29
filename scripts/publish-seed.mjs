#!/usr/bin/env node
/**
 * Publish the generated import file as a release asset.
 *
 * This is what makes the "Deploy to Cloudflare" button work. The button clones
 * the repository and runs its build step in a fresh environment, so the 43 MB
 * of translated data has to be reachable from somewhere public — committing it
 * would grow the repository by that much on every daily refresh, and the file
 * is reproducible anyway.
 *
 * A release asset is the right home for it: public, free, outside git history,
 * and replaceable in place so the download URL never changes. The tag is reused
 * on every run and the assets under it are overwritten, which is why the seed
 * url in project.json is tag-pinned rather than `releases/latest`.
 *
 * A MANIFEST.json goes up alongside the archive. scripts/seed.mjs downloads it
 * first and refuses to install a file that does not match its length and
 * sha256, because a truncated import file imports without complaining and
 * leaves a silent half-populated marketplace behind.
 *
 *   node scripts/publish-seed.mjs            # publish (skips if unchanged)
 *   node scripts/publish-seed.mjs --force    # publish even if the hash matches
 *   node scripts/publish-seed.mjs --check    # report, upload nothing
 *
 * Auth: GITHUB_TOKEN in the environment (what the refresh workflow uses), or
 * the token git already has stored for github.com (what happens locally).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProject } from './lib/project.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const IMPORT_SQL = path.join(ROOT, 'data', 'import.sql');
const STATS = path.join(ROOT, 'data', 'stats.json');

const CHECK_ONLY = process.argv.includes('--check');
const FORCE = process.argv.includes('--force');

const mb = (n) => (n / 1048576).toFixed(1);
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function fail(text, hint) {
  console.error(`\n  ERROR  ${text}`);
  if (hint) console.error(`         ${hint}`);
  process.exit(1);
}

// ------------------------------------------------- where to publish, and as --
// Derived from the seed url so there is exactly one place that names the
// repository and the tag.
const PROJECT = loadProject();
const seedUrl = PROJECT.seedUrl;
if (!seedUrl) fail('project.json has no seedUrl to publish against');

const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/.exec(seedUrl);
if (!m) {
  fail(
    `could not read owner/repo/tag out of the seed url`,
    `got ${seedUrl}\n         expected https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>`,
  );
}
const [, OWNER, REPO, TAG, ASSET] = m;
const MANIFEST_ASSET = 'MANIFEST.json';

console.log(`  repository : ${OWNER}/${REPO}`);
console.log(`  tag        : ${TAG}`);
console.log(`  assets     : ${ASSET}, ${MANIFEST_ASSET}`);

if (!fs.existsSync(IMPORT_SQL)) {
  fail(
    'data/import.sql does not exist',
    'build it first:  node generator/step3-sql.js   (after node generator/step1-fetch.js)',
  );
}

// ------------------------------------------------------------------ token ---
function githubToken() {
  const fromEnv = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (fromEnv) return { value: fromEnv, source: 'GITHUB_TOKEN' };
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      windowsHide: true,
    });
    const pw = /^password=(.*)$/m.exec(out)?.[1]?.trim();
    if (pw) return { value: pw, source: 'stored git credential' };
  } catch {
    /* fall through */
  }
  return null;
}

const TOKEN = githubToken();
if (!TOKEN) {
  fail(
    'no GitHub credentials',
    'set GITHUB_TOKEN, or run `git push` once so git stores a credential for github.com',
  );
}
console.log(`  auth       : ${TOKEN.source}`);

const H = {
  Authorization: `Bearer ${TOKEN.value}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'mcp-zh-publish-seed',
};

// ----------------------------------------------------------------- content ---
const sql = fs.readFileSync(IMPORT_SQL);
const stats = fs.existsSync(STATS) ? JSON.parse(fs.readFileSync(STATS, 'utf8')) : null;

process.stdout.write('  compressing… ');
const gz = zlib.gzipSync(sql, { level: zlib.constants.Z_BEST_COMPRESSION });
console.log(`${mb(sql.length)} MB -> ${mb(gz.length)} MB (${(100 * gz.length / sql.length).toFixed(0)}%)`);

const manifest = {
  bytes: sql.length,
  sha256: sha256(sql),
  gzipBytes: gz.length,
  gzipSha256: sha256(gz),
  entries: stats?.entries ?? null,
  contentHash: stats?.contentHash ?? null,
  asset: ASSET,
  generatedAt: new Date().toISOString(),
  note:
    'The import file is uncompressed as data/import.sql. The sha256 and bytes describe ' +
    'the DECOMPRESSED contents; scripts/seed.mjs checks both before installing it.',
};

console.log(`  sha256     : ${manifest.sha256.slice(0, 16)}…`);
console.log(`  entries    : ${manifest.entries?.toLocaleString() ?? '(unknown)'}`);
console.log(`  contentHash: ${manifest.contentHash ?? '(unknown)'}`);

if (CHECK_ONLY) {
  console.log('\n--check: nothing was uploaded.');
  process.exit(0);
}

// ----------------------------------------------------------------- release ---
async function api(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  let body = null;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

console.log('\n  resolving the release…');
let release = await api(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
if (release.status === 404) {
  const created = await api(`https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: TAG,
      name: 'Prebuilt dataset',
      body:
        'The translated registry, ready to import into D1.\n\n' +
        'This release is rewritten in place by the refresh workflow: the tag stays the same ' +
        'and the assets are replaced, so download URLs never change even though the contents ' +
        'do. `MANIFEST.json` carries the length and sha256 that `scripts/seed.mjs` verifies ' +
        'before installing the file.\n\n' +
        'You do not need to download this by hand — the Deploy to Cloudflare button and ' +
        '`npm run build` both fetch it for you.',
      draft: false,
      prerelease: false,
    }),
  });
  if (!created.ok) fail(`could not create the release`, JSON.stringify(created.body).slice(0, 400));
  release = created;
  console.log(`  created release ${TAG}`);
} else if (!release.ok) {
  fail(`could not read the release`, JSON.stringify(release.body).slice(0, 400));
} else {
  console.log(`  found release ${TAG}`);
}

const releaseId = release.body.id;

// Adding a second asset with the same name is allowed and confusing, so the
// previous ones are removed first — but ONLY if the content actually changed.
// A daily refresh that found nothing new should not churn the assets.
const existing = await api(`https://api.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?per_page=100`);
const current = (existing.ok && Array.isArray(existing.body) ? existing.body : []).reduce((acc, a) => {
  acc[a.name] = a;
  return acc;
}, {});

const sameGzip = current[ASSET]?.size === gz.length;
const sameManifest = current[MANIFEST_ASSET]?.size != null;
if (!FORCE && sameGzip && sameManifest) {
  // Size alone cannot prove the bytes match, so the manifest is fetched and
  // compared — that is the only field that actually pins the content.
  const url = current[MANIFEST_ASSET].browser_download_url;
  const res = await fetch(url, { headers: { 'User-Agent': 'mcp-zh-publish-seed' } });
  const remote = res.ok ? await res.json().catch(() => null) : null;
  if (remote?.sha256 === manifest.sha256) {
    console.log(`\n  unchanged (${manifest.sha256.slice(0, 16)}…) — assets left alone.`);
    console.log('  pass --force to publish anyway.');
    process.exit(0);
  }
}

for (const name of [ASSET, MANIFEST_ASSET]) {
  if (!current[name]) continue;
  const del = await api(`https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${current[name].id}`, {
    method: 'DELETE',
  });
  if (!del.ok) fail(`could not delete the old ${name}`, JSON.stringify(del.body).slice(0, 300));
  console.log(`  removed the previous ${name}`);
}

async function upload(name, buf) {
  process.stdout.write(`  uploading ${name} (${mb(buf.length)} MB)… `);
  const res = await fetch(
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/octet-stream' },
      body: buf,
    },
  );
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    console.log('');
    fail(`uploading ${name} failed`, JSON.stringify(body).slice(0, 400));
  }
  console.log('done');
  return body;
}

await upload(ASSET, gz);
await upload(MANIFEST_ASSET, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));

console.log('\n============================================================');
console.log(`  published ${manifest.entries?.toLocaleString() ?? '?'} entries`);
console.log(`  ${seedUrl}`);
console.log('\n  Anyone can now deploy a populated registry from a fresh clone:');
console.log('    npm run build   # downloads and verifies the seed');
console.log('    npm run deploy:local  # schema, import, wrangler deploy');
console.log('============================================================');
