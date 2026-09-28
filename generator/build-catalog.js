/**
 * Build a STATIC catalog set that can live in a git repo — no server, no account.
 *
 * WHY THIS FILE EXISTS (and why it is several files, not one):
 *
 * A `catalog` source is fetched in ONE request with no pagination, and the host
 * rejects any response over MAX_SOURCE_RESPONSE_BYTES = 4 MB. A static host cannot
 * paginate, so everything must fit in a single response. Measured on the real
 * translated dataset:
 *
 *     full fidelity  34,281 entries  12.69 MB  -> 3.17x over the cap
 *     lean           34,288 entries   9.06 MB  -> 2.27x over the cap
 *
 * The floor is arithmetic, not tuning: Chinese descriptions alone are 3.22 MB and
 * titles 0.88 MB, which is already 4.10 MB before a single id, url or JSON brace.
 * So one file can never hold everything — but the market accepts up to 16 sources
 * (MAX_MARKET_SOURCES), and N files of <=4 MB each cover the whole dataset.
 *
 * Two things this script gets right that are easy to miss:
 *
 *  1. IDs MUST DIFFER FROM THE OFFICIAL SOURCE'S. The host merges sources in order
 *     with "first wins", and the official source is force-prepended by
 *     sanitizeMarketSources(). Official ids are registryIdFromName(server.name);
 *     if ours matched, every Chinese entry would be silently discarded.
 *
 *     A suffix is NOT safe: registryIdFromName truncates to 60 chars, so for long
 *     registry names the "/zh/<category>" suffix is cut off entirely and the id
 *     collapses back onto the official one (80 such entries in the first build).
 *     A PREFIX survives truncation, so ids are `zh-` prefixed and length-capped
 *     so that prefix can never be the part that gets cut.
 *
 *  2. EVERY ENTRY MUST PASS THE HOST'S OWN VALIDATOR. validateMcpCatalogFile()
 *     silently drops bad entries — a catalog of 34k entries can load as 30k with
 *     no error shown. The rules below are transcribed from app.asar so we can
 *     prove (and report) that nothing is dropped.
 *
 *   node generator/build-catalog.js                 # emit catalog/
 *   node generator/build-catalog.js --budget=3.6    # MB per file (default 3.6)
 *   node generator/build-catalog.js --repo=me/repo  # print ready-to-paste URLs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Translator, nameTokens } from './lib/translate.js';
import { buildServedRecord, installability, registryIdFromName } from '../shared/shape.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');
const OUTDIR = path.join(ROOT, 'catalog');

const HOST_CAP_BYTES = 4 * 1024 * 1024;
/** registryIdFromName() truncates the slug to 60 chars, then may add "mcp-". */
const ID_MAX = 60;
const ZH_PREFIX = 'zh-';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const bytes = (v) => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');

// ---------------------------------------------------------------------------
// Host validation rules, transcribed from app.asar (validateMcpCatalogFile and
// everything it calls). Keeping them here is what lets us claim "0 dropped".
// ---------------------------------------------------------------------------

const ENV_PLACEHOLDER = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const HEADER_PLACEHOLDER = /\$?\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CATALOG_CATEGORIES = new Set(['devtools', 'web', 'docs', 'data', 'productivity']);
const ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((i) => typeof i === 'string');
const isStringRecord = (v) => isRecord(v) && Object.values(v).every((i) => typeof i === 'string');

function requiredEnvError(value, id, transport) {
  if (!Array.isArray(value)) return `${id}: requiredEnv must be an array`;
  const names = new Set();
  const pattern = transport === 'http' ? VARIABLE_NAME : ENV_NAME;
  for (const item of value) {
    if (!isRecord(item)) return `${id}: requiredEnv items must be objects`;
    if (typeof item.name !== 'string' || !pattern.test(item.name)) return `${id}: requiredEnv names must be variable names`;
    if (names.has(item.name)) return `${id}: duplicate requiredEnv name ${item.name}`;
    names.add(item.name);
    if (item.description !== undefined && typeof item.description !== 'string') return `${id}: requiredEnv descriptions must be strings`;
    if (item.optional !== undefined && typeof item.optional !== 'boolean') return `${id}: requiredEnv optional must be boolean`;
    if (item.defaultValue !== undefined && typeof item.defaultValue !== 'string') return `${id}: requiredEnv defaultValue must be a string`;
  }
  return null;
}

function headerBindingsError(value, headers, id) {
  if (!isRecord(value) || !isStringRecord(headers)) return `${id}: headerBindings requires headers`;
  for (const [header, bindings] of Object.entries(value)) {
    if (!Object.hasOwn(headers, header) || !isRecord(bindings)) return `${id}: invalid header bindings`;
    for (const [token, binding] of Object.entries(bindings)) {
      if (!/^\$?\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(token) || !isRecord(binding) || Object.keys(binding).length !== 1) {
        return `${id}: invalid header token binding`;
      }
      if (typeof binding.value !== 'string' && (typeof binding.input !== 'string' || !VARIABLE_NAME.test(binding.input))) {
        return `${id}: header token binding requires an input or literal value`;
      }
    }
  }
  return null;
}

function entryShapeError(value) {
  if (!isRecord(value)) return 'entry is not an object';
  const id = typeof value.id === 'string' ? value.id : 'unknown';
  if (typeof value.id !== 'string' || !ID_RE.test(value.id)) return 'bad id';
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
  if (value.headerBindings !== undefined) {
    if (value.transport !== 'http') return `${id}: headerBindings requires http transport`;
    const error = headerBindingsError(value.headerBindings, value.headers, id);
    if (error) return error;
  }
  if (value.prerequisites !== undefined && !isStringArray(value.prerequisites)) return `${id}: prerequisites must be an array of strings`;
  if (value.requiredEnv !== undefined) {
    const error = requiredEnvError(value.requiredEnv, id, value.transport);
    if (error) return error;
  }
  for (const field of ['description', 'author', 'homepage', 'command', 'url', 'notes']) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return `${id}: ${field} must be a string`;
  }
  if (value.verified !== undefined && typeof value.verified !== 'boolean') return `${id}: verified must be boolean`;
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

function collectCatalogPlaceholders(entry) {
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
  for (const name of collectCatalogPlaceholders(entry)) {
    if (!declared.has(name)) return `${entry.id}: placeholder ${name} is not declared in requiredEnv`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// registry record -> catalog entry
// ---------------------------------------------------------------------------

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

function envSpecs(pkg) {
  return (pkg.environmentVariables ?? [])
    .filter((v) => typeof v.name === 'string' && !!v.name)
    .map((v) => ({
      name: v.name,
      ...(typeof v.description === 'string' && v.description ? { description: v.description } : {}),
      ...(v.isRequired ? {} : { optional: true }),
      ...(typeof v.value === 'string' ? { defaultValue: v.value } : typeof v.default === 'string' ? { defaultValue: v.default } : {}),
    }));
}

/** Build the entry, degrading only if the host would otherwise reject it. */
function toCatalogEntry(served, id, category) {
  const base = { id, name: served.title ?? '', description: served.description ?? '', categories: [category] };
  const packages = Array.isArray(served.packages) ? served.packages : [];

  const build = (kind) => {
    const pkg = packages.find(
      (p) =>
        String(p?.registryType ?? '').toLowerCase() === kind &&
        typeof p?.identifier === 'string' &&
        p.identifier.trim(),
    );
    if (!pkg) return null;

    const sep = kind === 'npm' ? '@' : '==';
    const args = [...argumentValues(pkg.runtimeArguments)];
    const name = pkg.identifier.trim();
    const ver = typeof pkg.version === 'string' ? pkg.version.trim() : '';
    const spec = ver ? `${name}${sep}${ver}` : name;
    const pkgArgs = argumentValues(pkg.packageArguments);
    if (!args.includes(spec) && !pkgArgs.includes(spec)) args.push(spec);
    args.push(...pkgArgs);

    const entry = {
      ...base,
      transport: 'stdio',
      command:
        typeof pkg.runtimeHint === 'string' && pkg.runtimeHint.trim()
          ? pkg.runtimeHint.trim()
          : kind === 'npm'
            ? 'npx'
            : 'uvx',
      args,
      ...(kind === 'pypi' ? { prerequisites: ['Requires uv/uvx on PATH'] } : {}),
    };

    // env and requiredEnv must agree: every ${VAR} in env has to be declared.
    const specs = envSpecs(pkg).filter((s) => ENV_NAME.test(s.name));
    if (specs.length) {
      entry.requiredEnv = specs;
      entry.env = Object.fromEntries(specs.map((s) => [s.name, `\${${s.name}}`]));
    }
    return entry;
  };

  const remoteEntry = () => {
    const remote = (served.remotes ?? []).find(
      (r) => String(r?.type ?? '').toLowerCase() === 'streamable-http' && isPublicHttpsUrl(r?.url ?? ''),
    );
    if (!remote) return null;
    return { ...base, transport: 'http', url: remote.url };
  };

  const candidates = [build('npm'), build('pypi'), remoteEntry()].filter(Boolean);
  for (const candidate of candidates) {
    if (!catalogEntryError(candidate)) return candidate;
    const degraded = { ...candidate };
    delete degraded.env;
    delete degraded.requiredEnv;
    if (!catalogEntryError(degraded)) return degraded;
  }
  return null;
}

// ---------------------------------------------------------------------------

function readRaw(limit) {
  const file = path.join(DATA, 'raw.jsonl');
  if (!fs.existsSync(file)) throw new Error(`missing ${file} — run step1-fetch.js first`);
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* torn line from an interrupted crawl */
    }
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Build an id that can never equal the official one.
 *
 * `zh-` goes at the FRONT: registryIdFromName truncates to 60 chars, so a suffix
 * on a long name is cut off and the id collapses back onto the official slug.
 * The prefix is applied after truncation of the natural slug, so it always
 * survives, and the total stays within the host's 64-char id limit.
 */
function zhId(sourceName) {
  const natural = registryIdFromName(sourceName);
  return `${ZH_PREFIX}${natural.slice(0, ID_MAX - ZH_PREFIX.length)}`;
}

async function main() {
  const budgetMB = Number(arg('budget', '3.6'));
  const budget = Math.floor(budgetMB * 1024 * 1024);

  const records = readRaw(Infinity);
  console.log(`raw records              : ${records.length}`);

  const translator = new Translator({ cachePath: path.join(DATA, 'translation-cache.json') });

  const all = [];
  const usedIds = new Set();
  let noInstall = 0;
  let idCollisions = 0;
  let unrepresentable = 0;

  for (const rec of records) {
    const src = rec?.server ?? {};
    if (!src.name) continue;

    // Replay the generator's translation lookup (cache key = text + brand tokens).
    const extra = nameTokens(src.name);
    const titleZh = typeof src.title === 'string' ? (translator.cache.get(Translator.key(src.title, true, extra)) ?? '') : '';
    const descZh = typeof src.description === 'string' ? (translator.cache.get(Translator.key(src.description, true, extra)) ?? '') : '';

    const built = buildServedRecord(rec, { titleZh, descZh });
    if (!installability(built.served).ok) {
      noInstall += 1;
      continue;
    }

    let id = zhId(src.name);
    // The prefix makes a collision with the official source impossible, but two
    // registry names can still collapse to the same slug after truncation.
    if (usedIds.has(id)) {
      idCollisions += 1;
      let n = 2;
      let candidate = id;
      while (usedIds.has(candidate)) {
        const suffix = `-${n}`;
        candidate = `${id.slice(0, 64 - suffix.length)}${suffix}`;
        n += 1;
      }
      id = candidate;
    }
    usedIds.add(id);

    all.push({ built, id, category: built.category });
  }

  console.log(`installable entries      : ${all.length}   (skipped ${noInstall} with no install path)`);
  console.log(`slug collisions resolved : ${idCollisions}`);

  // ---- build entries, count what the host would drop -----------------------
  const entries = [];
  const dropReasons = new Map();
  for (const { built, id, category } of all) {
    const entry = toCatalogEntry(built.served, id, category);
    if (!entry) {
      unrepresentable += 1;
      continue;
    }
    const err = catalogEntryError(entry);
    if (err) {
      const key = err.replace(/^[^:]+:\s*/, '');
      dropReasons.set(key, (dropReasons.get(key) ?? 0) + 1);
      continue;
    }
    entries.push(entry);
  }
  console.log(`catalog entries          : ${entries.length}`);
  console.log(`unrepresentable          : ${unrepresentable} (no npm/pypi package and no public https remote)`);
  if (dropReasons.size) {
    console.log(`dropped by host validator: ${[...dropReasons].map(([k, v]) => `${k} (${v})`).join(', ')}`);
  }

  // ---- split into files under the byte budget -----------------------------
  const parts = [];
  let current = [];
  let currentBytes = bytes({ updatedAt: '', servers: [] });
  for (const entry of entries) {
    const size = bytes(entry) + 1;
    if (current.length && currentBytes + size > budget) {
      parts.push(current);
      current = [];
      currentBytes = bytes({ updatedAt: '', servers: [] });
    }
    current.push(entry);
    currentBytes += size;
  }
  if (current.length) parts.push(current);

  fs.rmSync(OUTDIR, { recursive: true, force: true });
  fs.mkdirSync(OUTDIR, { recursive: true });

  const updatedAt = new Date().toISOString();
  const manifest = { generatedAt: updatedAt, hostCapBytes: HOST_CAP_BYTES, budgetBytes: budget, parts: [] };

  console.log('\n=================== FILES ===================');
  parts.forEach((list, i) => {
    const label = String(i + 1).padStart(2, '0');
    const file = `mcp-zh-${label}.json`;
    const text = JSON.stringify({ updatedAt, servers: list });
    fs.writeFileSync(path.join(OUTDIR, file), text, 'utf8');

    let invalid = 0;
    for (const e of list) if (catalogEntryError(e)) invalid += 1;

    const catCount = new Map();
    for (const e of list) for (const c of e.categories ?? []) catCount.set(c, (catCount.get(c) ?? 0) + 1);
    const stdio = list.filter((e) => e.transport === 'stdio').length;
    const size = Buffer.byteLength(text, 'utf8');

    manifest.parts.push({
      file,
      entries: list.length,
      bytes: size,
      invalid,
      stdio,
      http: list.length - stdio,
      categories: Object.fromEntries([...catCount].sort((a, b) => b[1] - a[1])),
    });

    console.log(
      `  ${file}  ${String(list.length).padStart(6)} entries  ${(size / 1048576).toFixed(2)} MB  ` +
        `invalid=${invalid}  stdio=${stdio} http=${list.length - stdio}`,
    );
  });

  fs.writeFileSync(path.join(OUTDIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  const totalEntries = manifest.parts.reduce((a, p) => a + p.entries, 0);
  const totalInvalid = manifest.parts.reduce((a, p) => a + p.invalid, 0);
  const totalBytes = manifest.parts.reduce((a, p) => a + p.bytes, 0);
  const maxFile = Math.max(...manifest.parts.map((p) => p.bytes));

  console.log('\n=================== RESULT ===================');
  console.log(`files            : ${manifest.parts.length} (host allows up to 16 sources)`);
  console.log(`entries          : ${totalEntries} of ${all.length} installable (${((totalEntries / all.length) * 100).toFixed(1)}%)`);
  console.log(`total size       : ${(totalBytes / 1048576).toFixed(2)} MB across ${manifest.parts.length} files`);
  console.log(`largest file     : ${(maxFile / 1048576).toFixed(2)} MB  (cap 4.00 MB)`);
  console.log(`host-validation  : ${totalInvalid} invalid entries (must be 0)`);
  console.log(`coverage vs raw  : ${((totalEntries / records.length) * 100).toFixed(1)}% of all registry records`);

  const repo = arg('repo', null);
  if (repo) {
    const [owner, name] = repo.split('/');
    console.log('\n=================== SOURCES TO ADD ===================');
    for (const p of manifest.parts) {
      console.log(`  ${p.file}  (${p.entries} entries)`);
      console.log(`    https://cdn.jsdelivr.net/gh/${owner}/${name}@main/catalog/${p.file}`);
    }
    console.log(`\n  or via GitHub Pages:`);
    for (const p of manifest.parts) {
      console.log(`    https://${owner}.github.io/${name}/catalog/${p.file}`);
    }
  }

  console.log('\nwrote catalog/ + catalog/manifest.json');
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e);
  process.exit(1);
});
