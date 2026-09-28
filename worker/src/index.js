/**
 * A Chinese-translated mirror of the official MCP registry, served through the
 * SAME paginated protocol as the official endpoint, so PI-Desktop's MCP market
 * can consume it as an ordinary custom source with no client changes.
 *
 * Endpoint contract (mirrors https://registry.modelcontextprotocol.io/v0/servers):
 *
 *   GET /servers?version=latest&limit=100[&cursor=<n>][&search=<q>]
 *   -> { servers: [{ server, _meta }], metadata: { count, nextCursor } }
 *
 * Verified against app.asar:
 *  - the host appends exactly `version`, `limit`, optional `cursor` / `search`
 *  - it stops paging when `metadata.nextCursor` is missing or unchanged
 *  - it maps our records itself via mapRegistryServer(), so we only need to
 *    return official-shaped records with Chinese `title` / `description`
 *  - a per-response cap of 4 MB and an 8 s timeout apply; we serve 100 records
 *    (~92 KB) at a time, so there is ~46x headroom
 */

import { toMatch, needsLikeFallback, likePattern } from '../../shared/fold.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_QUERY_LENGTH = 200;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
    },
  });
}

function parseIntParam(value, fallback, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/** Cursor is an opaque row id; the client only echoes it back verbatim. */
function parseCursor(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function browse(db, { limit, cursor }) {
  const { results } = await db
    .prepare('SELECT id, json FROM servers WHERE id > ?1 ORDER BY id LIMIT ?2')
    .bind(cursor, limit)
    .all();
  return results ?? [];
}

/**
 * Single CJK character: too short to be a bigram phrase, so scan with LIKE.
 *
 * NOTE the parameter style: every placeholder is explicitly numbered. Mixing
 * bare `?` with `?1` is a trap — SQLite assigns a bare `?` the next free index,
 * so `WHERE id > ? AND title LIKE ?1` binds `?1` to the *cursor* rather than the
 * pattern, and the query silently matches nothing.
 */
async function searchLike(db, { limit, cursor, query }) {
  const pattern = likePattern(query);
  const { results } = await db
    .prepare(
      `SELECT id, json FROM servers
       WHERE id > ?1 AND (lower(title) LIKE ?2 ESCAPE '\\' OR lower(description) LIKE ?2 ESCAPE '\\')
       ORDER BY id LIMIT ?3`,
    )
    .bind(cursor, pattern, limit)
    .all();
  return results ?? [];
}

async function searchFts(db, { limit, cursor, match }) {
  const { results } = await db
    .prepare(
      `SELECT s.id AS id, s.json AS json
       FROM search f JOIN servers s ON s.id = f.rowid
       WHERE search MATCH ?1 AND s.id > ?2
       ORDER BY s.id LIMIT ?3`,
    )
    .bind(match, cursor, limit)
    .all();
  return results ?? [];
}

async function handleServers(url, env) {
  const params = url.searchParams;
  const limit = parseIntParam(params.get('limit'), DEFAULT_LIMIT, MAX_LIMIT);
  const cursor = parseCursor(params.get('cursor'));
  const query = String(params.get('search') ?? '').trim().slice(0, MAX_QUERY_LENGTH);

  let rows;
  if (!query) {
    rows = await browse(env.DB, { limit, cursor });
  } else if (needsLikeFallback(query)) {
    rows = await searchLike(env.DB, { limit, cursor, query });
  } else {
    const match = toMatch(query);
    rows = match ? await searchFts(env.DB, { limit, cursor, match }) : await browse(env.DB, { limit, cursor });
  }

  const servers = [];
  for (const row of rows) {
    try {
      servers.push(JSON.parse(row.json));
    } catch {
      continue; // a corrupt row must not break the whole page
    }
  }

  // Only advertise a next page when this one was actually full.
  const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;

  return json({
    servers,
    metadata: { count: servers.length, nextCursor },
  });
}

async function handleHealth(env) {
  const [count, sample] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS n FROM servers').first(),
    env.DB.prepare('SELECT id, json FROM servers ORDER BY id LIMIT 1').first(),
  ]);
  let first = null;
  try {
    first = sample?.json ? (JSON.parse(sample.json)?.server?.name ?? null) : null;
  } catch {
    first = null;
  }
  return json({
    ok: true,
    entries: count?.n ?? 0,
    first,
    protocol: 'registry',
    endpoint: '/servers',
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': 'GET,OPTIONS',
        },
      });
    }
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);

    try {
      if (path === '/servers' || path === '/v0/servers') return await handleServers(url, env);
      if (path === '/health') return await handleHealth(env);
      if (path === '/') {
        return json({
          name: 'MCP 中文源',
          kind: 'registry',
          endpoint: `${url.origin}/servers`,
          usage: 'MCP 市场 → 源管理 → 添加源，类型选 registry，URL 填上面的 endpoint',
        });
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e?.message ?? e) }, 500);
    }
  },
};
