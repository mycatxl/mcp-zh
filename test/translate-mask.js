/**
 * The masking and brand-detection logic, pinned offline.
 *
 * These are the parts of the translation pipeline that no other test touches,
 * and every one of them is a bug that was found the hard way rather than by
 * design — nested markers, an over-eager regex flag, a brand that matched as a
 * substring, a separator restored after the thing it separated was already
 * gone. All of them are pure string handling, so they need no network and can
 * be checked on every run.
 *
 *   node test/translate-mask.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mask, unmask, prepare, restore, applyGlossary } from '../generator/lib/translate.js';
import { nameTokens, isGenericWord, isOrdinaryWord, GENERIC_WORDS } from '../generator/lib/glossary-words.js';
import { CORPUS_GENERIC, CORPUS_DOCS, RULE } from '../generator/lib/word-stats.generated.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

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

// ---- 1. one pass, and no over-eager flag ---------------------------------
// Masking that runs over its own output matches the "A1" inside "[[A1]]" and
// nests the markers into something unrestorable. And the `i` flag on the
// acronym pattern would treat every word of 2+ letters as an acronym, masking
// whole English sentences.
console.log('1) masking is a single pass and does not over-match');
{
  const { masked, table } = prepare('run any ai model and stack knowledge');
  check('an ordinary English sentence is left alone', !/\[\[/.test(masked), masked);
  check('nothing was tabled', table.size === 0, `${table.size} entries`);
}
{
  // Feeding masked output back through must not nest.
  const once = mask('inference.sh and MCP');
  const twice = mask(once.masked);
  check('re-masking does not nest markers', !/\[\[\[\[/.test(twice.masked), twice.masked);
  check('the first pass still masked the domain', /\[\[A\d+\]\]/.test(once.masked), once.masked);
}

// ---- 2. a brand must never match as a plain substring -------------------
// The brand "getle" (from "ad.getle/leads") matches inside the title "Getlead".
// Splitting it produced "[[A1]]ad", which the engine rendered as 广告 — an
// advertisement. Tokens of 5+ characters therefore match greedily, as a whole
// word plus any suffix.
console.log('\n2) brand tokens match as words, not substrings');
{
  const { masked, table } = prepare('Getlead', { extra: new Set(['getle']) });
  const token = [...table.keys()][0];
  check('the whole word is captured', token === 'Getlead', `${JSON.stringify(token)}`);
  check('nothing is left outside the marker', masked === '[[A1]]', masked);
  check('no fragment survived as text', !/ad\b/.test(masked.replace(/\[\[A\d+\]\]/g, '')), masked);
}

// ---- 3. contiguous tokens merge into one marker -------------------------
// The engine drops the space between adjacent markers as often as it keeps it,
// and once it has, nothing downstream can tell whether the tokens were joined
// or merely adjacent. "CertScore" + ".ai" is the single word "CertScore.ai",
// which came out as "CertScore.aiMCP".
console.log('\n3) contiguous tokens become a single marker');
{
  const { masked, table } = prepare('CertScore.ai MCP Blade', { extra: new Set(['CertScore']) });
  const tokens = [...table.keys()];
  check('the two joined tokens merged', tokens.includes('CertScore.ai'), JSON.stringify(tokens));
  check('no adjacent markers remain', !/\]\]\[\[/.test(masked), masked);
  check('the separated token stays separate', /\]\].*\[\[|\]\] /.test(masked), masked);
}

// ---- 4. separators are restored BEFORE substitution ---------------------
// The order used to be the other way round: markers were replaced with their
// tokens first, so by the time a glued "]][[" could be looked for it no longer
// existed, the space was never restored, and two words fused.
console.log('\n4) unmask restores a dropped separator');
{
  const table = new Map([['CertScore.ai', '[[A1]]'], ['MCP', '[[A2]]']]);
  const out = unmask('[[A1]][[A2]] 刀片', table);
  check('the glue is split', out === 'CertScore.ai MCP 刀片', JSON.stringify(out));
  check('the space is between the two tokens', /\S \S/.test(out));
}

// ---- 5. a brand keeps its sentence period ------------------------------
// Left outside the marker the engine converts "." to the full-width 。, which
// turned "hood. — .hood name service" into "hood。 — .hood 名称服务".
console.log('\n5) a brand keeps a trailing ASCII period');
{
  const { masked, table } = prepare('hood. — .hood name service', { extra: new Set(['hood']) });
  check('the period is inside the marker', [...table.keys()].includes('hood.'), JSON.stringify([...table.keys()]));
  check('it is not left outside to be rewritten', !/^\[\[A\d+\]\]\./.test(masked), masked);
}

// ---- 6. ordinary vocabulary vs brands -----------------------------------
// A stoplist can never stay complete, and every word it missed was silently
// treated as a brand and left in English — the cause of "承包商执照 Changes".
// The corpus-derived set is what closes that gap.
console.log('\n6) ordinary vocabulary is recognised, brands are not');
{
  const ordinary = ['changes', 'licensed', 'recorder', 'calculator', 'bureau', 'readiness', 'signals', 'advisors', 'seller', 'affiliate', 'management', 'analysis'];
  const brands = ['propick', 'getlead', 'justidea', 'snag', 'zugabot', 'akiri', 'hood', 'dxpert', 'delega', 'betslip', 'agentutility', 'pipeworx', 'hive', 'oracle', 'arcgis'];

  const missed = ordinary.filter((w) => !isOrdinaryWord(w));
  const released = brands.filter((w) => isOrdinaryWord(w));
  check('ordinary words are released', missed.length === 0, missed.join(', '));
  check('brands stay protected', released.length === 0, released.join(', '));

  // Inflections are the specific reason the hand list alone failed: it holds
  // base forms, registry names do not.
  check('inflections resolve to a base form', isOrdinaryWord('changes') && isOrdinaryWord('licensed'));
  check('the hand list still applies on its own', isGenericWord('server') && isGenericWord('mcp'));
}

// ---- 7. the generated word set is present and plausible -----------------
console.log('\n7) the generated word set');
{
  const file = path.join(ROOT, 'generator', 'lib', 'word-stats.generated.js');
  check('the generated file is committed', fs.existsSync(file));
  check('it covers a real corpus', CORPUS_DOCS > 30000, `${CORPUS_DOCS} records`);
  check('it is a useful size', CORPUS_GENERIC.size > 500 && CORPUS_GENERIC.size < 20000, `${CORPUS_GENERIC.size} words`);
  check('the thresholds match the generator', RULE.minDf >= 1 && RULE.nameFactor >= 1);
  check('it holds lowercase words only', [...CORPUS_GENERIC].every((w) => w === w.toLowerCase()));

  // The generator regenerates this file from data/raw.jsonl, which CI has and a
  // fresh clone does not — so the committed copy must not be empty.
  const src = fs.readFileSync(path.join(ROOT, 'generator', 'build-word-stats.js'), 'utf8');
  check('the generator exists and documents its rule', /df >= 5|MIN_DF/.test(src) && /nameCount/.test(src));
}

// ---- 8. name tokens on the real slugs that failed -----------------------
console.log('\n8) name tokens on the slugs that caused bad titles');
{
  check('"contractor-licence-changes" protects nothing', nameTokens('contractor-licence-changes').size === 0, [...nameTokens('contractor-licence-changes')].join(', '));
  check('"one-page-readiness-check" protects nothing', nameTokens('one-page-readiness-check').size === 0);
  check('"bureau-public-reader" protects nothing', nameTokens('bureau-public-reader').size === 0);
  check('"Propick-Integration-MCP" keeps Propick', [...nameTokens('Propick-Integration-MCP')].join() === 'Propick');
  check('"justidea-agency" keeps justidea', [...nameTokens('justidea-agency')].join() === 'justidea');
  check('"agentutility/compose" keeps only agentutility', [...nameTokens('agentutility/compose')].join() === 'agentutility');
  check('short fragments are ignored', nameTokens('ab.cd/ef').size === 0);
}

// ---- 9. glossary substitution and CJK spacing --------------------------
console.log('\n9) glossary and spacing');
{
  check('"agents" becomes 智能体, not 代理', applyGlossary('compose agents') === 'compose 智能体', applyGlossary('compose agents'));
  check('"integration" is protected from 积分', applyGlossary('slack integration') === 'slack 集成');
  const out = restore('[[A1]]集成', new Map([['Slack', '[[A1]]']]));
  check('a marker restores without losing the boundary', out === 'Slack 集成', JSON.stringify(out));
}

console.log('\n--------------------------------------------');
console.log(`PASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);