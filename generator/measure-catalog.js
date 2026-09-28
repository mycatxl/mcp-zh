/**
 * Can the whole translated registry fit in ONE catalog file under the host's
 * 4 MB per-response cap? That single number decides whether this project needs a
 * server at all, or can simply live as one JSON file in a git repo.
 *
 * It builds catalog entries exactly the way the host's own mapRegistryServer()
 * would, from the translated data already on disk, then measures real byte sizes
 * for several field sets so we can see what actually costs space.
 *
 *   node generator/measure-catalog.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registryIdFromName, guessCategory } from '../shared/shape.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');

const LIMIT_BYTES = 4 * 1024 * 1024; // MAX_SOURCE_RESPONSE_BYTES in the host

const bytes = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');

/** Mirrors the host's argumentValues(). */
function argumentValues(args) {
  const out = [];
  for (const a of args ?? []) {
    if (!a || typeof a !== 'object') continue;
    const named = a.type === 'named' || (!!a.name && a.type !== 'positional');
    if (named) {
      if (typeof a.name === 'string' && a.name) out.push(a.name);
      if (typeof a.value === 'string' && a.value) out.push(a.value);
    } else if (typeof a.value === 'string' && a.value) out.push(a.value);
  }
  return out;
}

/** Mirrors the host's envTemplates(). */
function envTemplates(pkg) {
  const names = (pkg.environmentVariables ?? [])
    .filter((v) => typeof v.name === 'string' && !!v.name)
    .map((v) => v.name);
  return names.length ? Object.fromEntries(names.map((n) => [n, `\${${n}}`])) : undefined;
}

function isPublicHttps(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
      const [a, b] = h.split('.').map(Number);
      if (a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn one translated registry record into a catalog entry, the same way
 * mapRegistryServer() does for the registry protocol.
 * `zh` carries the already-translated title/description.
 */
function toCatalogEntry(server, zh) {
  const id = registryIdFromName(server.name);
  const display = (server.title ?? '').trim() || server.name.split('/').pop() || server.name;
  const repoUrl = typeof server.repository === 'string' ? server.repository : server.repository?.url;
  const base = {
    id,
    name: zh?.title?.trim() || display,
    description: zh?.description?.trim() || server.description || '',
  };

  const packages = Array.isArray(server.packages) ? server.packages : [];
  const npm = packages.find(
    (p) => String(p?.registryType ?? '').toLowerCase() === 'npm' && typeof p?.identifier === 'string' && p.identifier.trim(),
  );
  if (npm) {
    const args = [...argumentValues(npm.runtimeArguments)];
    const pkgName = npm.identifier.trim();
    const ver = typeof npm.version === 'string' ? npm.version.trim() : '';
    const spec = ver ? `${pkgName}@${ver}` : pkgName;
    const pkgArgs = argumentValues(npm.packageArguments);
    if (!args.includes(spec) && !pkgArgs.includes(spec)) args.push(spec);
    args.push(...pkgArgs);
    const env = envTemplates(npm);
    return {
      ...base,
      transport: 'stdio',
      command: typeof npm.runtimeHint === 'string' && npm.runtimeHint.trim() ? npm.runtimeHint.trim() : 'npx',
      args,
      ...(env ? { env } : {}),
      ...(Array.isArray(npm.environmentVariables) && npm.environmentVariables.length
        ? {
            requiredEnv: npm.environmentVariables
              .filter((v) => typeof v.name === 'string' && !!v.name)
              .map((v) => ({
                name: v.name,
                ...(typeof v.description === 'string' && v.description ? { description: v.description } : {}),
                ...(v.isRequired ? {} : { optional: true }),
              })),
          }
        : {}),
    };
  }

  const pypi = packages.find(
    (p) => String(p?.registryType ?? '').toLowerCase() === 'pypi' && typeof p?.identifier === 'string' && p.identifier.trim(),
  );
  if (pypi) {
    const args = [...argumentValues(pypi.runtimeArguments)];
    const pkgName = pypi.identifier.trim();
    const ver = typeof pypi.version === 'string' ? pypi.version.trim() : '';
    const spec = ver ? `${pkgName}==${ver}` : pkgName;
    const pkgArgs = argumentValues(pypi.packageArguments);
    if (!args.includes(spec) && !pkgArgs.includes(spec)) args.push(spec);
    args.push(...pkgArgs);
    const env = envTemplates(pypi);
    return {
      ...base,
      transport: 'stdio',
      command: typeof pypi.runtimeHint === 'string' && pypi.runtimeHint.trim() ? pypi.runtimeHint.trim() : 'uvx',
      args,
      prerequisites: ['Requires uv/uvx on PATH'],
      ...(env ? { env } : {}),
      ...(Array.isArray(pypi.environmentVariables) && pypi.environmentVariables.length
        ? {
            requiredEnv: pypi.environmentVariables
              .filter((v) => typeof v.name === 'string' && !!v.name)
              .map((v) => ({
                name: v.name,
                ...(typeof v.description === 'string' && v.description ? { description: v.description } : {}),
                ...(v.isRequired ? {} : { optional: true }),
              })),
          }
        : {}),
    };
  }

  const remote = (server.remotes ?? []).find(
    (r) => String(r?.type ?? '').toLowerCase() === 'streamable-http' && isPublicHttps(r?.url ?? ''),
  );
  if (remote) {
    const headers = {};
    for (const h of remote.headers ?? []) {
      if (typeof h?.name === 'string' && h.name && typeof h.value === 'string') headers[h.name] = h.value;
    }
    return { ...base, transport: 'http', url: remote.url, ...(Object.keys(headers).length ? { headers } : {}) };
  }

  return null;
}

function loadTranslated() {
  // The served records already carry the final Chinese title/description; reuse
  // them rather than re-reading the translation cache.
  const sqlPath = path.join(DATA, 'import.sql');
  if (fs.existsSync(sqlPath)) {
    // Fall back to raw + cache when import.sql is absent.
  }
  const raw = path.join(DATA, 'raw.jsonl');
  if (!fs.existsSync(raw)) throw new Error(`missing ${raw}`);
  const records = [];
  for (const line of fs.readFileSync(raw, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      /* skip torn line */
    }
  }
  return records;
}

/** Rebuild the translated text by replaying the same translation cache. */
function buildTranslations(records) {
  const cachePath = path.join(DATA, 'translation-cache.json');
  const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};
  // The generator hashes (glossary flag + protected tokens + text); we cannot
  // recompute the token sets cheaply here, so instead read the served output that
  // step3 already wrote into data/import.sql's servers table.
  return { cache, cachePath };
}

/** Pull title/description pairs straight out of the generated SQL. */
function readServedFromSql() {
  const sqlPath = path.join(DATA, 'import.sql');
  if (!fs.existsSync(sqlPath)) throw new Error(`missing ${sqlPath} — run step3-sql.js first`);
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const map = new Map(); // registry_id -> { title, description }
  const re = /\('(\d+)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*(NULL|'(?:[^']|'')*'),\s*(NULL|'(?:[^']|'')*'),/g;
  let m;
  while ((m = re.exec(sql))) {
    const unq = (s) => (s === 'NULL' ? null : s.slice(1, -1).replace(/''/g, "'"));
    map.set(unq(`'${m[2]}'`), { title: unq(m[5]), description: unq(m[6]) });
  }
  return map;
}

async function main() {
  const records = loadTranslated();
  console.log(`raw records: ${records.length}`);

  const served = readServedFromSql();
  console.log(`served rows parsed from import.sql: ${served.size}`);

  const entries = [];
  let skipped = 0;
  for (const rec of records) {
    const s = rec?.server;
    if (!s?.name) continue;
    const id = registryIdFromName(s.name);
    const zh = served.get(id);
    const entry = toCatalogEntry(s, zh);
    if (!entry) {
      skipped += 1;
      continue;
    }
    entries.push(entry);
  }
  console.log(`catalog entries built: ${entries.length}   (skipped ${skipped} with no install path)`);

  // ---- measure several field sets ---------------------------------------
  const variants = {
    'full (as mapped)': (e) => e,
    'no requiredEnv': (e) => {
      const { requiredEnv, ...rest } = e;
      return rest;
    },
    'no requiredEnv, no env': (e) => {
      const { requiredEnv, env, ...rest } = e;
      return rest;
    },
    'minimal (no requiredEnv/env/homepage/categories)': (e) => {
      const { requiredEnv, env, ...rest } = e;
      return rest;
    },
    'minimal + categories': (e) => {
      const { requiredEnv, env, ...rest } = e;
      return { ...rest, categories: [guessCategory({ name: e.id, title: e.name, description: e.description })] };
    },
  };

  console.log('\n=================== SIZE PER FIELD SET ===================');
  const results = [];
  for (const [label, fn] of Object.entries(variants)) {
    const list = entries.map(fn);
    const payload = JSON.stringify({ updatedAt: new Date().toISOString(), servers: list });
    const size = bytes(payload);
    const perEntry = size / list.length;
    const fits = size < LIMIT_BYTES;
    results.push({ label, size, perEntry, fits });
    console.log(
      `  ${label.padEnd(52)} ${(size / 1048576).toFixed(2)} MB  (${perEntry.toFixed(0)} B/entry)  ${fits ? 'FITS' : 'TOO BIG'}`,
    );
  }

  // ---- what actually costs the bytes ------------------------------------
  console.log('\n=================== FIELD COST BREAKDOWN (full set) ===================');
  const full = entries;
  const total = bytes(JSON.stringify({ servers: full }));
  const fieldCost = new Map();
  const keys = new Set();
  for (const e of full) for (const k of Object.keys(e)) keys.add(k);
  for (const k of keys) {
    let cost = 0;
    let count = 0;
    for (const e of full) {
      if (e[k] === undefined) continue;
      count += 1;
      cost += bytes(JSON.stringify(e[k])) + bytes(`"${k}":`) + 1;
    }
    fieldCost.set(k, { cost, count });
  }
  for (const [k, v] of [...fieldCost].sort((a, b) => b[1].cost - a[1].cost)) {
    const pct = ((v.cost / total) * 100).toFixed(1);
    console.log(`  ${k.padEnd(14)} ${(v.cost / 1048576).toFixed(2)} MB  ${pct.padStart(5)}%  in ${v.count} entries`);
  }
  console.log(`  ${'(total)'.padEnd(14)} ${(total / 1048576).toFixed(2)} MB`);

  // ---- how many entries WOULD fit ---------------------------------------
  console.log('\n=================== CAPACITY ===================');
  const avg = total / full.length;
  console.log(`average entry: ${avg.toFixed(0)} bytes`);
  console.log(`4 MB / ${avg.toFixed(0)} B  =>  ~${Math.floor(LIMIT_BYTES / avg).toLocaleString()} entries fit in one catalog file`);
  console.log(`we have ${full.length.toLocaleString()} entries`);
  const ratio = (LIMIT_BYTES / total) * 100;
  console.log(`=> current data is ${(total / LIMIT_BYTES).toFixed(2)}x over the cap (${ratio.toFixed(0)}% of it would fit)`);

  // ---- can we shrink? sample the biggest contributors -------------------
  console.log('\n=================== BIGGEST ENTRIES (targets for trimming) ===================');
  const sized = full.map((e) => ({ e, size: bytes(JSON.stringify(e)) })).sort((a, b) => b.size - a.size);
  for (const { e, size } of sized.slice(0, 6)) {
    console.log(`  ${size} B  ${e.id}`);
    console.log(`        args=${JSON.stringify(e.args)?.slice(0, 90)}`);
    console.log(`        requiredEnv=${e.requiredEnv?.length ?? 0}  headers=${e.headers ? Object.keys(e.headers).length : 0}`);
  }

  // ---- description length distribution ----------------------------------
  const lens = full.map((e) => [...(e.description ?? '')].length).sort((a, b) => a - b);
  const q = (p) => lens[Math.floor(lens.length * p)] ?? 0;
  console.log('\n=================== DESCRIPTION LENGTH (chars) ===================');
  console.log(`  min ${lens[0]}  p25 ${q(0.25)}  p50 ${q(0.5)}  p75 ${q(0.75)}  p90 ${q(0.9)}  max ${lens[lens.length - 1]}`);
  const descTotal = full.reduce((a, e) => a + bytes(JSON.stringify(e.description ?? '')), 0);
  console.log(`  total description bytes: ${(descTotal / 1048576).toFixed(2)} MB`);

  fs.writeFileSync(
    path.join(DATA, 'catalog-measure.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        entries: full.length,
        skipped,
        variants: results,
        avgEntryBytes: avg,
        capacityAt4MB: Math.floor(LIMIT_BYTES / avg),
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log('\nwrote data/catalog-measure.json');
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e);
  process.exit(1);
});
