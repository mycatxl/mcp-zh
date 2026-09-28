/**
 * Extract the host application's OWN record-mapping pipeline out of app.asar,
 * so the generator can ask the exact question the client asks:
 *
 *     "does this registry record become a visible market entry?"
 *
 * instead of relying on a hand-written approximation of mapRegistryServer().
 *
 *   node generator/extract-host-mapper.js --bundle=<path to main/index.js>
 *
 * The bundle is a flat ESM file of top-level function/const declarations, so the
 * needed definitions are pulled out by brace-matching from a seed set and then
 * following identifier references until the closure is complete. The result is
 * committed as generator/lib/host-mapper.generated.js, so later steps run without
 * needing app.asar on disk.
 *
 * Regenerate after a PI-Desktop upgrade: the host's acceptance rules are part of
 * the protocol this project mirrors. The output is syntax-checked before this
 * script reports success, because a truncated definition produces a file that
 * looks plausible and fails only at import time.
 *
 * THREE BUGS THIS FILE EXISTS TO AVOID (all found the hard way):
 *
 *  1. `$` must be escaped when a definition name is interpolated into a RegExp.
 *     The bundle renames colliding symbols to `Update$2`, so an unescaped `$`
 *     anchors the pattern and the definition is never found — the extracted file
 *     then fails with "Update$2 is not defined".
 *
 *  2. A default parameter such as `function f(a, options = {})` must not end the
 *     definition. Brace matching has to ignore braces inside parentheses, or
 *     every definition is truncated to its signature.
 *
 *  3. Identifier scanning must skip property accesses and object keys.
 *     `Object.values(x)` contains the token `values`, and the bundle has an
 *     unrelated top-level `const values = {...}`; following it drags in a whole
 *     JSON-schema validation library.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const bundlePath = arg('bundle', process.env.PI_ASAR_MAIN ?? '');
if (!bundlePath || !fs.existsSync(bundlePath)) {
  console.error('need --bundle=<path to the extracted main/index.js>');
  console.error('  npx asar extract app.asar out   ->   --bundle=out/main/index.js');
  process.exit(1);
}
const src = fs.readFileSync(bundlePath, 'utf8');
console.log(`bundle: ${bundlePath}  (${(src.length / 1048576).toFixed(1)} MB)`);

/** Identifiers that are never worth following as a definition reference. */
const NOT_A_DEF = new Set([
  'if', 'else', 'for', 'while', 'return', 'function', 'const', 'let', 'var', 'new', 'typeof', 'instanceof',
  'in', 'of', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'delete',
  'void', 'this', 'null', 'undefined', 'true', 'false', 'class', 'extends', 'super', 'yield', 'await',
  'async', 'static', 'get', 'set', 'default', 'export', 'import', 'from', 'as',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Set', 'Map', 'URL', 'RegExp',
  'Error', 'Promise', 'NaN', 'Infinity', 'encodeURIComponent', 'decodeURIComponent', 'Symbol', 'Date',
]);

/** Is a `/` here a regex literal or a division? Standard prev-char heuristic. */
function regexAllowed(prev) {
  if (prev === '') return true;
  return '=(,:[!&|?{};+-*%^~<>'.includes(prev) || /\b(return|typeof|case|in|of|do|else|void|new|delete|instanceof|yield|await)$/.test(prev);
}

/**
 * End index (exclusive) of the definition starting at `start`.
 * Tracks (), [], {} independently; only a `{` outside any parentheses can be the
 * function body (see bug 2 in the file header).
 */
function matchEnd(start) {
  let i = start;
  let prev = '';
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let bodyStart = -1;

  while (i < src.length) {
    const c = src[i];

    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) break;
        if (quote === '`' && src[i] === '$' && src[i + 1] === '{') {
          let d = 1;
          i += 2;
          while (i < src.length && d > 0) {
            if (src[i] === '{') d += 1;
            else if (src[i] === '}') d -= 1;
            i += 1;
          }
          continue;
        }
        i += 1;
      }
      i += 1;
      prev = 'x';
      continue;
    }

    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '/' && regexAllowed(prev)) {
      i += 1;
      let inClass = false;
      while (i < src.length) {
        const r = src[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
        else if (r === '\n') break;
        i += 1;
      }
      i += 1;
      while (i < src.length && /[a-z]/.test(src[i])) i += 1;
      prev = 'x';
      continue;
    }

    const top = paren === 0 && bracket === 0;
    if (c === '(') { paren += 1; prev = c; i += 1; continue; }
    if (c === ')') { paren -= 1; prev = c; i += 1; continue; }
    if (c === '[') { bracket += 1; prev = c; i += 1; continue; }
    if (c === ']') { bracket -= 1; prev = c; i += 1; continue; }
    if (c === '{') {
      if (top) {
        brace += 1;
        if (bodyStart < 0) bodyStart = i;
      }
      prev = c;
      i += 1;
      continue;
    }
    if (c === '}') {
      if (top && bodyStart >= 0) {
        brace -= 1;
        i += 1;
        if (brace === 0) return i;
        prev = c;
        continue;
      }
      prev = c;
      i += 1;
      continue;
    }
    if (c === ';' && top && bodyStart < 0) return i + 1; // `const x = 1;` — no body

    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return i;
}

/** Escape a definition name for use inside a RegExp (bug 1 in the header). */
function escapeRe(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const cache = new Map();
function findDef(name) {
  if (cache.has(name)) return cache.get(name);
  const esc = escapeRe(name);
  const patterns = [
    new RegExp(`(?:^|\\n)(?:async\\s+)?function\\s+${esc}\\s*\\(`, 'm'),
    new RegExp(`(?:^|\\n)(?:const|let|var)\\s+${esc}\\s*=`, 'm'),
  ];
  for (const re of patterns) {
    const m = re.exec(src);
    if (!m) continue;
    const start = m.index + (src[m.index] === '\n' ? 1 : 0);
    const text = src.slice(start, matchEnd(start));
    if (!text.trim() || text.trim().endsWith('=')) continue;
    cache.set(name, text);
    return text;
  }
  cache.set(name, null);
  return null;
}

/**
 * Identifiers referenced as *definitions* in `text` (bug 3 in the header).
 * Property accesses (`.name`) and object keys (`{ name: ... }`) are skipped.
 */
function referencedNames(text) {
  const cleaned = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\[\s\S]|\$\{[^}]*\}|[^\\`])*`/g, ' ')
    .replace(/"(?:\\[\s\S]|[^"\\])*"/g, ' ')
    .replace(/'(?:\\[\s\S]|[^'\\])*'/g, ' ');

  const out = new Set();
  const re = /(\.\s*)?\b([A-Za-z_$][A-Za-z0-9_$]*)\b(\s*:)?/g;
  let m;
  while ((m = re.exec(cleaned))) {
    const [, dot, name, colon] = m;
    if (dot) continue;
    if (colon) continue;
    if (NOT_A_DEF.has(name)) continue;
    out.add(name);
  }
  return out;
}

// ------------------------------------------------------------- closure walk --
const SEEDS = ['mapRegistryServer', 'catalogEntryError', 'registryIdFromName', 'guessCategory'];
const included = new Map();
const missing = new Set();
const queue = [...SEEDS];

while (queue.length) {
  const name = queue.shift();
  if (included.has(name) || missing.has(name)) continue;
  const def = findDef(name);
  if (!def) {
    missing.add(name);
    continue;
  }
  included.set(name, def);
  for (const ident of referencedNames(def)) {
    if (included.has(ident) || missing.has(ident) || ident === name) continue;
    if (findDef(ident)) queue.push(ident);
  }
}

console.log(`extracted ${included.size} definitions`);

const names = [...included.keys()].sort();
const banner = [
  '/**',
  ' * GENERATED by generator/extract-host-mapper.js — do not edit by hand.',
  ' *',
  " * The host application's own record-mapping pipeline, lifted verbatim from",
  ' * app.asar (main/index.js). The generator imports this to ask the exact',
  ' * question the client asks:',
  ' *',
  ' *     mapRegistryServer({ server, _meta })  ->  entry | null',
  ' *',
  ' * `null` means the client silently drops the record, so serving it would only',
  ' * waste one of the 100 slots in a page and one slot in the 2000-entry browse',
  ' * cache. Nothing here is rewritten; only the closure of helper functions that',
  ' * mapRegistryServer actually references is included.',
  ' *',
  ' * Regenerate after a PI-Desktop upgrade.',
  ' */',
  '',
].join('\n');

const outPath = path.resolve(ROOT, arg('out', 'generator/lib/host-mapper.generated.js'));
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(
  outPath,
  `${banner}\n${names.map((n) => included.get(n)).join('\n\n')}\n\nexport { ${names.join(', ')} };\n`,
  'utf8',
);

// Refuse to report success on a file that cannot even be parsed.
try {
  execFileSync(process.execPath, ['--check', outPath], { stdio: 'pipe' });
} catch (e) {
  const detail = String(e.stderr ?? e.message).split('\n').slice(0, 6).join('\n');
  console.error(`\nGENERATED FILE DOES NOT PARSE — extraction is broken:\n${detail}`);
  process.exit(1);
}

console.log('wrote', outPath, `(${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
console.log('syntax check: ok');
