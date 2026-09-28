/**
 * Builds the `server` object we serve, shaped exactly like an official
 * registry record so PI-Desktop's `mapRegistryServer()` maps it unchanged.
 *
 * Two hard constraints discovered by reading app.asar, both handled here:
 *
 * 1) ID COLLISION. The client derives an entry id from `server.name`
 *    (`registryIdFromName`) and merges sources with "first source wins".
 *    The official source is force-prepended by `sanitizeMarketSources()`, so an
 *    entry whose id matches an official one is silently discarded. We therefore
 *    suffix the name, which changes the derived id (`...-zh-<cat>`) and keeps the
 *    Chinese entry alive as a separate, installable card.
 *
 * 2) CATEGORY DRIFT. `guessCategory()` keyword-matches English text against
 *    name + title + description. Serving Chinese there collapses almost
 *    everything into "devtools" (measured: 80 -> 93 of 100). `name` is the one
 *    field the UI never displays when a title is present, so we park an English
 *    category keyword there and keep the real category intact.
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
 * Would the host's mapRegistryServer() accept this record?
 * Priority mirrors the host exactly: npm -> pypi -> streamable-http remote.
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
  // Category is computed from the ORIGINAL English text, then preserved via the name hint.
  const category = guessCategory(src);
  const hint = CATEGORY_HINT[category] ?? 'api';

  const titleZh = typeof zh.titleZh === 'string' ? zh.titleZh.trim() : '';
  const descZh = typeof zh.descZh === 'string' ? zh.descZh.trim() : '';

  const served = {
    ...src,
    name: `${sourceName}/zh/${hint}`,
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

/** Text blobs that go into the search index for one served record. */
export function indexText(served, category) {
  const original = served.name.replace(/\/zh\/[a-z]+$/, '');
  return {
    servedName: served.name,
    titleZh: served.title ?? '',
    descZh: served.description ?? '',
    originalName: original,
    category: category ?? '',
  };
}
