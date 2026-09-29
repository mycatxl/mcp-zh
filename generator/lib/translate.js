/**
 * Batch translator for registry titles and descriptions.
 *
 * Uses the free Google web endpoint (clients5 dict-chrome-ex), which accepts many
 * `q=` parameters in ONE request and returns a JSON array — measured ~120-190 new
 * strings/s on real registry data, so all 57k strings finish in minutes at zero cost.
 *
 * Quality controls, each verified experimentally against the live endpoint:
 *
 *  1. Marker protection. `[[A1]]` survives translation untouched, so tokens that
 *     must stay verbatim can be hidden and restored. Bare tokens get mangled:
 *     "Getlead" -> "格利德", "Claude" -> "克劳德", "Stripe" -> "条纹".
 *  2. Per-record brand tokens (derived from the registry name) plus a fixed list
 *     of well-known product names are protected. Generic vocabulary is not.
 *  3. Glossary pre-substitution. Writing the Chinese term inline ("coding 智能体")
 *     makes the engine emit it verbatim, fixing "agent" -> "代理" (proxy),
 *     "memory" -> "内存" (RAM) and "integration" -> "积分" (a math integral).
 *  4. Source-language routing. Sending Korean, Russian or Spanish with `sl=en`
 *     does not merely leave it untranslated — the engine CORRUPTS it character by
 *     character ("구매가" -> "구매і", "데이터" -> "데ք", "GİB" -> "G?B"). Such text
 *     goes through `sl=auto` instead, and is never sent with `sl=en` at all.
 *
 * Bugs found the hard way; do not "simplify" them away:
 *
 *  - Masking must be ONE pass. Running the protection regex over text that
 *    already holds markers matches the "A1" inside "[[A1]]" and nests them
 *    ("[[[[A3]]]]"), which then cannot be restored.
 *  - The combined regex must NOT use the `i` flag. `[A-Z]{2,}` is meant to catch
 *    acronyms (MCP, SDK); case-insensitively it matches every 2+ letter word and
 *    masks entire English sentences. Brand tokens get explicit [aA] classes.
 *  - Brand tokens must never be plain substrings. The brand "getle" (from
 *    "ad.getle/leads") matches inside the title "Getlead"; splitting it produced
 *    "[[A1]]ad", which the engine rendered as an advertisement.
 *  - `sl=auto` answers with `[[translation, detectedLanguage], ...]`, not a list
 *    of strings. Parsing only strings made every answer look empty, which is how
 *    auto-detection was once wrongly written off as "not supported".
 *  - The cache must hold the RAW engine output, keyed by exactly what was sent.
 *    It used to hold the restored result keyed by the source text, so a fix to
 *    unmask() never reached any string whose key had not changed — a repaired
 *    bug kept being served from the cache.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nameTokens } from './glossary-words.js';

const ENDPOINT = 'https://clients5.google.com/translate_a/t';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/**
 * English -> Chinese terms the engine gets wrong or renders inconsistently.
 *
 * Applied in order, to English text only. An optional third element is a guard:
 * when it matches the ORIGINAL text, that rule is skipped for the whole string
 * ("train tickets" are 车票, not 工单).
 *
 * Rules that consume the space after a word ("memory usage" -> "内存 usage")
 * put it back in the replacement, so the next word is still a separate token.
 */
export const GLOSSARY = [
  [/\bagents?\b/gi, '智能体'],
  [/\bagentic\b/gi, '智能体'],
  [/\btokens?\b/gi, '令牌'],
  [/\bprompts?\b/gi, '提示词'],
  [/\bworkflows?\b/gi, '工作流'],
  [/\brepositories\b/gi, '仓库'],
  [/\brepository\b/gi, '仓库'],
  [/\brepos\b/gi, '仓库'],
  [/\bLLMs?\b/g, '大语言模型'],
  [/\bembeddings?\b/gi, '嵌入向量'],
  [/\bknowledge base\b/gi, '知识库'],
  [/\breal[- ]time\b/gi, '实时'],
  [/\bendpoints?\b/gi, '接口端点'],
  [/\bcrawling\b/gi, '抓取'],
  [/\bscraping\b/gi, '抓取'],
  [/\bpull requests?\b/gi, '拉取请求'],
  [/\bwebhooks?\b/gi, 'Webhook'],
  [/\bintegrations?\b/gi, '集成'],
  [/\bplatforms?\b/gi, '平台'],
  [/\bdashboards?\b/gi, '仪表板'],
  [/\bnotifications?\b/gi, '通知'],
  [/\bsummar(?:y|ies)\b/gi, '摘要'],
  [/\banalytics\b/gi, '分析'],
  [/\bmonitoring\b/gi, '监控'],
  [/\bpipelines?\b/gi, '流水线'],
  [/\btemplates?\b/gi, '模板'],
  [/\bdeployments?\b/gi, '部署'],
  [/\bservers?\b/gi, '服务器'],
  [/\bclients?\b/gi, '客户端'],
  [/\bplugins?\b/gi, '插件'],
  [/\bextensions?\b/gi, '扩展'],
  [/\bconnectors?\b/gi, '连接器'],
  [/\blint(?:er|ers|ing)\b/gi, '代码检查'],
  // "memory" of an AI is 记忆; the engine said 内存 (RAM) 643 times. The RAM
  // senses are spelled out first so they keep 内存.
  [/\bin-memory\b/gi, '内存'],
  [/\bGPU memory\b/gi, 'GPU 显存'],
  [/\bmemory (?=(?:usage|leaks?|footprint|limits?|consumption|allocation|pressure|profil\w*|bandwidth)\b)/gi, '内存 '],
  [/\bmemor(?:y|ies)\b/gi, '记忆'],
  // "context" of a model is 上下文; the engine said 背景 (background).
  [/\bcontexts?\b/gi, '上下文'],
  // "model" is an AI model (模型), except a car's "make and model" and a product
  // designation such as "Model 3" / "Model Y" (protected verbatim below).
  [/\bmakes?(?:,| and| &| or) models?\b/gi, '品牌型号'],
  [/\b[Mm]odels?\b(?! (?:[0-9]|[A-Z]\b))/g, '模型'],
  [/\bhubs?\b/gi, '中心'],
  [
    /\btickets?\b/gi,
    '工单',
    /\b(?:trains?|flights?|air(?:line|fare)s?|events?|concerts?|movies?|cinemas?|films?|theat(?:er|re)s?|lotter(?:y|ies)|bus(?:es)?|rail(?:way)?s?|museums?|festivals?|matches|games?|box office|seats?|travel|trips?|parking|admission|booking|irctc)\b/i,
  ],
  [/\bleads\b/gi, '潜在客户', /\bleads to\b/i],
  [
    /\blead (?=(?:generation|gen|intelligence|discovery|enrichment|scoring|capture|management|automation|lists?|data|magnets?|quotes?|sourcing|qualification|routing|prospecting)\b)/gi,
    '潜在客户 ',
  ],
  [/\bfull[- ]stack\b/gi, '全栈'],
  [/\btech(?:nology)?[- ]stack\b/gi, '技术栈'],
  [/\b(OpenAPI|Swagger|API|MCP) spec(?:ification)?s?\b/g, '$1 规范'],
];

/**
 * Product names the engine translates literally when they appear in running
 * text: "Claude" -> 克劳德, "Obsidian" -> 黑曜石, "Cursor" -> 光标, "Stripe" ->
 * 条纹, "Playwright" -> 剧作家. Chosen by measuring how often each one was lost
 * in the real corpus. Matched case-sensitively as whole words only, so ordinary
 * lowercase words ("cursor-based", "linear time") are untouched.
 *
 * Deliberately absent: names with an established Chinese form (亚马逊, 谷歌,
 * 苹果, 微软, 比特币, 以太坊, 推特), and names that are also common capitalised
 * English words (Make, Box, Kit, Square, Signal, Teams, Outlook, Base).
 */
export const GLOBAL_BRANDS = [
  'Airtable', 'Anthropic', 'Apify', 'Arbitrum', 'Asana', 'Attio', 'Azure', 'Beehiiv', 'Bluesky', 'Calendly',
  'Canva', 'Chainlink', 'Chrome', 'Claude', 'Cline', 'Confluence', 'Copilot', 'Cursor', 'Deepgram', 'Discord',
  'Dropbox', 'Evernote', 'Figma', 'Framer', 'Gemini', 'Gmail', 'Grok', 'Groq', 'Hyperliquid', 'Ideogram',
  'Intercom', 'Jira', 'Kimi', 'Kling', 'Linear', 'Llama', 'Loom', 'Midjourney', 'Mistral', 'Neon', 'Netlify',
  'Notion', 'Obsidian', 'Ollama', 'Perplexity', 'Pipedrive', 'Plaid', 'Playwright', 'Polygon', 'Postmark',
  'Puppeteer', 'Qwen', 'Raycast', 'Reddit', 'Resend', 'Runway', 'Safari', 'Salesforce', 'Sentry', 'Shopify',
  'Slack', 'Snowflake', 'Stripe', 'Substack', 'Suno', 'Supabase', 'Tavily', 'Telegram', 'Terraform', 'Todoist',
  'Trello', 'Vercel', 'Webflow', 'Windsurf', 'Xero', 'Zapier', 'Zed', 'Zendesk', 'Zoom',
];

/**
 * Multi-word names that were split and half-translated: "Claude Code" kept its
 * form in only 18 of 256 texts ("Claude 代码"), "Hugging Face" became 抱脸,
 * "Home Assistant" 家庭助理. Listed before the single words so they win.
 */
export const MULTIWORD_BRANDS = [
  'Claude Code', 'Claude Desktop', 'Visual Studio Code', 'VS Code', 'Hugging Face', 'Home Assistant',
  'Product Hunt', 'Hacker News', 'Stack Overflow',
];

/**
 * Case-sensitive patterns for tokens that must survive verbatim:
 *  - domains, with or without a leading label (".hood", "api.foo.com")
 *  - camelCase / PascalCase words with an internal capital ("JustIdea")
 *  - all-caps acronyms ("MCP", "API", "SDK")
 *  - mixed letter+digit tokens ("B2B", "GPT4") — but NOT bare numbers, so
 *    "50 states" still becomes "50 个州"
 *  - the product names above, and designations such as "Model 3"
 */
const PROTECT_SOURCES = [
  // Names first: alternation takes the first branch that matches at a
  // position, and the acronym rule would otherwise claim the "VS" of "VS Code".
  `\\b(?:${[...MULTIWORD_BRANDS, ...GLOBAL_BRANDS].join('|')})\\b`,
  '\\bModel (?:[0-9]+|[A-Z])\\b',
  '(?:[A-Za-z0-9_\\u00C0-\\u024F][A-Za-z0-9_.+\\u00C0-\\u024F-]*)?\\.[A-Za-z]{2,}',
  '\\b[A-Za-z][a-z]+[A-Z][A-Za-z0-9]*\\b',
  '\\b[A-Z]{2,}\\b',
  '\\b(?:[A-Za-z]+\\d[A-Za-z0-9]*|\\d+[A-Za-z][A-Za-z0-9]*)\\b',
];

/** A word containing a non-Latin letter or an accented Latin one. */
const FOREIGN_LETTER =
  '\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u024F\\u0370-\\u03FF\\u0400-\\u04FF\\u0590-\\u05FF\\u0600-\\u06FF\\u0900-\\u097F\\u0E00-\\u0E7F\\u1100-\\u11FF\\u3040-\\u30FF\\uAC00-\\uD7AF';
const FOREIGN_WORD = `[A-Za-z${FOREIGN_LETTER}]*[${FOREIGN_LETTER}][A-Za-z${FOREIGN_LETTER}]*`;

/** "inference" -> "[iI][nN][fF][eE][rR][eE][nN][cC][eE]" (case-insensitive literal) */
function literalClass(token) {
  return [...token]
    .map((ch) =>
      /[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
}

export function applyGlossary(text) {
  let out = text;
  for (const [re, zh, guard] of GLOSSARY) {
    if (guard && guard.test(text)) continue;
    out = out.replace(re, zh);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Source-language routing

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const count = (text, re) => (text.match(re) ?? []).length;

/**
 * Which request a source string needs:
 *   'en'   English (possibly with a few foreign words) -> sl=en plus glossary
 *   'auto' another script, or Latin with real diacritics -> sl=auto, detected
 *   'han'  mostly Chinese characters -> sl=auto; Simplified is kept, Traditional
 *          converted, Japanese kanji translated
 *
 * A false 'auto' is cheap: the engine reports "en" and the string simply takes
 * the English path. A false 'en' is what corrupts text, so the thresholds lean
 * towards 'auto'.
 */
export function classify(text) {
  const foreign = count(text, /[\u3040-\u30ff\uac00-\ud7af\u1100-\u11ff\u0370-\u03ff\u0400-\u04ff\u0590-\u05ff\u0600-\u06ff\u0900-\u097f\u0e00-\u0e7f]/g);
  if (foreign >= 2) return 'auto';
  const han = count(text, /[\u3400-\u9fff\uf900-\ufaff]/g);
  if (han >= 2 && han >= count(text, /[A-Za-z]{2,}/g)) return 'han';
  const accented = count(text, /[\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u024f]/g);
  const latin = count(text, /[A-Za-z]/g) + accented;
  if (accented >= 2 && accented / latin >= 0.02) return 'auto';
  return 'en';
}

/**
 * Words of 2+ letters, lowercase or capitalised (not acronyms) — "could this be
 * prose?" for the second-chance pass. Capitalised words count because foreign
 * titles are usually Title Case: "DETRAN MG: Multas (Descritivos)".
 */
const proseWords = (text) => count(text, /\b[A-Za-z][a-z]+\b/g);

/**
 * Languages written in the Latin alphabet. The second chance only ever sees
 * Latin-script text, so a verdict outside this set is a misdetection — masked
 * brand-only titles come back as "ar" or "hmn", and one French title labelled
 * "ar" turned into "时间 Frais 至 Notaire".
 */
const LATIN_LANGS = new Set(
  ('af az bs ca cs cy da de es et eu fi fil fr ga gl hr hu id is it lt lv ms mt nl no nb pl pt pt-PT pt-BR ' +
    'ro sk sl sq sv sw tl tr uz vi').split(' '),
);

// ---------------------------------------------------------------------------
// Masking

/**
 * Hide protected tokens behind `[[A<n>]]` markers — one pass, so markers are
 * never re-scanned.
 *
 * Two things beyond the plain substitution:
 *
 *  - A brand followed by a period and a dash ("hood. — .hood name service") is
 *    protected WITH the period: that period is part of a stylised name, and
 *    left outside the engine turned it into "hood。 —". Only that shape. Taking
 *    every sentence-final period into the marker (as an earlier version did)
 *    hid 430 sentence boundaries from the engine: it merged sentences
 *    ("…应用程序 搜索、委托") and carried the period into the middle of the
 *    Chinese ("从 Packagist. 查找").
 *  - Tokens with NO separator between them are merged into a single marker. The
 *    engine drops the space between two adjacent markers as often as it keeps
 *    it, and once it has, nothing downstream can tell whether the tokens were
 *    originally joined or merely adjacent — "CertScore" + ".ai" is the single
 *    word "CertScore.ai" and came out as "CertScore.aiMCP". Merging at mask time
 *    makes the answer unambiguous: adjacent markers with no space between them
 *    were contiguous in the source, so their markers become one.
 *
 * @param {string} text
 * @param {{extra?: Set<string>, keepForeign?: boolean}} opts  literal brand
 *   tokens to protect; keepForeign also protects every word written in a
 *   non-Latin script or with accented letters
 * @returns {{masked: string, table: Map<string,string>}} table: original token -> marker
 */
export function mask(text, { extra, keepForeign = false } = {}) {
  const table = new Map(); // token -> marker
  const byMarker = new Map(); // marker -> token, kept in step by put()
  let n = 0;
  const put = (token) => {
    const existing = table.get(token);
    if (existing) return existing;
    n += 1;
    const marker = `[[A${n}]]`;
    table.set(token, marker);
    byMarker.set(marker, token);
    return marker;
  };

  const alts = [];
  if (extra && extra.size) {
    // Longest first. A brand of 5+ chars may be the stem of the word used in the
    // title (name "ad.getle/leads" vs title "Getlead"), so it matches as a whole
    // word plus a suffix — greedy, so "Getlead" is captured intact instead of
    // being split into "[[A1]]ad" (which translated to "广告", an advert).
    // Shorter tokens stay exact-word only, to avoid eating ordinary words.
    for (const token of [...extra].filter((t) => t && t.length >= 3).sort((a, b) => b.length - a.length)) {
      const cls = literalClass(token);
      const core = `\\b${cls}${token.length >= 5 ? '[A-Za-z0-9]*' : ''}`;
      // The period variant goes first so that it wins over the plain form.
      alts.push(`${core}\\.(?=\\s+[—–-])`);
      alts.push(`${core}\\b`);
    }
  }
  if (keepForeign) alts.push(FOREIGN_WORD);
  // Existing markers are consumed and returned untouched, which is what makes
  // the pass safe to run over its own output. Without this, the letter+digit
  // pattern matches the "A1" inside "[[A1]]" and nests it into "[[[[A1]]]]" —
  // indistinguishable from a real marker and impossible to restore.
  alts.push(...PROTECT_SOURCES);
  alts.unshift('\\[\\[A\\d+\\]\\]');

  const combined = new RegExp(alts.join('|'), 'g');
  const MARKER = /^\[\[A\d+\]\]$/;
  let masked = text.replace(combined, (m) => (MARKER.test(m) ? m : put(m)));

  // Collapse markers that ended up directly adjacent, repeatedly, so a run of
  // three contiguous tokens merges in one pass rather than pairwise. Merging
  // registers the combined token through put(), which is what keeps byMarker
  // able to resolve the marker the previous round just created.
  let previous;
  do {
    previous = masked;
    masked = masked.replace(/\[\[A(\d+)\]\]\[\[A(\d+)\]\]/g, (whole, a, b) => {
      const ta = byMarker.get(`[[A${a}]]`);
      const tb = byMarker.get(`[[A${b}]]`);
      return ta == null || tb == null ? whole : put(ta + tb);
    });
  } while (masked !== previous);

  return { masked, table };
}

/**
 * Restore markers.
 *  - tolerant of whitespace/case the engine introduces inside the brackets
 *  - re-inserts a space when the engine glues two markers together ("]][[")
 *
 * ORDER MATTERS, and getting it wrong was a real bug. The separator has to be
 * restored BEFORE the markers are substituted: the substitution replaces each
 * marker with its token, so by the time "]][[" could be found it no longer
 * exists as such, the space is never reinserted, and two separate tokens fuse
 * into one word. "CertScore.ai MCP Blade" came out as "CertScore.aiMCP 刀片".
 *
 * Restoring first is only safe because mask() merges markers whose tokens were
 * genuinely contiguous — so a glued pair here always means the engine dropped a
 * separator that was really there.
 */
export function unmask(text, table) {
  const byMarker = new Map([...table].map(([token, marker]) => [marker, token]));
  const token = (d) => byMarker.get(`[[A${d}]]`);
  let droppedPeriod = false;
  // A token that ends in "." carried its sentence period (see mask()). If the
  // engine moved it into the middle of a Chinese sentence, the period no
  // longer ends anything and is dropped.
  const put = (d, m, offset, str) => {
    const t = token(d);
    if (t == null) return m;
    if (t.endsWith('.') && /^\s*[\u3400-\u9fff]/.test(str.slice(offset + m.length))) {
      droppedPeriod = true;
      return t.slice(0, -1);
    }
    return t;
  };
  let out = String(text ?? '')
    .replace(/\]\]\s*\[\[/g, ']] [[')
    .replace(/\[\[\s*A\s*(\d+)\s*\]\]/gi, (m, d, offset, str) => put(d, m, offset, str))
    // The engine sometimes moves one bracket: "[[A1]] 服务器" came back as
    // "[[A1] 服务器]", or loses it entirely. Only numbers that exist in the
    // table are touched, so ordinary bracketed text is safe.
    .replace(/\[\[\s*A\s*(\d+)\s*\]([^[\]]*)\]/gi, (m, d, mid) => (token(d) == null ? m : token(d) + mid))
    .replace(/\[\[\s*A\s*(\d+)\s*\](?!\])/gi, (m, d) => token(d) ?? m)
    .replace(/(?<!\[)\[\s*A\s*(\d+)\s*\]\]/gi, (m, d) => token(d) ?? m);
  if (droppedPeriod && !/[。！？.!?…」』"”)）]$/.test(out.trim())) out = `${out.trim()}。`;
  // The engine pads markers with spaces; normalise CJK<->latin boundaries.
  return out
    .replace(/([\u3400-\u9fff])\s*([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])\s*([\u3400-\u9fff])/g, '$1 $2')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。、；：！？）】》])/g, '$1')
    .replace(/([（【《])\s+/g, '$1')
    .trim();
}

export function prepare(text, { glossary = true, extra, keepForeign = false } = {}) {
  const withGlossary = glossary ? applyGlossary(text) : text;
  return mask(withGlossary, { extra, keepForeign });
}

/**
 * @param {{postFix?: boolean}} opts  clean up what the engine itself gets wrong:
 *   "AI 代理/代理商" (proxy, agency) -> AI 智能体, and a hyphen left between
 *   latin and Chinese when it split a compound ("AI-智能体" from "AI-agent").
 *   Off for text that was Chinese to begin with: the Taiwanese "AI 代理人" is
 *   the author's own word and must survive.
 */
export function restore(text, table, { postFix = true } = {}) {
  let out = unmask(text, table);
  if (postFix) {
    out = out
      .replace(/代理(?=提供|设置|框架|工作|服务|工具|能力|运行)/g, '智能体')
      .replace(/(?:人工智能|AI)\s*代理[商人]?/g, 'AI 智能体')
      // "lint" is also fluff; the engine renders "linter" as 短绒 (lint fibre).
      .replace(/短绒(?:检查器|工具)?/g, '代码检查器')
      .replace(/([A-Za-z0-9])-(?=[\u3400-\u9fff])/g, '$1 ')
      .replace(/([\u3400-\u9fff])-(?=[A-Za-z0-9])/g, '$1 ');
  }
  return out.trim();
}

// ---------------------------------------------------------------------------
// Engine

/**
 * Normalise one engine response to `[{text, lang}]`.
 *   sl=en    -> ["译文", ...]
 *   sl=auto  -> [["译文", "ko"], ...]          (also for a single q)
 *   legacy   -> {trans: "译文"} / "译文"
 */
export function parseResponse(parsed, expected) {
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  if (arr.length !== expected) throw new Error(`expected ${expected} results, got ${arr.length}`);
  return arr.map((x) => {
    if (typeof x === 'string') return { text: x, lang: null };
    if (Array.isArray(x)) return { text: typeof x[0] === 'string' ? x[0] : '', lang: typeof x[1] === 'string' ? x[1] : null };
    return { text: typeof x?.trans === 'string' ? x.trans : '', lang: typeof x?.src === 'string' ? x.src : null };
  });
}

export async function requestBatch(list, { sl = 'en', timeoutMs = 30000, tries = 5 } = {}) {
  const params = list.map((t) => 'q=' + encodeURIComponent(t)).join('&');
  const url = `${ENDPOINT}?client=dict-chrome-ex&sl=${sl}&tl=zh-CN&${params}`;
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: '*/*' } });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 120)}`);
      return parseResponse(JSON.parse(body), list.length);
    } catch (e) {
      lastErr = e;
      await new Promise((s) => setTimeout(s, Math.min(15000, 500 * 2 ** i) + Math.random() * 250));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Translator

/** Bumped whenever the meaning of a cache entry changes; older files are ignored. */
const CACHE_VERSION = 2;

export class Translator {
  constructor(opts = {}) {
    this.batchSize = opts.batchSize ?? 30;
    this.concurrency = opts.concurrency ?? 4;
    this.glossary = opts.glossary !== false;
    this.cachePath = opts.cachePath ?? null;
    this.request = opts.request ?? requestBatch;
    this.cache = new Map();
    this.used = new Set();
    this.stats = {
      hit: 0,
      miss: 0,
      chars: 0,
      requests: 0,
      failed: 0,
      routes: { en: 0, auto: 0, han: 0 },
      detectedEnglish: 0,
      secondChance: 0,
    };
    if (this.cachePath) this.loadCache();
  }

  loadCache() {
    try {
      if (!fs.existsSync(this.cachePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      // A file from an older layout holds restored text under different keys.
      // Reading it would serve stale output, so it is dropped wholesale.
      if (raw?.version !== CACHE_VERSION || typeof raw.entries !== 'object') return;
      for (const [k, v] of Object.entries(raw.entries)) this.cache.set(k, v);
    } catch {
      /* a corrupt cache is not fatal — it just means re-translating */
    }
  }

  /**
   * @param {{prune?: boolean}} opts  keep only the entries this run used. Only
   *   safe after a run over the FULL dataset; otherwise it throws away work.
   */
  saveCache({ prune = false } = {}) {
    if (!this.cachePath) return;
    const entries = {};
    for (const [k, v] of this.cache) if (!prune || this.used.has(k)) entries[k] = v;
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    const tmp = `${this.cachePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, entries }), 'utf8');
    fs.renameSync(tmp, this.cachePath);
  }

  /**
   * Cache key = request mode + the exact masked string sent to the engine.
   * Anything that changes what is sent (glossary, protection rules, brand
   * tokens) changes the key; anything applied afterwards (unmask, restore)
   * does not, and so takes effect on cached entries immediately.
   */
  static key(mode, masked) {
    return crypto.createHash('sha1').update(`${mode}\u0000${masked}`).digest('hex');
  }

  lookup(mode, masked) {
    const k = Translator.key(mode, masked);
    if (!this.cache.has(k)) return undefined;
    this.used.add(k);
    return this.cache.get(k);
  }

  /** Merge jobs by text (a shared title protects the union of brand tokens). */
  plan(jobs) {
    const byText = new Map();
    for (const job of jobs) {
      if (typeof job?.text !== 'string' || !job.text.trim()) continue;
      const prev = byText.get(job.text);
      if (prev) for (const t of job.extra ?? []) prev.add(t);
      else byText.set(job.text, new Set(job.extra ?? []));
    }
    return [...byText].map(([text, extra]) => ({ text, extra, route: classify(text) }));
  }

  enInput(item) {
    // An 'auto' candidate the engine called English still carries foreign
    // words ("…NaverPay, 가상계좌 via Toss"); sl=en would corrupt them, so they
    // are passed through verbatim.
    item.en ??= prepare(item.text, { glossary: this.glossary, extra: item.extra, keepForeign: item.route === 'auto' });
    return item.en;
  }

  autoInput(item) {
    item.auto ??= prepare(item.text, { glossary: false, extra: item.extra });
    return item.auto;
  }

  autoResult(item) {
    const v = this.lookup('auto', this.autoInput(item).masked);
    return Array.isArray(v) ? { raw: v[0], lang: v[1] || null } : null;
  }

  /** English path produced no Chinese at all, yet the source reads as prose. */
  wantsSecondChance(item) {
    const v = this.lookup('en', this.enInput(item).masked);
    if (typeof v !== 'string') return false;
    return !CJK.test(restore(v, this.enInput(item).table, { postFix: this.glossary })) && proseWords(item.text) >= 2;
  }

  /** Send every uncached input for one mode. Results are stored raw. */
  async fetchMode(mode, inputs, { onProgress } = {}) {
    const pending = [];
    const seen = new Set();
    for (const m of inputs) {
      if (seen.has(m)) continue;
      seen.add(m);
      const k = Translator.key(mode, m);
      if (this.cache.has(k)) {
        this.used.add(k);
        this.stats.hit += 1;
      } else {
        this.stats.miss += 1;
        pending.push(m);
      }
    }
    if (!pending.length) return;

    const sl = mode === 'auto' ? 'auto' : 'en';
    const batches = [];
    for (let i = 0; i < pending.length; i += this.batchSize) batches.push(pending.slice(i, i + this.batchSize));

    let done = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < batches.length) {
        const batch = batches[cursor];
        cursor += 1;
        let out;
        try {
          out = await this.request(batch, { sl });
        } catch {
          // Fall back to one-by-one so a single bad string cannot poison the batch.
          out = [];
          for (const m of batch) {
            try {
              out.push((await this.request([m], { sl }))[0]);
            } catch (e2) {
              this.stats.failed += 1;
              process.stderr.write(`    failed ${JSON.stringify(m.slice(0, 50))}: ${e2.message}\n`);
              out.push(null);
            }
          }
        }
        this.stats.requests += 1;
        batch.forEach((m, i) => {
          const r = out[i];
          this.stats.chars += m.length;
          // An empty answer is not cached: next run asks again.
          if (!r || typeof r.text !== 'string' || !r.text.trim()) return;
          const k = Translator.key(mode, m);
          this.cache.set(k, mode === 'auto' ? [r.text, r.lang ?? ''] : r.text);
          this.used.add(k);
        });
        done += batch.length;
        if (onProgress) onProgress({ mode, done, total: pending.length, cacheSize: this.cache.size });
        if (this.cachePath && this.cache.size % 5000 < this.batchSize) this.saveCache();
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, batches.length) }, worker));
  }

  /**
   * @param {{text: string, extra?: Set<string>}[]} jobs
   * @param {{onProgress?: Function, prune?: boolean}} opts
   * @returns {Promise<Map<string,string>>} original text -> Chinese
   */
  async translateJobs(jobs, { onProgress, prune = false } = {}) {
    const items = this.plan(jobs);
    for (const item of items) this.stats.routes[item.route] += 1;

    // 1) Non-English text is detected and translated by the engine itself.
    await this.fetchMode('auto', items.filter((i) => i.route !== 'en').map((i) => this.autoInput(i).masked), { onProgress });

    // 2) English — plus 'auto' candidates the engine says are English after all
    //    (mixed text such as "Pokédex" or a Korean brand in an English sentence).
    const english = items.filter((i) => i.route === 'en' || (i.route === 'auto' && this.autoResult(i)?.lang === 'en'));
    this.stats.detectedEnglish = english.filter((i) => i.route === 'auto').length;
    await this.fetchMode('en', english.map((i) => this.enInput(i).masked), { onProgress });

    // 3) Second chance for ASCII-only foreign prose ("RadioMatic: achtergrondmuziek
    //    voor bedrijven") that sl=en passed through without a single Chinese word.
    const retry = items.filter((i) => i.route === 'en' && this.wantsSecondChance(i));
    this.stats.secondChance = retry.length;
    await this.fetchMode('auto', retry.map((i) => this.autoInput(i).masked), { onProgress });

    if (this.cachePath) this.saveCache({ prune });
    return this.resolveItems(items);
  }

  /** Cache-only resolution, exactly as translateJobs() resolves. No network. */
  resolveJobs(jobs) {
    return this.resolveItems(this.plan(jobs));
  }

  resolveItems(items) {
    const result = new Map();
    for (const item of items) {
      const zh = this.resolve(item);
      if (zh) result.set(item.text, zh);
    }
    return result;
  }

  resolve(item) {
    if (item.route !== 'en') {
      const a = this.autoResult(item);
      // Never fall back to sl=en for non-English text: it corrupts it. Showing
      // the original is strictly better than showing the damage.
      if (!a) return null;
      if (a.lang === 'zh-CN' || a.lang === 'zh') return item.text;
      if (!(a.lang === 'en' && item.route === 'auto')) {
        const zh = restore(a.raw, this.autoInput(item).table, { postFix: item.route !== 'han' });
        // Traditional -> Simplified keeps every character. If Chinese text lost
        // some on the way, keep the author's own words instead.
        if (item.route === 'han' && count(zh, /[\u3400-\u9fff\uf900-\ufaff]/g) < 0.9 * count(item.text, /[\u3400-\u9fff\uf900-\ufaff]/g)) {
          return item.text;
        }
        return zh || null;
      }
    }

    const v = this.lookup('en', this.enInput(item).masked);
    if (typeof v !== 'string') return null;
    const zh = restore(v, this.enInput(item).table, { postFix: this.glossary });
    if (item.route === 'en' && !CJK.test(zh) && proseWords(item.text) >= 2) {
      const a = this.autoResult(item);
      if (a && LATIN_LANGS.has(a.lang)) {
        const alt = restore(a.raw, this.autoInput(item).table);
        if (CJK.test(alt)) return alt;
      }
    }
    return zh || null;
  }

  /** Convenience wrapper for plain string lists (no per-record brand tokens). */
  async translateAll(texts, opts) {
    return this.translateJobs([...new Set(texts)].map((text) => ({ text })), opts);
  }
}

export { nameTokens };
