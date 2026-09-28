/**
 * Batch translator for registry titles and descriptions.
 *
 * Uses the free Google web endpoint (clients5 dict-chrome-ex), which accepts many
 * `q=` parameters in ONE request and returns a JSON array — measured ~120 new
 * strings/s on real registry data, so all 36k entries finish in minutes at zero cost.
 *
 * Three quality controls, each verified experimentally against the live endpoint:
 *
 *  1. Marker protection. `[[A1]]` survives translation untouched, so tokens that
 *     must stay verbatim can be hidden and restored. Bare tokens get mangled:
 *     "Getlead" -> "格利德", "JustIdea" -> "正意", "hood" -> "兜帽".
 *  2. Per-record brand tokens (derived from the registry name) are protected too,
 *     so "Propick Integration MCP" keeps its brand while "Business Contact Finder"
 *     still translates — generic vocabulary is excluded via GENERIC_WORDS.
 *  3. Glossary pre-substitution. Writing the Chinese term inline ("coding 智能体")
 *     makes the engine emit it verbatim, fixing "agent" -> "代理" (proxy) and
 *     "integration" -> "积分" (a math integral).
 *
 * Three bugs found the hard way; do not "simplify" them away:
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
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nameTokens } from './glossary-words.js';

const ENDPOINT = 'https://clients5.google.com/translate_a/t';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

/** English -> Chinese terms the engine gets wrong or renders inconsistently. */
export const GLOSSARY = [
  [/\bagents?\b/gi, '智能体'],
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
];

/**
 * Case-sensitive patterns for tokens that must survive verbatim:
 *  - domains, with or without a leading label (".hood", "api.foo.com")
 *  - camelCase / PascalCase words with an internal capital ("JustIdea")
 *  - all-caps acronyms ("MCP", "API", "SDK")
 *  - mixed letter+digit tokens ("B2B", "GPT4") — but NOT bare numbers, so
 *    "50 states" still becomes "50 个州"
 */
const PROTECT_SOURCES = [
  '(?:[A-Za-z0-9_][A-Za-z0-9_.+-]*)?\\.[A-Za-z]{2,}',
  '\\b[A-Za-z][a-z]+[A-Z][A-Za-z0-9]*\\b',
  '\\b[A-Z]{2,}\\b',
  '\\b(?:[A-Za-z]+\\d[A-Za-z0-9]*|\\d+[A-Za-z][A-Za-z0-9]*)\\b',
];

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
  for (const [re, zh] of GLOSSARY) out = out.replace(re, zh);
  return out;
}

/**
 * Hide protected tokens behind `[[A<n>]]` markers — one pass, so markers are
 * never re-scanned.
 *
 * @param {string} text
 * @param {{extra?: Set<string>}} opts  literal brand tokens to protect
 * @returns {{masked: string, table: Map<string,string>}} table: original token -> marker
 */
export function mask(text, { extra } = {}) {
  const table = new Map();
  let n = 0;
  const put = (token) => {
    if (table.has(token)) return table.get(token);
    n += 1;
    const marker = `[[A${n}]]`;
    table.set(token, marker);
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
      alts.push(token.length >= 5 ? `\\b${cls}[A-Za-z0-9]*\\b` : `\\b${cls}\\b`);
    }
  }
  alts.push(...PROTECT_SOURCES);

  const combined = new RegExp(alts.join('|'), 'g');
  return { masked: text.replace(combined, (m) => put(m)), table };
}

/**
 * Restore markers.
 *  - tolerant of whitespace/case the engine introduces inside the brackets
 *  - re-inserts a space when the engine glues two markers together ("]][["),
 *    which would otherwise merge two separate tokens into one word
 */
export function unmask(text, table) {
  const byMarker = new Map([...table].map(([token, marker]) => [marker, token]));
  const out = String(text ?? '')
    .replace(/\[\[\s*A\s*(\d+)\s*\]\]/gi, (m, d) => byMarker.get(`[[A${d}]]`) ?? m)
    .replace(/\]\]\s*\[\[/g, ']] [[');
  // The engine pads markers with spaces; normalise CJK<->latin boundaries.
  return out
    .replace(/([\u3400-\u9fff])\s*([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])\s*([\u3400-\u9fff])/g, '$1 $2')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。、；：！？）】》])/g, '$1')
    .replace(/([（【《])\s+/g, '$1')
    .trim();
}

export function prepare(text, { glossary = true, extra } = {}) {
  const withGlossary = glossary ? applyGlossary(text) : text;
  return mask(withGlossary, { extra });
}

export function restore(text, table, { glossary = true } = {}) {
  let out = unmask(text, table);
  if (glossary) out = out.replace(/代理(?=提供|设置|框架|工作|服务|工具|能力|运行)/g, '智能体');
  return out.trim();
}

export async function requestBatch(list, { timeoutMs = 30000, tries = 5 } = {}) {
  const params = list.map((t) => 'q=' + encodeURIComponent(t)).join('&');
  const url = `${ENDPOINT}?client=dict-chrome-ex&sl=en&tl=zh-CN&${params}`;
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: '*/*' } });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 120)}`);
      const parsed = JSON.parse(body);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      if (arr.length !== list.length) throw new Error(`expected ${list.length} results, got ${arr.length}`);
      return arr.map((x) => (typeof x === 'string' ? x : (x?.trans ?? '')));
    } catch (e) {
      lastErr = e;
      await new Promise((s) => setTimeout(s, Math.min(15000, 500 * 2 ** i) + Math.random() * 250));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export class Translator {
  constructor(opts = {}) {
    this.batchSize = opts.batchSize ?? 30;
    this.concurrency = opts.concurrency ?? 4;
    this.glossary = opts.glossary !== false;
    this.cachePath = opts.cachePath ?? null;
    this.cache = new Map();
    this.stats = { hit: 0, miss: 0, chars: 0, requests: 0, failed: 0 };
    if (this.cachePath) this.loadCache();
  }

  loadCache() {
    try {
      if (fs.existsSync(this.cachePath)) {
        const raw = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
        for (const [k, v] of Object.entries(raw)) this.cache.set(k, v);
      }
    } catch {
      /* a corrupt cache is not fatal — it just means re-translating */
    }
  }

  saveCache() {
    if (!this.cachePath) return;
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    const tmp = `${this.cachePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.cache)), 'utf8');
    fs.renameSync(tmp, this.cachePath);
  }

  /**
   * Cache key = source text + protected tokens + glossary flag.
   * The extras matter: "hood" must not reuse a result produced when nothing
   * protected it — that one came back as "兜帽" (a literal hood).
   */
  static key(text, glossary, extra) {
    const extras = extra && extra.size ? [...extra].sort().join('\u0001') : '';
    return crypto
      .createHash('sha1')
      .update(`${glossary ? 'g1' : 'g0'}\u0000${extras}\u0000${text}`)
      .digest('hex');
  }

  /**
   * @param {{text: string, extra?: Set<string>}[]} jobs
   * @returns {Promise<Map<string,string>>} original text -> Chinese
   */
  async translateJobs(jobs, { onProgress } = {}) {
    const byText = new Map();
    for (const job of jobs) {
      if (typeof job?.text !== 'string' || !job.text.trim()) continue;
      const prev = byText.get(job.text);
      if (prev) {
        for (const t of job.extra ?? []) prev.add(t);
      } else {
        byText.set(job.text, new Set(job.extra ?? []));
      }
    }

    const pending = [];
    for (const [text, extra] of byText) {
      if (this.cache.has(Translator.key(text, this.glossary, extra))) this.stats.hit += 1;
      else {
        this.stats.miss += 1;
        pending.push([text, extra]);
      }
    }

    const batches = [];
    for (let i = 0; i < pending.length; i += this.batchSize) batches.push(pending.slice(i, i + this.batchSize));

    let done = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < batches.length) {
        const mine = cursor;
        cursor += 1;
        const batch = batches[mine];
        const prepared = batch.map(([text, extra]) => prepare(text, { glossary: this.glossary, extra }));
        let out;
        try {
          out = await requestBatch(prepared.map((p) => p.masked));
        } catch {
          // Fall back to one-by-one so a single bad string cannot poison the batch.
          out = [];
          for (const p of prepared) {
            try {
              out.push((await requestBatch([p.masked]))[0]);
            } catch (e2) {
              this.stats.failed += 1;
              process.stderr.write(`    failed ${JSON.stringify(p.masked.slice(0, 50))}: ${e2.message}\n`);
              out.push('');
            }
          }
        }
        this.stats.requests += 1;
        batch.forEach(([original, extra], i) => {
          const zh = restore(out[i] ?? '', prepared[i].table, { glossary: this.glossary });
          if (zh) this.cache.set(Translator.key(original, this.glossary, extra), zh);
          this.stats.chars += original.length;
        });
        done += batch.length;
        if (onProgress) onProgress({ done, total: pending.length, cacheSize: this.cache.size });
        if (this.cachePath && this.cache.size % 5000 < this.batchSize) this.saveCache();
      }
    };

    await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(1, batches.length)) }, worker));
    if (this.cachePath) this.saveCache();

    const result = new Map();
    for (const [text, extra] of byText) {
      const k = Translator.key(text, this.glossary, extra);
      if (this.cache.has(k)) result.set(text, this.cache.get(k));
    }
    return result;
  }

  /** Convenience wrapper for plain string lists (no per-record brand tokens). */
  async translateAll(texts, opts) {
    return this.translateJobs([...new Set(texts)].map((text) => ({ text })), opts);
  }
}

export { nameTokens };
