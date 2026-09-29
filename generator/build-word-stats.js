#!/usr/bin/env node
/**
 * Decide which words taken from a registry NAME are ordinary English vocabulary
 * rather than part of a brand, and write that set out as a module.
 *
 * WHY THIS EXISTS
 *
 * The registry name doubles as a slug, e.g. "contractor-licence-changes". Its
 * words are used to protect brand names from being mangled in translation
 * ("Getlead" alone comes back as 格利德). That protection is decided by a
 * hand-written stoplist, and a stoplist can never be complete: any ordinary word
 * missing from it is treated as a brand and left in English, which is where
 * titles like "承包商执照 Changes" and "Licensed 房子 Painters" come from.
 * Measured on the real corpus, 1,747 hand-listed words missed 15,859 tokens
 * across 11,647 of 23,097 titles — over half of them.
 *
 * THE SIGNAL
 *
 * No dictionary is needed, because the corpus is its own dictionary. A word is
 * ordinary vocabulary when it turns up in the prose of many DIFFERENT records;
 * it is a brand when it turns up only in prose belonging to records whose name
 * contains it.
 *
 *     word      df    nameCount   ratio   verdict
 *     changes   138        5       27.6   ordinary vocabulary
 *     signals   286       42        6.8   ordinary vocabulary
 *     propick     1        1        1.0   brand
 *     agentutility 17      17        1.0   brand
 *     pipeworx    2     1712        0.0   brand
 *
 * df is per-record, not per-occurrence: a word used 40 times inside one record
 * still counts once, so a chatty record cannot inflate anything.
 *
 * The rule is deliberately conservative about releasing protection, because the
 * two mistakes are not equally bad. Failing to release leaves an English word in
 * a Chinese title (the complaint this fixes). Releasing too much hands a brand
 * to the engine, which will render "Hive" as 蜂箱 or "agentutility" as a
 * nonsense phrase. Only words that are clearly wider than their own name uses
 * are released: `df >= 5 && df >= 2 * nameCount + 3`.
 *
 *   node generator/build-word-stats.js            # regenerate
 *   node generator/build-word-stats.js --report   # and print what it decided
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { GENERIC_WORDS } from './lib/glossary-words.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RAW = path.join(ROOT, 'data', 'raw.jsonl');
const OUT = path.join(HERE, 'lib', 'word-stats.generated.js');

const REPORT = process.argv.includes('--report');

/** Minimum records a word must appear in before it can be called ordinary. */
const MIN_DF = 5;
/** How far its prose use must exceed its use inside names. */
const NAME_FACTOR = 2;
const NAME_SLACK = 3;

if (!fs.existsSync(RAW)) {
  console.error(`missing ${RAW}`);
  console.error('run:  node generator/step1-fetch.js');
  process.exit(1);
}

/**
 * df — how many records' PROSE contains the word.
 *
 * Deliberately every word of the title and description, not just the words that
 * also appear in a name. Step 3 decides protection per record with
 * `isOrdinaryWord()`, which tests the word against this same set, so the two
 * have to be counted the same way or the decision is made on a different corpus
 * than the one published.
 *
 * It also has to be countable without asking anything else. The first version
 * counted only `nameTokens(name)` and imported `nameTokens` from
 * lib/glossary-words.js — which reads the file this script writes. That import
 * is a cycle, and the failure was silent and self-reinforcing: with an empty
 * word set loaded, every ordinary word counts as a brand token, so its
 * nameCount grows to match its df, `df >= 2 * nameCount + 3` fails, and the
 * script wrote an even smaller set. Measured: it wrote an EMPTY one, which
 * removes brand protection from all 57k strings.
 */
const df = new Map();
/** nameCount — how many records' NAME contains the word. */
const nameCount = new Map();
let docs = 0;

const rl = readline.createInterface({ input: fs.createReadStream(RAW, { encoding: 'utf8' }), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    continue;
  }
  const s = rec.server ?? {};
  docs += 1;

  // One vote per record, so a record that repeats a word 40 times counts once.
  const seen = new Set();
  for (const w of `${s.title ?? ''} ${s.description ?? ''}`.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []) seen.add(w);
  for (const w of seen) df.set(w, (df.get(w) ?? 0) + 1);

  // Name tokens by exactly the rule nameTokens() uses — same separators, same
  // length floor, same character class. If these drift apart, the statistics
  // describe a different token set than the one protection actually consults,
  // and a word can be released here while still being protected there (or vice
  // versa). The rules are duplicated rather than shared because the real
  // function filters with isOrdinaryWord(), which reads the file this script
  // writes.
  for (const t of String(s.name ?? '').split(/[/.@_-]+/)) {
    if (t.length < 3) continue;
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(t)) continue;
    const k = t.toLowerCase();
    nameCount.set(k, (nameCount.get(k) ?? 0) + 1);
  }
}

/** Ordinary vocabulary: used in prose far beyond the records that name it. */
const isOrdinary = (w) => {
  const d = df.get(w) ?? 0;
  if (d < MIN_DF) return false;
  return d >= NAME_FACTOR * (nameCount.get(w) ?? 0) + NAME_SLACK;
};

// Union of: words that appear in a name AND come out ordinary, plus every word
// already listed by hand. The hand list stays authoritative for words the corpus
// happens not to use much (it is full of transport/tooling vocabulary).
const corpusGeneric = new Set();
for (const t of nameCount.keys()) if (isOrdinary(t)) corpusGeneric.add(t);

// A0. SANITY GUARD. This file is regenerated and COMMITTED by CI on every
// refresh, and step3 trusts whatever it says. Writing an empty (or tiny) word
// set therefore does not fail — it silently removes brand protection from all
// 57k strings and re-translates them with brands mangled ("JustIdea" -> 正意).
// One run did produce exactly that before this guard existed, and the summary
// step would have committed it. Refusing to write is the only safe failure
// mode: the previous good file stays in place and CI's exit code 1 is the alarm.
if (docs < 1000 || corpusGeneric.size < MIN_DF * 100) {
  console.error(`refusing to write a word set this small: ${corpusGeneric.size} words from ${docs} records`);
  console.error('expected at least a few thousand; check data/raw.jsonl and the thresholds above');
  process.exit(1);
}

const handKept = [...GENERIC_WORDS].filter((w) => !corpusGeneric.has(w));

const header = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate:  node generator/build-word-stats.js
 *
 * Words taken from a registry name that are ordinary English vocabulary rather
 * than part of a brand, decided by how widely each word is used across the
 * corpus. See the generator for the reasoning and the thresholds.
 *
 * Corpus: ${docs.toLocaleString()} records, ${df.size.toLocaleString()} distinct words,
 * ${nameCount.size.toLocaleString()} distinct name tokens.
 */
`;

const body = `${header}
/** Ordinary vocabulary, derived from the corpus. ${corpusGeneric.size.toLocaleString()} words. */
export const CORPUS_GENERIC = new Set(${JSON.stringify([...corpusGeneric].sort(), null, 0).replace(/","/g, '", "')});

/** Corpus size the decision was made from, for the report. */
export const CORPUS_DOCS = ${docs};

/** Thresholds used, so the numbers in comments can be checked. */
export const RULE = { minDf: ${MIN_DF}, nameFactor: ${NAME_FACTOR}, nameSlack: ${NAME_SLACK} };
`;

fs.writeFileSync(OUT, body, 'utf8');
console.log(`corpus        : ${docs.toLocaleString()} records, ${df.size.toLocaleString()} words`);
console.log(`name tokens   : ${nameCount.size.toLocaleString()} distinct`);
console.log(`hand list     : ${GENERIC_WORDS.size.toLocaleString()} words (${handKept.length} not covered by the corpus)`);
console.log(`CORPUS_GENERIC: ${corpusGeneric.size.toLocaleString()} words`);
console.log(`written       : ${path.relative(ROOT, OUT)}`);

if (REPORT) {
  const show = (label, words) => {
    console.log(`\n${label}`);
    for (const w of words.slice(0, 25)) {
      console.log(
        `  ${w.padEnd(20)} df=${String(df.get(w) ?? 0).padStart(5)}  name=${String(nameCount.get(w) ?? 0).padStart(4)}  ratio=${
          nameCount.get(w) ? ((df.get(w) ?? 0) / nameCount.get(w)).toFixed(1) : '∞'
        }`,
      );
    }
  };
  show('released (ordinary vocabulary)', [...corpusGeneric].sort((a, b) => (df.get(b) ?? 0) - (df.get(a) ?? 0)));
  show(
    'still protected (brand-ish)',
    [...nameCount.keys()].filter((w) => !corpusGeneric.has(w)).sort((a, b) => (nameCount.get(b) ?? 0) - (nameCount.get(a) ?? 0)),
  );
}