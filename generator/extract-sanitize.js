/**
 * Can the order of market sources be controlled?
 *
 * This decides whether the official English source can be pushed behind the
 * Chinese one. The merge in the aggregator is:
 *
 *   settled.forEach((result, index) => { for (const entry of result.value.entries) ... })
 *
 * so entries appear in the order of the `safe` array, which comes from
 * sanitizeMarketSources(). If that function preserves the stored order, then
 * writing [ours, official] to storage puts ours first.
 *
 * The official source cannot be removed — `if (!sources.some(id === official))
 * sources.unshift(official)` adds it back, and the UI hides the remove button for
 * anything with `builtin: true`. But if the order is ours, this is moot.
 *
 * The real function is extracted from the installed bundle rather than
 * reimplemented, because a wrong assumption here means the plan silently fails.
 *
 *   node generator/extract-sanitize.js --bundle=<main/index.js>
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
  process.exit(1);
}
const src = fs.readFileSync(bundlePath, 'utf8');
console.log(`bundle: ${bundlePath}`);

const NOT_A_DEF = new Set([
  'if', 'else', 'for', 'while', 'return', 'function', 'const', 'let', 'var', 'new', 'typeof', 'instanceof',
  'in', 'of', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'delete',
  'void', 'this', 'null', 'undefined', 'true', 'false', 'class', 'extends', 'super', 'yield', 'await',
  'async', 'static', 'get', 'set', 'default', 'export', 'import', 'from', 'as',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Set', 'Map', 'URL', 'RegExp',
  'Error', 'Promise', 'NaN', 'Infinity', 'encodeURIComponent', 'decodeURIComponent', 'Symbol', 'Date',
]);

function regexAllowed(prev) {
  if (prev === '') return true;
  return '=(,:[!&|?{};+-*%^~<>'.includes(prev) || /\b(return|typeof|case|in|of|do|else|void|new|delete|instanceof|yield|await)$/.test(prev);
}

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
      const q = c;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) break;
        if (q === '`' && src[i] === '$' && src[i + 1] === '{') {
          let d = 1; i += 2;
          while (i < src.length && d > 0) { if (src[i] === '{') d += 1; else if (src[i] === '}') d -= 1; i += 1; }
          continue;
        }
        i += 1;
      }
      i += 1; prev = 'x'; continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1; i += 2; continue; }
    if (c === '/' && regexAllowed(prev)) {
      i += 1; let inClass = false;
      while (i < src.length) {
        const r = src[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '[') inClass = true; else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break; else if (r === '\n') break;
        i += 1;
      }
      i += 1; while (i < src.length && /[a-z]/.test(src[i])) i += 1;
      prev = 'x'; continue;
    }
    const top = paren === 0 && bracket === 0;
    if (c === '(') { paren += 1; prev = c; i += 1; continue; }
    if (c === ')') { paren -= 1; prev = c; i += 1; continue; }
    if (c === '[') { bracket += 1; prev = c; i += 1; continue; }
    if (c === ']') { bracket -= 1; prev = c; i += 1; continue; }
    if (c === '{') { if (top) { brace += 1; if (bodyStart < 0) bodyStart = i; } prev = c; i += 1; continue; }
    if (c === '}') { if (top && bodyStart >= 0) { brace -= 1; i += 1; if (brace === 0) return i; prev = c; continue; } prev = c; i += 1; continue; }
    if (c === ';' && top && bodyStart < 0) return i + 1;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return i;
}

const escapeRe = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cache = new Map();
function findDef(name) {
  if (cache.has(name)) return cache.get(name);
  const esc = escapeRe(name);
  for (const re of [
    new RegExp(`(?:^|\\n)(?:async\\s+)?function\\s+${esc}\\s*\\(`, 'm'),
    new RegExp(`(?:^|\\n)(?:const|let|var)\\s+${esc}\\s*=`, 'm'),
  ]) {
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
    if (dot || colon) continue;
    if (NOT_A_DEF.has(name)) continue;
    out.add(name);
  }
  return out;
}

const SEEDS = ['sanitizeMarketSources'];
const included = new Map();
const missing = new Set();
const queue = [...SEEDS];
while (queue.length) {
  const name = queue.shift();
  if (included.has(name) || missing.has(name)) continue;
  const def = findDef(name);
  if (!def) { missing.add(name); continue; }
  included.set(name, def);
  for (const id of referencedNames(def)) {
    if (included.has(id) || missing.has(id) || id === name) continue;
    if (findDef(id)) queue.push(id);
  }
}

console.log(`extracted ${included.size} definitions`);
const names = [...included.keys()].sort();
const outPath = path.resolve(ROOT, arg('out', 'generator/lib/sanitize.generated.js'));
const banner = [
  '/**',
  ' * GENERATED by generator/extract-sanitize.js — do not edit by hand.',
  ' *',
  " * The host's own sanitizeMarketSources(), lifted from app.asar. Used to answer",
  ' * one question definitively: does the stored ORDER of market sources survive,',
  ' * or is the official source always forced to the front?',
  ' *',
  ' * The answer decides whether the official English registry can be pushed behind',
  ' * a Chinese source. It cannot be removed (the UI hides remove for builtin:true,',
  ' * and a missing official entry is re-added with unshift), but order may be free.',
  ' *',
  ' * Regenerate after a PI-Desktop upgrade.',
  ' */',
  '',
].join('\n');
fs.writeFileSync(outPath, `${banner}\n${names.map((n) => included.get(n)).join('\n\n')}\n\nexport { ${names.join(', ')} };\n`, 'utf8');

try {
  execFileSync(process.execPath, ['--check', outPath], { stdio: 'pipe' });
} catch (e) {
  console.error('generated file does not parse:');
  console.error(String(e.stderr ?? e.message).split('\n').slice(0, 8).join('\n'));
  process.exit(1);
}
console.log('wrote', outPath, `(${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
console.log('syntax check: ok');
