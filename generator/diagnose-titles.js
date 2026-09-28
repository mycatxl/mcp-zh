/**
 * Why are 13.5% of titles only PARTIALLY translated?
 *
 * Hypothesis: nameTokens() protects every non-generic word from the registry name,
 * so a name like `com.example/contractor-licence-changes` marks "contractor",
 * "licence" AND "changes" as brand tokens — leaving the translation engine nothing
 * to translate, and the title comes back half English.
 *
 * If true, the fix is to protect fewer tokens, not to re-translate.
 *
 *   node generator/diagnose-titles.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGenericWord, nameTokens } from './lib/glossary-words.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');

const audit = JSON.parse(fs.readFileSync(path.join(DATA, 'title-audit.json'), 'utf8'));
const suspects = audit.suspectExamples ?? [];
console.log(`suspect titles sampled: ${suspects.length}`);
console.log('');

// Map each suspect title back to its registry name.
const raw = fs
  .readFileSync(path.join(DATA, 'raw.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const byTitle = new Map();
for (const rec of raw) {
  const t = rec?.server?.title;
  if (typeof t === 'string') byTitle.set(t, rec.server.name);
}

let explained = 0;
let unexplained = 0;
const rows = [];

for (const s of suspects) {
  const name = byTitle.get(s.en) ?? '(unknown)';
  const tokens = [...nameTokens(name)].map((x) => x.toLowerCase());
  const untranslated = (s.untranslated ?? []).map((x) => x.toLowerCase());

  // Is every untranslated word explained by the protected set?
  const allProtected = untranslated.length > 0 && untranslated.every((w) => tokens.includes(w));
  if (allProtected) explained += 1;
  else unexplained += 1;

  rows.push({ en: s.en, zh: s.zh, name, tokens, untranslated, allProtected });
}

console.log('=================== IS EVERY UNTRANSLATED WORD A PROTECTED TOKEN? ===================');
console.log(`  fully explained by nameTokens() : ${explained}`);
console.log(`  NOT explained                   : ${unexplained}`);
console.log('');
for (const r of rows) {
  const mark = r.allProtected ? 'OK ' : '?? ';
  console.log(`${mark}"${r.en}"`);
  console.log(`      registry : ${r.name}`);
  console.log(`      protected: [${r.tokens.join(', ')}]`);
  console.log(`      left EN  : [${r.untranslated.join(', ')}]`);
}

console.log('');
console.log('=================== HOW OFTEN DOES THIS OVER-PROTECT? ===================');
{
  // For every record, how many name tokens are protected, and does that cover
  // most of the title's words?
  let total = 0;
  let overProtected = 0;
  const examples = [];
  for (const rec of raw) {
    const src = rec?.server ?? {};
    const title = typeof src.title === 'string' ? src.title.trim() : '';
    if (!title || !src.name) continue;
    const tokens = [...nameTokens(src.name)].map((x) => x.toLowerCase());
    if (!tokens.length) continue;
    total += 1;

    const titleWords = title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3);
    if (!titleWords.length) continue;

    const covered = titleWords.filter((w) => tokens.includes(w)).length;
    const ratio = covered / titleWords.length;
    if (ratio >= 0.6) {
      overProtected += 1;
      if (examples.length < 10) examples.push({ name: src.name, title, tokens, ratio });
    }
  }
  console.log(`  records with protected name tokens : ${total.toLocaleString()}`);
  console.log(`  where those tokens cover >=60% of the title's words : ${overProtected.toLocaleString()}  (${((overProtected / total) * 100).toFixed(1)}%)`);
  console.log('');
  for (const e of examples) {
    console.log(`  ${(e.ratio * 100).toFixed(0)}%  "${e.title}"`);
    console.log(`        tokens: [${e.tokens.join(', ')}]`);
  }
}

console.log('');
console.log('=================== WHAT IS ACTUALLY IN THE PROTECTED SET? ===================');
{
  // Show a few names with a suspiciously large protected set.
  const big = [];
  for (const rec of raw) {
    const src = rec?.server ?? {};
    if (!src.name) continue;
    const tokens = [...nameTokens(src.name)];
    if (tokens.length >= 3) big.push({ name: src.name, tokens });
  }
  console.log(`  names producing 3+ protected tokens: ${big.length.toLocaleString()}`);
  for (const b of big.slice(0, 8)) console.log(`    ${b.name}\n        -> [${b.tokens.join(', ')}]`);
}
