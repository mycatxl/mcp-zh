/**
 * Registry client: walks the official cursor chain and de-duplicates `latest`
 * records. Mirrors the host's own pagination exactly (limit=100, nextCursor),
 * and retries because the live endpoint intermittently returns 5xx.
 */

const BASE = 'https://registry.modelcontextprotocol.io/v0/servers';

export async function getJson(url, { tries = 6, timeoutMs = 30000, quiet = false } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: { Accept: 'application/json, text/plain;q=0.9' },
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      const wait = Math.min(20000, 400 * 2 ** i);
      if (!quiet) process.stderr.write(`    retry ${i + 1}/${tries} in ${wait}ms (${e.message})\n`);
      await new Promise((s) => setTimeout(s, wait));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * Walk the whole registry.
 * @param {{limit?: number, maxPages?: number, onBatch?: Function, onProgress?: Function, resumeFrom?: string}} opts
 */
export async function fetchAll({ limit = 100, maxPages = Infinity, onBatch, onProgress, resumeFrom } = {}) {
  const seen = new Set();
  let cursor = resumeFrom;
  let page = 0;
  let total = 0;

  while (page < maxPages) {
    const params = new URLSearchParams({ version: 'latest', limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    const body = await getJson(`${BASE}?${params}`);
    const servers = Array.isArray(body.servers) ? body.servers : [];

    page += 1;
    const fresh = [];
    for (const rec of servers) {
      const name = rec?.server?.name;
      if (typeof name !== 'string' || !name || seen.has(name)) continue;
      seen.add(name);
      fresh.push(rec);
    }
    total += fresh.length;
    if (fresh.length && onBatch) onBatch(fresh, page);

    const next = body.metadata?.nextCursor ?? null;
    if (onProgress) onProgress({ page, total, inPage: servers.length, next });
    if (!next || next === cursor) break;
    cursor = next;
  }

  return { page, total };
}

export { BASE };
