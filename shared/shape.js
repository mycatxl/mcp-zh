/**
 * Builds the `server` object we serve, shaped exactly like an official
 * registry record so PI-Desktop's `mapRegistryServer()` maps it unchanged.
 *
 * Two hard constraints discovered by reading app.asar, both handled here:
 *
 * 1) ID COLLISION. The client derives an entry id from `server.name`
 *    (`registryIdFromName`) and merges sources with "first source wins". The
 *    official source is force-prepended by `sanitizeMarketSources()`, so an entry
 *    whose id matches an official one is silently discarded.
 *
 *    The obvious fix — suffixing the name — DOES NOT WORK: `registryIdFromName`
 *    truncates the slug to 60 characters, so on a long registry name the suffix
 *    is cut off entirely and the id collapses back onto the official one.
 *    Measured against the real dataset with the host's own function:
 *
 *        name + "/zh/<category>"   158 records collide  (silently dropped)
 *        "zh-<category>/" + name     0 records collide
 *
 *    So the marker goes at the FRONT, where truncation cannot reach it. Nothing
 *    is lost visually: `mapRegistryServer()` shows `server.title` and only falls
 *    back to the last path segment of the name when there is no title, and every
 *    record we serve has a translated title.
 *
 * 2) CATEGORY DRIFT. `guessCategory()` keyword-matches English text against
 *    name + title + description. Serving Chinese there collapses almost
 *    everything into "devtools" (measured: 80 -> 93 of 100). The category is
 *    computed from the ORIGINAL English record and its keyword is parked in the
 *    name, which the UI never displays, so the client's own scan lands on the
 *    category we intended.
 *
 *    `generator/check-served.js` re-runs the host's real guessCategory() over the
 *    served records and reports any record whose category still drifts — that can
 *    happen when the Chinese translation itself contains an English technical
 *    term belonging to an earlier category in the scan order.
 */

const CATEGORY_KEYWORDS = [
  ['data', ['database', 'sql', 'postgres', 'mysql', 'mongo', 'redis', 'sqlite', 'dataset', 'warehouse', 'analytics', 'supabase', 'snowflake']],
  ['productivity', ['todo', 'task', 'calendar', 'email', 'mail', 'remind', 'schedule', 'slack', 'notion', 'jira', 'linear', 'asana', 'habit', 'time']],
  ['web', ['search', 'scrape', 'crawl', 'browser', 'fetch', 'playwright', 'puppeteer', 'seo', 'web', 'surf']],
  ['devtools', ['github', 'gitlab', 'git ', 'docker', 'kubernetes', 'k8s', 'deploy', 'terminal', 'shell', 'code', 'repo', 'issue', 'build', 'lint', 'test', 'ci ', 'ide', 'api', 'sentry', ' observability']],
  ['docs', ['doc', 'wiki', 'knowledge', 'context', 'reference', 'manual', 'library', 'framework', 'changelog', 'arxiv', 'paper']],
];

export const CATEGORIES = ['data', 'productivity', 'web', 'devtools', 'docs'];

/**
 * Chosen so that the token matches its own category's keyword list and nothing
 * earlier in the scan order (data -> productivity -> web -> devtools -> docs).
 */
const CATEGORY_HINT = {
  data: 'database',
  productivity: 'task',
  web: 'web',
  devtools: 'api',
  docs: 'docs',
};

/** Marker that keeps our ids distinct from the official ones. Must stay first. */
export const ZH_PREFIX = 'zh';

/** Mirrors the host's own guessCategory() so our category matches what the UI shows. */
export function guessCategory(server) {
  const haystack = `${server?.name ?? ''} ${server?.title ?? ''} ${server?.description ?? ''}`.toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(keyword))) return category;
  }
  return 'devtools';
}

/** Mirrors the host's registryIdFromName(), used for collision checks and ordering. */
export function registryIdFromName(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .split('/')
    .map((part) => part.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean)
    .join('-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!slug) return 'mcp-server';
  return /^[a-z]/.test(slug) ? slug : `mcp-${slug}`.slice(0, 64);
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

/**
 * A fast, approximate pre-filter: does this record have anything installable at
 * all? Mirrors the host's npm -> pypi -> streamable-http priority.
 *
 * This is only a cheap screen for reporting. The authoritative check is the
 * host's own `mapRegistryServer()` (see generator/lib/host-mapper.generated.js),
 * which the generator runs over the SERVED record — that also catches traps this
 * cannot, such as an env placeholder the client considers undeclared.
 *
 * @returns {{ok: boolean, transport?: string, reason?: string}}
 */
export function installability(server) {
  const packages = Array.isArray(server?.packages) ? server.packages : [];
  const npm = packages.find(
    (p) => String(p?.registryType ?? '').toLowerCase() === 'npm' && typeof p?.identifier === 'string' && !!p.identifier.trim(),
  );
  if (npm) return { ok: true, transport: 'stdio' };
  const pypi = packages.find(
    (p) => String(p?.registryType ?? '').toLowerCase() === 'pypi' && typeof p?.identifier === 'string' && !!p.identifier.trim(),
  );
  if (pypi) return { ok: true, transport: 'stdio' };
  const remotes = Array.isArray(server?.remotes) ? server.remotes : [];
  const remote = remotes.find(
    (r) => String(r?.type ?? '').toLowerCase() === 'streamable-http' && isPublicHttpsUrl(r?.url ?? ''),
  );
  if (remote) return { ok: true, transport: 'http' };
  if (remotes.some((r) => String(r?.type ?? '').toLowerCase() === 'streamable-http')) {
    return { ok: false, reason: 'remote url is not a public https address' };
  }
  return { ok: false, reason: 'no npm/pypi package and no streamable-http remote' };
}

/** Display name the client will show: title wins, else the last path segment. */
export function displayName(server) {
  const title = typeof server?.title === 'string' ? server.title.trim() : '';
  if (title) return title;
  const name = String(server?.name ?? '');
  return name.split('/').pop() || name;
}

/**
 * @param {object} record  a raw registry record: { server, _meta }
 * @param {{titleZh?: string, descZh?: string}} zh  translated fields
 * @returns {{served: object, meta: object, id: string, category: string, sourceName: string}}
 */
export function buildServedRecord(record, zh = {}) {
  const src = record?.server ?? {};
  const sourceName = String(src.name ?? '');
  // Category is computed from the ORIGINAL English text, then preserved via the
  // hint parked at the front of the name.
  const category = guessCategory(src);
  const hint = CATEGORY_HINT[category] ?? 'api';

  const titleZh = typeof zh.titleZh === 'string' ? zh.titleZh.trim() : '';
  const descZh = typeof zh.descZh === 'string' ? zh.descZh.trim() : '';

  const served = {
    ...src,
    // "<zh>/<hint>/<original>" -> the derived id starts with "zh-<hint>-", which
    // no truncation can remove. See the file header for the measurement.
    name: `${ZH_PREFIX}/${hint}/${sourceName}`,
    title: titleZh || (typeof src.title === 'string' ? src.title.trim() : '') || displayName(src),
    description: descZh || src.description,
  };

  const id = registryIdFromName(served.name);
  const meta = {
    ...(record?._meta ?? {}),
    'io.modelcontextprotocol.registry/official': {
      ...(record?._meta?.['io.modelcontextprotocol.registry/official'] ?? {}),
      isLatest: true,
    },
  };

  return { served, meta, id, category, sourceName };
}
