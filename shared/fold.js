/**
 * CJK-safe search folding — the single source of truth, used by both the
 * generator (index building) and the Worker (query building). Both sides MUST
 * tokenise identically or searches silently miss.
 *
 * Why this exists: Chinese has no word separators, so FTS5's unicode61 tokenizer
 * would treat a whole sentence as one token and substring search would never
 * match. Folding CJK runs into overlapping bigrams turns "exact substring"
 * search into ordinary token matching, and a *quoted* bigram sequence becomes an
 * FTS5 phrase query — which is exactly substring semantics.
 *
 * Verified against SQLite: 数据 (2 chars), 数据库, 智能体, 文档安装, MCP 文档 all hit.
 *
 * Latin runs are split on punctuation so "@scope/pkg" indexes as two tokens, and
 * prefix queries still work ("postgres" matches "PostgreSQL").
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const RUNS = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+|[A-Za-z0-9_@./+#-]+/g;

export function runs(text) {
  return String(text ?? '').match(RUNS) ?? [];
}

export function isCjk(text) {
  return CJK.test(text);
}

/** Overlapping bigrams for a CJK run; a lone character stays itself. */
export function grams(run) {
  if (run.length === 1) return [run];
  const out = [];
  for (let i = 0; i + 2 <= run.length; i += 1) out.push(run.slice(i, i + 2));
  return out;
}

/** Split a latin run on punctuation, keeping alphanumeric sub-tokens. */
export function splitLatin(run) {
  return String(run)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Index form: CJK -> bigrams, latin -> lowercased sub-tokens. */
export function fold(text) {
  const out = [];
  for (const run of runs(text)) {
    if (isCjk(run)) out.push(...grams(run));
    else out.push(...splitLatin(run));
  }
  return out.join(' ');
}

/**
 * Query form -> FTS5 MATCH expression.
 * CJK runs become quoted bigram phrases (substring semantics);
 * latin sub-tokens become prefix terms.
 */
export function toMatch(query) {
  const clauses = [];
  for (const run of runs(query)) {
    if (isCjk(run)) {
      clauses.push(`"${grams(run).join(' ')}"`);
    } else {
      for (const token of splitLatin(run)) clauses.push(`"${token}"*`);
    }
  }
  return clauses.join(' AND ');
}

/**
 * True when the query is a single CJK character: it cannot be expressed as a
 * bigram phrase, so the caller must fall back to a LIKE scan.
 */
export function needsLikeFallback(query) {
  const r = runs(query);
  return r.length === 1 && isCjk(r[0]) && r[0].length === 1;
}

/** Escape a user string for use inside a LIKE pattern. */
export function likePattern(query) {
  return `%${String(query ?? '').trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Literal-substring test, mirroring the client's own local result filter. */
export function literalMatch(haystacks, query) {
  const q = String(query ?? '').trim().toLocaleLowerCase();
  if (!q) return true;
  return haystacks.some((h) => typeof h === 'string' && h.toLocaleLowerCase().includes(q));
}
