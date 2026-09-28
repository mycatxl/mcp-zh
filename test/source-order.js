/**
 * Does the stored ORDER of market sources survive sanitizeMarketSources(), and
 * does that order decide which entries appear first in the market?
 *
 * Runs the host's OWN extracted function. Two findings drive everything:
 *
 *  1. The official source cannot be removed. The UI hides its remove button
 *     (the row renders `E.builtin ? null : <remove button>`), and a list without
 *     it gets it back via unshift().
 *
 *  2. unshift() puts it at the FRONT. So storing only our source yields
 *     [official, ours] — the English source leads. Storing BOTH, with ours
 *     written first, preserves [ours, official] and the Chinese entries lead.
 *
 * The aggregator merges sources in array order:
 *     settled.forEach((result) => { for (const entry of result.value.entries) ... })
 * so array order IS display order.
 *
 *   node test/source-order.js
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

/** Must match the host's DEFAULT_MARKET_SOURCE exactly, or it is discarded. */
const OFFICIAL = {
  id: 'official',
  name: 'Official registry',
  url: 'https://registry.modelcontextprotocol.io/v0/servers',
  kind: 'registry',
  builtin: true,
};
const OURS = {
  id: 'mcp-zh',
  name: 'MCP 中文源',
  url: 'https://mcp-zh-registry.gplusss.workers.dev/servers',
  kind: 'registry',
};

const ids = (list) => list.map((s) => s.id).join(',');

console.log('1) order is preserved when both are stored');
{
  const r = m.sanitizeMarketSources([OURS, OFFICIAL]);
  check('stored [ours, official] -> result [ours, official]', ids(r) === 'mcp-zh,official', ids(r));
}
{
  const r = m.sanitizeMarketSources([OFFICIAL, OURS]);
  check('stored [official, ours] -> result [official, ours]', ids(r) === 'official,mcp-zh', ids(r));
}

console.log('\n2) storing ONLY our source lets the official one take the front');
{
  const r = m.sanitizeMarketSources([OURS]);
  // This is the trap: the missing official source is unshift()ed to the front,
  // so a Chinese source added on its own ends up displayed AFTER the English one.
  check('stored [ours] -> official is PREPENDED', ids(r) === 'official,mcp-zh', ids(r));
}

console.log('\n3) the official source cannot be removed or replaced');
{
  check('empty list -> official restored', ids(m.sanitizeMarketSources([])) === 'official');
  check('official is always present', m.sanitizeMarketSources([OURS]).some((s) => s.id === 'official'));
}
{
  // Hijacking the id: url/kind must match exactly or the entry is skipped and the
  // real official source is prepended instead.
  const r = m.sanitizeMarketSources([OURS, { id: 'official', name: 'x', url: 'https://evil.example.com/s', kind: 'registry' }]);
  const off = r.find((s) => s.id === 'official');
  check('id "official" with another url is rejected', off.url === OFFICIAL.url, off.url);
  check('and the real official source is prepended', ids(r) === 'official,mcp-zh', ids(r));
}

console.log('\n4) builtin flags drive what the UI lets you delete');
{
  const r = m.sanitizeMarketSources([OURS, OFFICIAL]);
  check('official keeps builtin:true', r.find((s) => s.id === 'official').builtin === true);
  check('ours has no builtin flag, so its remove button shows', r.find((s) => s.id === 'mcp-zh').builtin === undefined);
}

console.log('\n5) the 16-source cap');
{
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `s${i}`,
    name: `s${i}`,
    url: `https://e${i}.example.com/x`,
    kind: 'registry',
  }));
  const r = m.sanitizeMarketSources(many);
  check('capped at 16', r.length <= 16, `${r.length}`);
  check('official survives the cap', r.some((s) => s.id === 'official'));
}

console.log('\n6) merge order = display order (simulated with the aggregator\'s own loop)');
{
  // The aggregator does exactly this, with entries already mapped per source.
  function merge(perSource) {
    const entries = [];
    const seen = new Set();
    for (const { entries: list } of perSource) {
      for (const e of list) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        entries.push(e);
      }
    }
    return entries;
  }

  const ours = [{ id: 'zh-a' }, { id: 'zh-b' }];
  const official = [{ id: 'en-a' }, { id: 'en-b' }];

  const oursFirst = m.sanitizeMarketSources([OURS, OFFICIAL]);
  const officialFirst = m.sanitizeMarketSources([OFFICIAL, OURS]);

  const bySource = new Map([
    ['mcp-zh', { entries: ours }],
    ['official', { entries: official }],
  ]);

  const a = merge(oursFirst.map((s) => bySource.get(s.id)));
  const b = merge(officialFirst.map((s) => bySource.get(s.id)));

  check('ours first -> Chinese entries lead', a.map((e) => e.id).join(',') === 'zh-a,zh-b,en-a,en-b', a.map((e) => e.id).join(','));
  check('official first -> English entries lead', b.map((e) => e.id).join(',') === 'en-a,en-b,zh-a,zh-b', b.map((e) => e.id).join(','));
  console.log('');
  console.log('    This is why the stored array must be written as [ours, official]:');
  console.log('    the first page of the market is then 100 Chinese cards.');
}

console.log('\n7) what the exact stored JSON must look like');
{
  const stored = [OURS, OFFICIAL];
  const json = JSON.stringify(stored);
  const roundTrip = m.sanitizeMarketSources(JSON.parse(json));
  check('round-trips through JSON.stringify/parse', ids(roundTrip) === 'mcp-zh,official', ids(roundTrip));
  check('id matches the host regex', /^[a-z][a-z0-9_-]{0,63}$/.test(OURS.id));
  console.log('');
  console.log('    ' + json);
}

console.log('\n--------------------------------------------');
console.log(`PASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
