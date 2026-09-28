/**
 * End-to-end HTTP test against a running Worker.
 *
 * Reproduces exactly what PI-Desktop's MCP market client does:
 *   - GET /servers?version=latest&limit=100           (browse, then follow nextCursor)
 *   - GET /servers?version=latest&search=<q>&limit=100 (server-side search)
 * and asserts the response contract the host depends on.
 *
 * The acceptance checks run the host's OWN extracted functions
 * (generator/lib/host-mapper.generated.js), so "the client would show this"
 * is decided by the client's code, not by a reimplementation of it.
 *
 *   node test/e2e.js [--base=http://127.0.0.1:8788] [--pages=6]
 */
import { mapRegistryServer } from '../generator/lib/host-mapper.generated.js';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const BASE = arg('base', 'http://127.0.0.1:8788');
const LIMIT = 100;
const MAX_PAGES = Number(arg('pages', '6'));
const MAX_SOURCE_RESPONSE_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 8000;

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

async function get(url) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json, text/plain;q=0.9' } });
    const text = await res.text();
    return { status: res.status, text, bytes: Buffer.byteLength(text, 'utf8'), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/** The host filters hits again locally; a hit that fails this wastes a page slot. */
function passesLocalFilter(server, query) {
  const q = query.trim().toLocaleLowerCase();
  return [server?.title, server?.description, server?.name]
    .filter(Boolean)
    .some((t) => t.toLocaleLowerCase().includes(q));
}

/** The host's real mapper, used as the acceptance test for every record. */
function clientEntry(record) {
  return mapRegistryServer(record);
}

async function main() {
  console.log('base:', BASE);
  console.log('');

  // ---- 1. health ---------------------------------------------------------
  console.log('1) health');
  const health = await get(`${BASE}/health`);
  check('GET /health is 200', health.status === 200, `${health.ms}ms`);
  let healthBody = null;
  try {
    healthBody = JSON.parse(health.text);
  } catch {
    /* reported below */
  }
  check('health reports entries', !!healthBody?.entries, `${healthBody?.entries} entries`);
  check('health reports protocol registry', healthBody?.protocol === 'registry');

  // ---- 2. browse ---------------------------------------------------------
  console.log('\n2) browse (what the market shows with an empty search box)');
  const p1 = await get(`${BASE}/servers?version=latest&limit=${LIMIT}`);
  check('status 200', p1.status === 200);
  check('response under 4 MB cap', p1.bytes < MAX_SOURCE_RESPONSE_BYTES, `${(p1.bytes / 1024).toFixed(1)} KB`);
  check('response within 8s timeout', p1.ms < TIMEOUT_MS, `${p1.ms}ms`);

  const b1 = JSON.parse(p1.text);
  check('has servers array', Array.isArray(b1.servers), `${b1.servers?.length} records`);
  check('has metadata.count', b1.metadata?.count === b1.servers.length, `count=${b1.metadata?.count}`);
  check('metadata.nextCursor present', !!b1.metadata?.nextCursor, `cursor=${b1.metadata?.nextCursor}`);

  const first = b1.servers[0];
  check('record shape {server,_meta}', !!first?.server && !!first?._meta);
  check('server.name present', typeof first?.server?.name === 'string', first?.server?.name);
  check('server.description is Chinese', /[\u4e00-\u9fff]/.test(first?.server?.description ?? ''));
  check('server.title present', !!first?.server?.title, first?.server?.title);
  check('name carries the zh marker', /^zh\//.test(first?.server?.name ?? ''), first?.server?.name);

  const firstEntry = clientEntry(first);
  check('first record is accepted by the host mapper', !!firstEntry, firstEntry ? `id=${firstEntry.id}` : 'host returned null');
  check('derived id starts with zh-', /^zh-/.test(firstEntry?.id ?? ''), firstEntry?.id);

  // ---- 3. pagination -----------------------------------------------------
  console.log('\n3) pagination (cursor walk)');
  const seen = new Set();
  const ids = [];
  let cursor = null;
  let pages = 0;
  let dupes = 0;
  let maxBytes = 0;
  let maxMs = 0;
  let unmappable = 0;
  const t0 = Date.now();
  while (pages < MAX_PAGES) {
    const url = cursor
      ? `${BASE}/servers?version=latest&limit=${LIMIT}&cursor=${encodeURIComponent(cursor)}`
      : `${BASE}/servers?version=latest&limit=${LIMIT}`;
    const r = await get(url);
    maxBytes = Math.max(maxBytes, r.bytes);
    maxMs = Math.max(maxMs, r.ms);
    if (r.status !== 200) {
      check(`page ${pages + 1} status 200`, false, String(r.status));
      break;
    }
    const body = JSON.parse(r.text);
    for (const rec of body.servers) {
      const entry = clientEntry(rec);
      if (!entry) {
        unmappable += 1;
        continue;
      }
      ids.push(entry.id);
      if (seen.has(entry.id)) dupes += 1;
      seen.add(entry.id);
    }
    pages += 1;
    cursor = body.metadata?.nextCursor;
    if (!cursor) break;
  }
  check('walked multiple pages', pages >= 2, `${pages} pages`);
  check('no duplicate ids across pages', dupes === 0, `${dupes} dupes`);
  check('all ids unique', new Set(ids).size === ids.length, `${new Set(ids).size}/${ids.length}`);
  check('every id matches host regex', ids.every((i) => /^[a-z][a-z0-9_-]{0,63}$/.test(i)));
  check('every id carries the zh prefix', ids.every((i) => i.startsWith('zh-')), `${ids.length} checked`);
  check('page size stays under cap', maxBytes < MAX_SOURCE_RESPONSE_BYTES, `max ${(maxBytes / 1024).toFixed(1)} KB`);
  check('slowest page under timeout', maxMs < TIMEOUT_MS, `max ${maxMs}ms`);
  check('browsed records are all installable', unmappable === 0, `${unmappable} unmappable`);
  console.log(`     (${pages} pages in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // ---- 4. search ---------------------------------------------------------
  console.log('\n4) server-side search');
  const queries = [
    '数据库', '智能体', '文档', '搜索', '翻译', '图像', '测试', '天气', '邮件', '支付',
    'github', 'postgres', 'slack', 'notion', 'stripe', 'docker',
  ];
  let searchFailures = 0;
  for (const q of queries) {
    const r = await get(`${BASE}/servers?version=latest&search=${encodeURIComponent(q)}&limit=20`);
    if (r.status !== 200) {
      check(`search "${q}"`, false, `status ${r.status}`);
      searchFailures += 1;
      continue;
    }
    const body = JSON.parse(r.text);
    const hits = body.servers ?? [];
    const literal = hits.every((rec) => passesLocalFilter(rec.server, q));
    const showable = hits.every((rec) => !!clientEntry(rec));
    const ok = hits.length > 0 && literal && showable;
    if (!ok) searchFailures += 1;
    check(`search "${q}"`, ok, `${hits.length} hits, ${r.ms}ms, localFilter=${literal}, showable=${showable}`);
  }

  // Single CJK character takes the LIKE path, not the FTS path.
  console.log('\n   single-character queries (LIKE path)');
  for (const q of ['库', '云', '码']) {
    const r = await get(`${BASE}/servers?version=latest&search=${encodeURIComponent(q)}&limit=10`);
    const body = JSON.parse(r.text);
    const hits = body.servers ?? [];
    const literal = hits.every((rec) => passesLocalFilter(rec.server, q));
    check(`single char "${q}"`, r.status === 200 && hits.length > 0 && literal, `${hits.length} hits`);
  }

  // A search that pages with a cursor must not repeat or skip rows.
  console.log('\n   search pagination');
  const searchSeen = new Set();
  let searchCursor = null;
  let searchPages = 0;
  let searchDupes = 0;
  while (searchPages < 4) {
    const url = searchCursor
      ? `${BASE}/servers?version=latest&search=${encodeURIComponent('数据')}&limit=50&cursor=${encodeURIComponent(searchCursor)}`
      : `${BASE}/servers?version=latest&search=${encodeURIComponent('数据')}&limit=50`;
    const r = await get(url);
    const body = JSON.parse(r.text);
    for (const rec of body.servers ?? []) {
      const entry = clientEntry(rec);
      const id = entry?.id ?? rec.server.name;
      if (searchSeen.has(id)) searchDupes += 1;
      searchSeen.add(id);
    }
    searchPages += 1;
    searchCursor = body.metadata?.nextCursor;
    if (!searchCursor) break;
  }
  check('search paging works', searchPages >= 2, `${searchPages} pages, ${searchSeen.size} hits`);
  check('search paging has no duplicates', searchDupes === 0, `${searchDupes} dupes`);

  const none = await get(`${BASE}/servers?version=latest&search=${encodeURIComponent('zzzqqqxxx不存在')}&limit=20`);
  check('nonsense query returns 0 hits', (JSON.parse(none.text).servers ?? []).length === 0);
  check('all search queries behaved', searchFailures === 0, `${searchFailures} failures`);

  // ---- 5. what the UI would render --------------------------------------
  console.log('\n5) sample of what the market card shows');
  const sample = JSON.parse((await get(`${BASE}/servers?version=latest&limit=10`)).text);
  for (const rec of sample.servers) {
    const s = rec.server;
    const t = clientEntry(rec);
    console.log(`   ${t ? '[' + t.transport.padEnd(5) + ']' : '[--]'} ${s.title}`);
    console.log(`            ${(s.description ?? '').slice(0, 84)}`);
  }

  console.log('\n--------------------------------------------');
  console.log(`PASS ${pass}   FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e?.message ?? e);
  process.exit(1);
});
