/**
 * Validate the exact snippet the user will paste into PI-Desktop's DevTools
 * console, against the host's OWN sanitizeMarketSources().
 *
 * Why this test exists: the snippet writes straight into the app's localStorage
 * to work around the app's own missing-persistence bug. If the written shape is
 * wrong in any way — a bad id, a mismatched official url, the wrong order — the
 * app silently discards it and the user sees nothing, with no error message.
 * So the snippet's output is fed through the real function before being handed over.
 *
 *   node test/source-snippet.js
 */
import * as m from '../generator/lib/sanitize.generated.js';

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

/**
 * The snippet, as a function so the test exercises the real logic rather than a
 * copy of it. Must stay in sync with the one-liner handed to the user.
 */
function buildStoredValue(currentRaw) {
  const KEY = 'pi.mcp-market.sources.v1';
  const ours = {
    id: 'mcp-zh',
    name: 'MCP 中文源',
    url: 'https://mcp-zh-registry.gplusss.workers.dev/servers',
    kind: 'registry',
  };
  const official = {
    id: 'official',
    name: 'Official registry',
    url: 'https://registry.modelcontextprotocol.io/v0/servers',
    kind: 'registry',
    builtin: true,
  };
  let cur = [];
  try {
    cur = JSON.parse(currentRaw) ?? [];
  } catch {
    cur = [];
  }
  if (!Array.isArray(cur)) cur = [];
  // Keep any other custom sources the user may have, drop stale copies of ours
  // and of the official entry, then write ours first and official last.
  const rest = cur.filter((s) => s && s.id !== 'mcp-zh' && s.id !== 'official');
  return JSON.stringify([ours, ...rest, official]);
}

const ids = (list) => list.map((s) => s.id).join(',');

console.log('1) the stored value survives the host validator');
{
  const stored = buildStoredValue(null);
  const result = m.sanitizeMarketSources(JSON.parse(stored));
  check('ours ends up FIRST', ids(result) === 'mcp-zh,official', ids(result));
}
{
  // The user's actual current storage: official only.
  const current = JSON.stringify([
    {
      id: 'official',
      name: 'Official registry',
      url: 'https://registry.modelcontextprotocol.io/v0/servers',
      kind: 'registry',
      builtin: true,
    },
  ]);
  const stored = buildStoredValue(current);
  const result = m.sanitizeMarketSources(JSON.parse(stored));
  check('from the real current state -> ours first', ids(result) === 'mcp-zh,official', ids(result));
}

console.log('\n2) running it twice changes nothing');
{
  const once = buildStoredValue(null);
  const twice = buildStoredValue(once);
  const r1 = m.sanitizeMarketSources(JSON.parse(once));
  const r2 = m.sanitizeMarketSources(JSON.parse(twice));
  check('idempotent', ids(r1) === ids(r2), `${ids(r1)} vs ${ids(r2)}`);
  check('no duplicate mcp-zh entry', (twice.match(/"mcp-zh"/g) ?? []).length === 1);
}

console.log('\n3) other custom sources are preserved');
{
  const withOther = JSON.stringify([
    { id: 'official', name: 'Official registry', url: 'https://registry.modelcontextprotocol.io/v0/servers', kind: 'registry', builtin: true },
    { id: 'custom-abc', name: 'My other source', url: 'https://example.com/servers', kind: 'registry' },
  ]);
  const result = m.sanitizeMarketSources(JSON.parse(buildStoredValue(withOther)));
  check('ours first, other kept, official last', ids(result) === 'mcp-zh,custom-abc,official', ids(result));
}

console.log('\n4) damaged input cannot produce a broken list');
{
  for (const bad of ['', 'not json', '{}', 'null', '[null,1,"x"]']) {
    const stored = buildStoredValue(bad);
    let ok = false;
    let detail = '';
    try {
      const result = m.sanitizeMarketSources(JSON.parse(stored));
      ok = ids(result) === 'mcp-zh,official';
      detail = ids(result);
    } catch (e) {
      detail = e.message;
    }
    check(`input ${JSON.stringify(bad).slice(0, 14)} -> ours first`, ok, detail);
  }
}

console.log('\n5) the exact strings the host compares');
{
  const OFFICIAL = {
    id: 'official',
    name: 'Official registry',
    url: 'https://registry.modelcontextprotocol.io/v0/servers',
    kind: 'registry',
    builtin: true,
  };
  const stored = JSON.parse(buildStoredValue(null));
  const off = stored.find((s) => s.id === 'official');
  check('official url matches byte-for-byte', off.url === OFFICIAL.url, off.url);
  check('official kind is registry', off.kind === 'registry');
  check('official name is not required to match', typeof off.name === 'string');
  check('our url is the /servers endpoint', stored[0].url.endsWith('/servers'), stored[0].url);
  check('our id passes the host regex', /^[a-z][a-z0-9_-]{0,63}$/.test(stored[0].id));
}

console.log('\n6) the one-liner itself');
{
  // Guard against the handed-over snippet drifting from what is tested here.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const doc = fs.readFileSync(path.join(HERE, '..', 'docs', 'console-snippet.txt'), 'utf8').trim();
  check('snippet file exists and is one line', !doc.includes('\n'), `${doc.length} chars`);
  check('snippet writes the right key', doc.includes('pi.mcp-market.sources.v1'));
  check('snippet mentions our url', doc.includes('mcp-zh-registry.gplusss.workers.dev/servers'));
  check('snippet mentions the official url', doc.includes('registry.modelcontextprotocol.io/v0/servers'));
  check('snippet uses localStorage.setItem', doc.includes('localStorage.setItem'));
  check('snippet is idempotent by construction', doc.includes("s.id!=='mcp-zh'") || doc.includes('s.id!=="mcp-zh"'));
}

console.log('\n--------------------------------------------');
console.log(`PASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
