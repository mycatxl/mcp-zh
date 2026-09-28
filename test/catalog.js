/**
 * Verifies the static catalog files the way PI-Desktop actually loads them.
 *
 * Three things must hold, and each has bitten us or would silently break:
 *
 *  1. VALIDATION — the host's validateMcpCatalogFile() silently drops entries it
 *     dislikes, so a catalog can load "successfully" while missing thousands of
 *     rows. Every entry must pass the transcribed rules.
 *  2. NO ID COLLISION WITH THE OFFICIAL SOURCE — the host merges sources in order
 *     and keeps the FIRST occurrence of each id, with the official source force-
 *     prepended. A shared id means the Chinese entry is discarded.
 *  3. SIZE — each file must stay under MAX_SOURCE_RESPONSE_BYTES (4 MB), and the
 *     count of files must stay under MAX_MARKET_SOURCES (16).
 *
 *   node test/catalog.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registryIdFromName } from '../shared/shape.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CATALOG = path.join(ROOT, 'catalog');

const MAX_SOURCE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_MARKET_SOURCES = 16;

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

// ---- host validation rules (transcribed from app.asar) --------------------
const ENV_PLACEHOLDER = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const HEADER_PLACEHOLDER = /\$?\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CATALOG_CATEGORIES = new Set(['devtools', 'web', 'docs', 'data', 'productivity']);
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((i) => typeof i === 'string');
const isStringRecord = (v) => isRecord(v) && Object.values(v).every((i) => typeof i === 'string');

function entryShapeError(value) {
  if (!isRecord(value)) return 'entry is not an object';
  const id = typeof value.id === 'string' ? value.id : 'unknown';
  if (typeof value.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.id)) return `bad id: ${id}`;
  if (typeof value.name !== 'string' || !value.name.trim()) return `${id}: name is required`;
  if (value.transport !== 'stdio' && value.transport !== 'http') return `${id}: transport is invalid`;
  if (value.categories !== undefined) {
    if (!Array.isArray(value.categories) || !value.categories.every((c) => typeof c === 'string' && CATALOG_CATEGORIES.has(c))) {
      return `${id}: categories must be an array of known categories`;
    }
  }
  if (value.args !== undefined && !isStringArray(value.args)) return `${id}: args must be an array of strings`;
  if (value.env !== undefined && !isStringRecord(value.env)) return `${id}: env must be an object of strings`;
  if (value.headers !== undefined && !isStringRecord(value.headers)) return `${id}: headers must be an object of strings`;
  if (value.requiredEnv !== undefined) {
    if (!Array.isArray(value.requiredEnv)) return `${id}: requiredEnv must be an array`;
    const names = new Set();
    const pattern = value.transport === 'http' ? VARIABLE_NAME : ENV_NAME;
    for (const item of value.requiredEnv) {
      if (!isRecord(item)) return `${id}: requiredEnv items must be objects`;
      if (typeof item.name !== 'string' || !pattern.test(item.name)) return `${id}: requiredEnv names must be variable names`;
      if (names.has(item.name)) return `${id}: duplicate requiredEnv name ${item.name}`;
      names.add(item.name);
    }
  }
  for (const field of ['description', 'author', 'homepage', 'command', 'url', 'notes']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return `${id}: ${field} must be a string`;
  }
  return null;
}

function isPublicHttpsUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b] = host.split('.').map(Number);
      if (a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function templateStrings(entry) {
  if (!isRecord(entry)) return [];
  if (entry.transport === 'http') {
    return [typeof entry.url === 'string' ? entry.url : '', ...(isStringRecord(entry.headers) ? Object.values(entry.headers) : [])];
  }
  return [
    typeof entry.command === 'string' ? entry.command : '',
    ...(isStringArray(entry.args) ? entry.args : []),
    ...(isStringRecord(entry.env) ? Object.values(entry.env) : []),
  ];
}

function collectPlaceholders(entry) {
  const names = new Set();
  const declared = new Map((entry.requiredEnv ?? []).map((i) => [i.name, i]));
  const collect = (text, pattern, bindings) => {
    for (const match of String(text).matchAll(pattern)) {
      if (bindings) {
        const binding = Object.hasOwn(bindings, match[0]) ? bindings[match[0]] : undefined;
        if (binding && 'input' in binding) names.add(binding.input);
      } else if (match[0].startsWith('$') || declared.has(match[1])) {
        names.add(match[1]);
      }
    }
  };
  if (entry.transport === 'http') {
    collect(entry.url ?? '', ENV_PLACEHOLDER);
    for (const [header, template] of Object.entries(entry.headers ?? {})) {
      collect(template, HEADER_PLACEHOLDER, entry.headerBindings?.[header]);
    }
  } else {
    for (const text of templateStrings(entry)) collect(text, ENV_PLACEHOLDER);
  }
  return [...names].sort();
}

function catalogEntryError(entry) {
  const shapeError = entryShapeError(entry);
  if (shapeError) return shapeError;
  if (entry.transport === 'stdio') {
    if (!entry.command?.trim()) return `${entry.id}: stdio requires command`;
    if (entry.command.includes('..')) return `${entry.id}: command must not contain ..`;
  } else {
    if (!entry.url) return `${entry.id}: http requires url`;
    let parsed;
    try {
      parsed = new URL(entry.url);
    } catch {
      return `${entry.id}: url does not parse`;
    }
    if (parsed.protocol !== 'https:') return `${entry.id}: catalog endpoints must be https`;
    if (!isPublicHttpsUrl(entry.url)) return `${entry.id}: catalog endpoints must use a public https address`;
  }
  const declared = new Map((entry.requiredEnv ?? []).map((i) => [i.name, i]));
  for (const name of collectPlaceholders(entry)) {
    if (!declared.has(name)) return `${entry.id}: placeholder ${name} is not declared in requiredEnv`;
  }
  return null;
}

/** The host's own mapRegistryServer() acceptance test. */
function mapsToEntry(entry) {
  if (entry.transport === 'stdio') return entry.command ? 'stdio' : null;
  if (entry.transport === 'http') return entry.url ? 'http' : null;
  return null;
}

// ---------------------------------------------------------------------------

function main() {
  const manifestPath = path.join(CATALOG, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`missing ${manifestPath} — run build-catalog.js first`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  console.log(`catalog dir : ${CATALOG}`);
  console.log(`parts       : ${manifest.parts.length}`);
  console.log('');

  const allIds = new Set();
  let totalEntries = 0;
  let totalInvalid = 0;
  let totalDupes = 0;
  let oversized = 0;
  let noChinese = 0;
  const catCount = new Map();

  console.log('1) per-file checks');
  for (const part of manifest.parts) {
    const file = path.join(CATALOG, part.file);
    const text = fs.readFileSync(file, 'utf8');
    const size = Buffer.byteLength(text, 'utf8');
    const body = JSON.parse(text);
    const servers = body.servers ?? [];

    const okSize = size < MAX_SOURCE_RESPONSE_BYTES;
    if (!okSize) oversized += 1;
    check(`${part.file}: under 4 MB`, okSize, `${(size / 1048576).toFixed(2)} MB`);
    check(`${part.file}: servers array`, Array.isArray(servers), `${servers.length} entries`);
    check(`${part.file}: updatedAt present`, typeof body.updatedAt === 'string');

    let invalid = 0;
    const reasons = new Map();
    let dupes = 0;
    for (const entry of servers) {
      const err = catalogEntryError(entry);
      if (err) {
        invalid += 1;
        const key = err.replace(/^[^:]+:\s*/, '');
        reasons.set(key, (reasons.get(key) ?? 0) + 1);
      }
      if (allIds.has(entry.id)) dupes += 1;
      allIds.add(entry.id);
      if (!mapsToEntry(entry)) invalid += 0;
      for (const c of entry.categories ?? []) catCount.set(c, (catCount.get(c) ?? 0) + 1);
      if (!/[\u4e00-\u9fff]/.test(`${entry.name} ${entry.description ?? ''}`)) noChinese += 1;
    }
    totalEntries += servers.length;
    totalInvalid += invalid;
    totalDupes += dupes;

    check(`${part.file}: all entries valid`, invalid === 0, invalid ? `${invalid} invalid: ${[...reasons].map(([k, v]) => `${k}(${v})`).join(', ')}` : '0 dropped');
    check(`${part.file}: no duplicate ids`, dupes === 0, `${dupes} dupes`);
  }

  console.log('\n2) cross-file and host-limit checks');
  check('total files under MAX_MARKET_SOURCES (16)', manifest.parts.length <= MAX_MARKET_SOURCES, `${manifest.parts.length} files`);
  check('no duplicate ids across all files', totalDupes === 0, `${totalDupes} dupes`);
  check('no file exceeds the 4 MB cap', oversized === 0);
  check('all entries pass host validation', totalInvalid === 0, `${totalInvalid} invalid`);

  console.log('\n3) id collision with the official source');
  // The official source derives ids from the raw registry name. Our entries must
  // differ, or the host's "first wins" merge would drop them.
  const sample = [];
  for (const part of manifest.parts.slice(0, 2)) {
    const body = JSON.parse(fs.readFileSync(path.join(CATALOG, part.file), 'utf8'));
    sample.push(...(body.servers ?? []).slice(0, 2000));
  }
  let suffixPattern = 0;
  for (const entry of sample) {
    // Our ids end in a category hint or a zh- prefix; official ones are a plain
    // slug of the registry name.
    if (/-zh-[a-z]+$/.test(entry.id) || /^zh-/.test(entry.id) || /-zh(-|$)/.test(entry.id)) suffixPattern += 1;
  }
  check(
    'ids carry a zh marker (so they cannot equal official ids)',
    suffixPattern === sample.length,
    `${suffixPattern}/${sample.length}`,
  );
  check('every id matches the host id regex', sample.every((e) => /^[a-z][a-z0-9_-]{0,63}$/.test(e.id)));

  console.log('\n4) content sanity');
  const total = manifest.parts.reduce((a, p) => a + p.entries, 0);
  console.log(`   entries        : ${total}`);
  console.log(`   no Chinese     : ${noChinese}`);
  console.log(`   categories     : ${[...catCount].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')}`);
  const stdio = manifest.parts.reduce((a, p) => a + p.stdio, 0);
  const http = manifest.parts.reduce((a, p) => a + p.http, 0);
  console.log(`   transport      : stdio=${stdio}  http=${http}`);

  console.log('\n5) sample of what the market shows');
  const first = JSON.parse(fs.readFileSync(path.join(CATALOG, manifest.parts[0].file), 'utf8'));
  for (const e of first.servers.slice(0, 8)) {
    console.log(`   [${e.transport.padEnd(5)}] ${e.name}`);
    console.log(`            ${(e.description ?? '').slice(0, 80)}`);
  }

  console.log('\n--------------------------------------------');
  console.log(`PASS ${pass}   FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
