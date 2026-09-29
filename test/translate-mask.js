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
import os from 'node:os';
import { mask, unmask, prepare, restore, applyGlossary, classify, parseResponse, Translator } from '../generator/lib/translate.js';
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
  // The generator refuses to overwrite this file with a tiny set, because a
  // silently empty set strips brand protection from every string. Check that
  // the committed copy is still the healthy one.
  check('the word set is not empty or degraded', CORPUS_GENERIC.size > 1000, `${CORPUS_GENERIC.size} words`);
  check('it still holds words known to be ordinary', CORPUS_GENERIC.has('changes') && CORPUS_GENERIC.has('signals'));
  check('it still holds no known brand', !CORPUS_GENERIC.has('propick') && !CORPUS_GENERIC.has('agentutility'));
  const build = fs.readFileSync(path.join(ROOT, 'generator', 'build-word-stats.js'), 'utf8');
  check('the generator refuses to write a degraded set', /refusing to write a word set this small/.test(build));
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

// ---- 10. glossary: the senses the engine got wrong ----------------------
console.log('\n10) glossary picks the AI sense, and leaves the exceptions alone');
{
  const g = applyGlossary;
  check('memory -> 记忆 (not RAM)', g('AI memory layer') === 'AI 记忆 layer', g('AI memory layer'));
  check('in-memory keeps 内存', g('fast in-memory cache') === 'fast 内存 cache', g('fast in-memory cache'));
  check('memory usage keeps 内存', g('memory usage report') === '内存 usage report', g('memory usage report'));
  check('context -> 上下文', g('meeting context') === 'meeting 上下文', g('meeting context'));
  check('model -> 模型', g('run any model') === 'run any 模型', g('run any model'));
  check('make and model -> 品牌型号', g('by make and model') === 'by 品牌型号', g('by make and model'));
  check('"Model 3" / "Model Y" are left for protection', g('Tesla Model 3 and Model Y') === 'Tesla Model 3 and Model Y', g('Tesla Model 3 and Model Y'));
  check('helpdesk tickets -> 工单', g('solve tickets') === 'solve 工单', g('solve tickets'));
  check('train tickets are not 工单', !g('train ticket status').includes('工单'), g('train ticket status'));
  check('sales leads -> 潜在客户', g('B2B leads') === 'B2B 潜在客户' && g('lead generation') === '潜在客户 generation', `${g('B2B leads')} | ${g('lead generation')}`);
  check('"leads to" is a verb', !g('this leads to that').includes('潜在客户'));
  check('hub -> 中心, GitHub untouched', g('MCP Hub on GitHub') === 'MCP 中心 on GitHub', g('MCP Hub on GitHub'));
}

// ---- 11. well-known product names ---------------------------------------
console.log('\n11) well-known product names are protected, the plain words are not');
{
  const { masked, table } = prepare('recall from Claude, ChatGPT or Cursor');
  const tokens = [...table.keys()];
  check('Claude and Cursor are masked', tokens.includes('Claude') && tokens.includes('Cursor'), JSON.stringify(tokens));
  check('lowercase cursor is a word', !/\[\[/.test(prepare('cursor-based pagination', { glossary: false }).masked));
  check('lowercase linear is a word', !/\[\[/.test(prepare('runs in linear time', { glossary: false }).masked));
  check('"Model 3" is kept whole', [...prepare('Tesla Model 3 parts').table.keys()].includes('Model 3'));
  check('the masked text has no bare brand left', !/Claude|Cursor/.test(masked), masked);
}

// ---- 12. source-language routing ---------------------------------------
// sl=en does not just skip foreign text, it corrupts it ("구매가" -> "구매і").
console.log('\n12) source-language routing');
{
  const cases = [
    ['한국 연안 조석·물때를 조회합니다.', 'auto'],
    ['Клод Кот — генерация изображений', 'auto'],
    ['Cães e gatos para adoção no Brasil', 'auto'],
    ['搜索笔记、浏览首页推荐', 'han'],
    ['台灣電子發票查詢工具', 'han'],
    ['障害福祉AI辞典 (Japan Disability Welfare Dictionary)', 'han'],
    ['Taiwan Payments & E-Invoice (ECPay 綠界 / NewebPay 藍新)', 'en'],
    ['Find a café near the office', 'en'],
    ['Search the web and summarise pages', 'en'],
  ];
  const wrong = cases.filter(([t, r]) => classify(t) !== r).map(([t, r]) => `${t} => ${classify(t)} (want ${r})`);
  check('each sample takes the expected route', wrong.length === 0, wrong.join(' | '));
}

// ---- 13. response parsing ----------------------------------------------
// sl=auto answers with [[text, lang]]. Reading only strings made every auto
// answer look empty — which is how auto-detection was once written off.
console.log('\n13) engine response parsing');
{
  const en = parseResponse(['一', '二'], 2);
  check('sl=en: a list of strings', en[0].text === '一' && en[1].lang === null);
  const auto = parseResponse([['一', 'ko'], ['二', 'ru']], 2);
  check('sl=auto: pairs with the detected language', auto[0].text === '一' && auto[1].lang === 'ru');
  const single = parseResponse([['一', 'ko']], 1);
  check('sl=auto with one string is still a pair', single[0].text === '一' && single[0].lang === 'ko');
  let threw = false;
  try {
    parseResponse(['一'], 2);
  } catch {
    threw = true;
  }
  check('a short answer is an error, not a silent gap', threw);
}

// ---- 13b. what the engine does to markers and punctuation ----------------
console.log('\n13b) engine damage is repaired at restore time');
{
  const t = new Map([['MCP', '[[A1]]'], ['RoxyAPI', '[[A2]]']]);
  check('a moved bracket "[[A1] 服务器]" restores', unmask('占星 [[A1] 服务器] 由 [[A2]]', t) === '占星 MCP 服务器 由 RoxyAPI', unmask('占星 [[A1] 服务器] 由 [[A2]]', t));
  check('a lost closing bracket restores', unmask('[[A1] 服务器，由 [[A2]] 提供', t) === 'MCP 服务器，由 RoxyAPI 提供', unmask('[[A1] 服务器，由 [[A2]] 提供', t));
  check('unknown bracketed text is left alone', unmask('见 [[A9] 附录]', t) === '见 [[A9] 附录]', unmask('见 [[A9] 附录]', t));

  const p = new Map([['Packagist.', '[[A1]]']]);
  check('a period carried into mid-sentence is dropped', unmask('从 [[A1]] 查找 PHP 软件包', p) === '从 Packagist 查找 PHP 软件包。', unmask('从 [[A1]] 查找 PHP 软件包', p));
  check('a period still at the end is kept', unmask('查找 [[A1]]', p) === '查找 Packagist.', unmask('查找 [[A1]]', p));

  // Only "brand. —" keeps its period; an ordinary sentence end stays visible.
  const felix = prepare('Streamline with Felix. Integrate it', { extra: new Set(['felix']) });
  check('a sentence-final period stays outside the marker', felix.masked.includes(']]. '), felix.masked);

  const k = prepare('card, 가상계좌 via Toss', { glossary: false, keepForeign: true });
  check('keepForeign protects the foreign word', [...k.table.keys()].includes('가상계좌'), JSON.stringify([...k.table.keys()]));
  check('without keepForeign it is not masked', !prepare('card, 가상계좌 via Toss', { glossary: false }).table.has('가상계좌'));

  const e = new Map();
  check('a split hyphen becomes a space', restore('AI-智能体准备度', e) === 'AI 智能体准备度', restore('AI-智能体准备度', e));
  check('"AI 代理商" becomes AI 智能体', restore('日本向 AI 代理商付款', e) === '日本向 AI 智能体付款', restore('日本向 AI 代理商付款', e));
  check('Chinese source keeps "AI 代理人"', restore('AI 代理人任务中枢', e, { postFix: false }) === 'AI 代理人任务中枢');

  const cc = prepare('works in Claude Code and VS Code');
  check('multi-word names are one token each', cc.table.has('Claude Code') && cc.table.has('VS Code'), JSON.stringify([...cc.table.keys()]));
}

// ---- 14. the Translator end to end, against a fake engine ----------------
console.log('\n14) Translator routing and cache, with a fake engine');
{
  const calls = [];
  const answers = new Map([
    // auto
    ['auto|한국 상품을 검색합니다', ['韩国产品搜索', 'ko']],
    ['auto|搜索笔记、浏览首页推荐', ['搜索笔记、浏览推荐', 'zh-CN']],
    ['auto|台灣電子發票查詢工具', ['台湾电子发票查询工具', 'en']],
    ['auto|網紅開團合規工具箱', ['网红工具箱', 'en']],
    ['auto|Find a [[A1]] with Pokédex', ['用 Pokédex 找', 'en']],
    ['auto|[[A1]]: achtergrondmuziek voor bedrijven', ['[[A1]]：企业背景音乐', 'nl']],
    // en
    ['en|Find a [[A1]] with Pokédex', '用 Pokédex 找一个 [[A1]]'],
    ['en|[[A1]]: achtergrondmuziek voor bedrijven', '[[A1]]: achtergrondmuziek voor bedrijven'],
    ['en|[[A1]]', '[[A1]]'],
    ['en|Search 记忆', '搜索记忆'],
  ]);
  const fake = async (list, { sl }) => {
    calls.push({ sl, list: [...list] });
    return list.map((m) => {
      const a = answers.get(`${sl}|${m}`);
      if (a === undefined) return { text: '', lang: null }; // engine gave nothing
      return Array.isArray(a) ? { text: a[0], lang: a[1] } : { text: a, lang: null };
    });
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpzh-'));
  const cachePath = path.join(dir, 'cache.json');
  const jobs = [
    { text: '한국 상품을 검색합니다', extra: new Set() },
    { text: '搜索笔记、浏览首页推荐', extra: new Set() },
    { text: '台灣電子發票查詢工具', extra: new Set() },
    { text: '網紅開團合規工具箱', extra: new Set() },
    { text: 'Find a Getlead with Pokédex', extra: new Set(['getlead']) },
    { text: 'RadioMatic: achtergrondmuziek voor bedrijven', extra: new Set() },
    { text: 'Getlead', extra: new Set(['getlead']) },
    { text: 'Search memory', extra: new Set() },
    { text: 'Nothing comes back for this one', extra: new Set() },
  ];
  const t = new Translator({ cachePath, request: fake, concurrency: 1 });
  const map = await t.translateJobs(jobs, { prune: true });

  const sentAsEnglish = calls.filter((c) => c.sl === 'en').flatMap((c) => c.list);
  check('Korean is never sent with sl=en', !sentAsEnglish.some((m) => /[\uac00-\ud7af]/.test(m)), JSON.stringify(sentAsEnglish));
  check('Korean is translated via auto', map.get('한국 상품을 검색합니다') === '韩国产品搜索', map.get('한국 상품을 검색합니다'));
  check('Simplified Chinese keeps the original (no dropped 首页)', map.get('搜索笔记、浏览首页推荐') === '搜索笔记、浏览首页推荐', map.get('搜索笔记、浏览首页推荐'));
  check('Traditional Chinese is converted even when labelled en', map.get('台灣電子發票查詢工具') === '台湾电子发票查询工具', map.get('台灣電子發票查詢工具'));
  check('Chinese that lost characters falls back to the original', map.get('網紅開團合規工具箱') === '網紅開團合規工具箱', map.get('網紅開團合規工具箱'));
  check('an auto candidate detected as English takes the English path', map.get('Find a Getlead with Pokédex') === '用 Pokédex 找一个 Getlead', map.get('Find a Getlead with Pokédex'));
  check('ASCII-only foreign prose gets a second chance', map.get('RadioMatic: achtergrondmuziek voor bedrijven') === 'RadioMatic：企业背景音乐', map.get('RadioMatic: achtergrondmuziek voor bedrijven'));
  check('a brand-only title is not retried', !calls.some((c) => c.sl === 'auto' && c.list.includes('[[A1]]')));
  check('the glossary reaches the English path', map.get('Search memory') === '搜索记忆', map.get('Search memory'));
  check('an empty answer yields no translation', !map.has('Nothing comes back for this one'));

  const saved = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  check('the cache file is versioned', saved.version === 2 && typeof saved.entries === 'object');
  check('an empty answer is not cached', !Object.values(saved.entries).some((v) => v === '' || (Array.isArray(v) && !v[0])));
  check('the cache holds raw engine output', Object.values(saved.entries).includes('用 Pokédex 找一个 [[A1]]'));

  // Offline resolution from the saved file matches what the run returned.
  const offline = new Translator({ cachePath, request: async () => { throw new Error('network used'); } });
  const again = offline.resolveJobs(jobs);
  const same = [...map].every(([k, v]) => again.get(k) === v) && again.size === map.size;
  check('resolveJobs() reproduces the run without the network', same);

  // A fix to unmask() reaches cached entries, because they are stored raw.
  // The engine glued the two markers together; the cache stores that verbatim.
  const certMasked = prepare('CertScore.ai MCP Blade', { extra: new Set(['CertScore']) }).masked;
  const k = Translator.key('en', certMasked);
  const glued = certMasked.replace(/\]\] \[\[/, ']][[').replace(' Blade', ' 刀片');
  fs.writeFileSync(cachePath, JSON.stringify({ version: 2, entries: { [k]: glued } }));
  const fixed = new Translator({ cachePath }).resolveJobs([{ text: 'CertScore.ai MCP Blade', extra: new Set(['CertScore']) }]);
  check('restoration is applied at read time', fixed.get('CertScore.ai MCP Blade') === 'CertScore.ai MCP 刀片', fixed.get('CertScore.ai MCP Blade'));

  // A cache in the old layout holds restored text; it must not be served.
  fs.writeFileSync(cachePath, JSON.stringify({ deadbeef: '旧' }));
  check('an old-layout cache is ignored', new Translator({ cachePath }).cache.size === 0);

  // prune keeps only what a run touched.
  fs.writeFileSync(cachePath, JSON.stringify({ version: 2, entries: { stale: 'x' } }));
  const p = new Translator({ cachePath, request: fake });
  await p.translateJobs([{ text: 'Search memory', extra: new Set() }], { prune: true });
  const pruned = JSON.parse(fs.readFileSync(cachePath, 'utf8')).entries;
  check('prune drops entries the run did not use', !('stale' in pruned) && Object.keys(pruned).length === 1, JSON.stringify(Object.keys(pruned)));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- 15. second chance: Title Case foreign titles, and misdetections ------
console.log('\n15) second chance takes Title Case foreign text, rejects impossible verdicts');
{
  const answers = new Map([
    ['en|DETRAN MG: Multas (Descritivos)', 'DETRAN MG: Multas (Descritivos)'],
    ['auto|[[A1]] [[A2]]: Multas (Descritivos)', ['[[A1]] [[A2]]：罚款（描述性）', 'pt']],
    ['en|Mes Frais de Notaire', 'Mes Frais de Notaire'],
    ['auto|Mes Frais de Notaire', ['时间 Frais 至 Notaire', 'ar']],
  ]);
  // The English path masks DETRAN and MG too; key the fake on what is sent.
  const fake = async (list, { sl }) =>
    list.map((m) => {
      const a = answers.get(`${sl}|${m}`) ?? answers.get(`${sl}|${m.replace(/\[\[A1\]\] \[\[A2\]\]/, 'DETRAN MG')}`);
      if (a === undefined) return { text: '', lang: null };
      return Array.isArray(a) ? { text: a[0], lang: a[1] } : { text: a, lang: null };
    });
  const t = new Translator({ request: fake });
  const map = await t.translateJobs([
    { text: 'DETRAN MG: Multas (Descritivos)', extra: new Set() },
    { text: 'Mes Frais de Notaire', extra: new Set() },
  ]);
  check('a Title Case Portuguese title is translated', map.get('DETRAN MG: Multas (Descritivos)') === 'DETRAN MG：罚款（描述性）', map.get('DETRAN MG: Multas (Descritivos)'));
  check('an "ar" verdict on Latin text is rejected', map.get('Mes Frais de Notaire') === 'Mes Frais de Notaire', map.get('Mes Frais de Notaire'));

  const b = prepare('Balanços.AI', { glossary: false });
  check('a domain with an accented label is one token', [...b.table.keys()].join() === 'Balanços.AI', JSON.stringify([...b.table.keys()]));
}

console.log('\n--------------------------------------------');
console.log(`PASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);