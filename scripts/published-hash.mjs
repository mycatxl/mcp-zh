#!/usr/bin/env node
/**
 * Print the content hash D1 is currently publishing, or nothing.
 *
 * The refresh workflow needs this to decide whether an import is worth its ~69%
 * of the daily D1 write budget. It used to read it from `/health`, which meant
 * it needed the deployed URL — and that URL lives in project.json, which
 * scripts/deploy.mjs only ever writes inside Cloudflare's build checkout. That
 * write is not pushed back to the repository, so on the very deployment flow
 * this project recommends (the one-click button) project.json stays null, the
 * workflow could never read a hash, and it re-imported identical data every
 * single day.
 *
 * Asking D1 directly removes the whole chain of assumptions: no deployed URL,
 * no /health round trip, and it works on a fresh fork whose project.json has
 * never been touched.
 *
 * Always exits 0. "No answer" is a legitimate answer here — it means the first
 * publish — and a workflow step should not fail because a database is empty.
 *
 *   node scripts/published-hash.mjs          # prints the hash, or nothing
 *   node scripts/published-hash.mjs --quiet  # never explains itself
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject } from './lib/project.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WRANGLER_BIN = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const TOML = path.join(ROOT, 'wrangler.toml');
const QUIET = process.argv.includes('--quiet');

/** Diagnostics go to stderr, so stdout carries the hash and nothing else. */
const note = (msg) => {
  if (!QUIET) console.error(msg);
};

const project = loadProject();
const binding = /^\s*binding\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(TOML, 'utf8'))?.[1] ?? 'DB';

if (!fs.existsSync(WRANGLER_BIN)) {
  note('  published-hash: no vendored wrangler; reporting "no hash"');
  process.exit(0);
}

const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
// Without a token wrangler would fall back to an interactive login, which in CI
// is a hang rather than an error.
if (!env.CLOUDFLARE_API_TOKEN && !process.env.WRANGLER_OAUTH_OK) {
  note('  published-hash: no CLOUDFLARE_API_TOKEN; reporting "no hash"');
  process.exit(0);
}

try {
  const res = execFileSync(
    process.execPath,
    [WRANGLER_BIN, 'd1', 'execute', binding, '--remote', '--json', '--command',
      "SELECT value FROM meta WHERE key = 'content_hash'"],
    { cwd: ROOT, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
  );
  const parsed = JSON.parse(res.slice(res.indexOf('[')));
  const hash = parsed?.[0]?.results?.[0]?.value;
  if (typeof hash === 'string' && hash) {
    note(`  published-hash: ${hash}  (from D1 ${project.databaseName})`);
    process.stdout.write(hash);
  } else {
    note('  published-hash: D1 has no meta row yet — treating this as a first publish');
  }
} catch (e) {
  // A missing meta table (first run) and a network blip both land here, and both
  // have the same safe answer: no hash, therefore publish.
  const detail = String(e.stderr ?? e.message ?? '').trim().split('\n').pop() ?? '';
  note(`  published-hash: could not read D1 — treating this as a first publish`);
  if (detail) note(`                 (${detail.slice(0, 140)})`);
}
process.exit(0);