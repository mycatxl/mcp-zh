/**
 * Does every record we intend to serve actually become a VISIBLE market entry
 * on the client, with the category we intended?
 *
 * Three things can silently kill a record:
 *
 *  1. ID COLLISION. The client merges sources by derived id, first source wins,
 *     and the official source is force-prepended — so an id that collides with an
 *     official one means our entry is discarded, however good the translation is.
 *  2. UNINSTALLABLE. `mapRegistryServer()` returns null for a record with no
 *     npm/pypi package and no usable streamable-http remote; `ingest()` drops it.
 *     Serving such a record wastes a page slot and a browse-cache slot.
 *  3. CATEGORY DRIFT. `guessCategory()` keyword-matches ENGLISH text. Translating
 *     the title/description collapses almost everything into "devtools"
 *     (measured: 80 -> 93 of 100). The generator parks a category keyword in the
 *     name to pin it, but the Chinese text is still scanned, so this must be
 *     re-measured on the TRANSLATED text, not the original.
 *
 * Runs the host's OWN extracted functions
 * (generator/lib/host-mapper.generated.js) over the exact records we would serve.
 *
 *   node generator/check-served.js [--limit=5000] [--untranslated]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapRegistryServer, guessCategory, registryIdFromName } from './lib/host-mapper.generated.js';
import { buildServedRecord, CATEGORIES } from '../shared/shape.js';
import { Translator, nameTokens } from './lib/translate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const limit = Number(arg('limit', '0')) || Infinity;
const useTranslations = !has('untranslated');

const raw = fs
  .readFileSync(path.join(DATA, 'raw.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .slice(0, limit === Infinity ? undefined : limit)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const translator = useTranslations ? new Translator({ cachePath: path.join(DATA, 'translation-cache.json') }) : null;
console.log(`records: ${raw.length.toLocaleString()}   text: ${useTranslations ? 'translated (production)' : 'ORIGINAL ENGLISH (diagnostic)'}`);
console.log('');

// The official id space, as the client would derive it.
const officialIds = new Set();
for (const rec of raw) {
  const name = rec?.server?.name;
  if (name) officialIds.add(registryIdFromName(name));
}

const stats = {
  total: 0,
  dropped: 0,
  officialCollisions: 0,
  duplicateIds: 0,
  categoryDrift: 0,
  byReason: new Map(),
  byTransport: new Map(),
  byCategory: new Map(),
  dropExamples: [],
  collideExamples: [],
  driftExamples: [],
};

const seenIds = new Set();

for (const rec of raw) {
  const src = rec?.server ?? {};
  if (!src.name) continue;
  stats.total += 1;

  // Same translation lookup step3 uses, so this measures the real output.
  let titleZh = '';
  let descZh = '';
  if (translator) {
    const extra = nameTokens(src.name);
    if (typeof src.title === 'string' && src.title.trim()) titleZh = translator.cache.get(Translator.key(src.title, true, extra)) ?? '';
    if (typeof src.description === 'string' && src.description.trim()) descZh = translator.cache.get(Translator.key(src.description, true, extra)) ?? '';
  }

  const built = buildServedRecord(rec, { titleZh, descZh });

  // ---- 1. does the client show it at all? --------------------------------
  const entry = mapRegistryServer({ server: built.served, _meta: built.meta });
  if (!entry) {
    stats.dropped += 1;
    const packages = Array.isArray(src.packages) ? src.packages : [];
    const hasPackage = packages.some((p) => ['npm', 'pypi'].includes(String(p?.registryType ?? '').toLowerCase()));
    const reason = hasPackage
      ? 'rejected by the host mapper (env placeholder / bad url / bad command)'
      : 'no npm/pypi package and no usable streamable-http remote';
    stats.byReason.set(reason, (stats.byReason.get(reason) ?? 0) + 1);
    if (stats.dropExamples.length < 6) stats.dropExamples.push(`${src.name}  —  ${reason}`);
    continue;
  }

  // ---- 2. id collision against the official space, and self-duplication ---
  if (officialIds.has(built.id)) {
    stats.officialCollisions += 1;
    if (stats.collideExamples.length < 8) stats.collideExamples.push(`OFFICIAL COLLISION  ${built.id}  <-  ${src.name}`);
  }
  if (seenIds.has(built.id)) {
    stats.duplicateIds += 1;
    if (stats.collideExamples.length < 8) stats.collideExamples.push(`duplicate id        ${built.id}  <-  ${src.name}`);
  }
  seenIds.add(built.id);

  // ---- 3. category drift, judged by the client's own function ------------
  const clientCategory = guessCategory(built.served);
  if (clientCategory !== built.category) {
    stats.categoryDrift += 1;
    if (stats.driftExamples.length < 10) {
      stats.driftExamples.push(`${built.id}\n        intended ${built.category}, client shows ${clientCategory}`);
    }
  }

  stats.byTransport.set(entry.transport, (stats.byTransport.get(entry.transport) ?? 0) + 1);
  stats.byCategory.set(built.category, (stats.byCategory.get(built.category) ?? 0) + 1);
}

const served = stats.total - stats.dropped;
console.log('=================== SERVED RECORDS ===================');
console.log(`records considered       : ${stats.total.toLocaleString()}`);
console.log(`client would SHOW        : ${served.toLocaleString()}`);
console.log(`client would DROP        : ${stats.dropped.toLocaleString()}  (must not be served)`);
console.log('');
console.log('transports :', JSON.stringify(Object.fromEntries(stats.byTransport)));
console.log('categories :', JSON.stringify(Object.fromEntries([...stats.byCategory].sort((a, b) => b[1] - a[1]))));
console.log('');

if (stats.dropExamples.length) {
  console.log('--- why records are dropped');
  for (const d of stats.dropExamples) console.log(`    ${d}`);
  for (const [reason, n] of stats.byReason) console.log(`    [${n.toLocaleString()}] ${reason}`);
  console.log('');
}

console.log('=================== ID COLLISIONS ===================');
console.log(`vs official id space : ${stats.officialCollisions}   (must be 0)`);
console.log(`duplicates in our set: ${stats.duplicateIds}   (the generator skips these)`);
for (const c of stats.collideExamples) console.log(`    ${c}`);
console.log('');

console.log('=================== CATEGORY DRIFT ===================');
console.log(`drifted: ${stats.categoryDrift.toLocaleString()} of ${served.toLocaleString()}`);
for (const d of stats.driftExamples) console.log(`    ${d}`);
console.log(`known categories: ${CATEGORIES.join(', ')}`);

const ok = stats.officialCollisions === 0;
console.log('');
console.log(ok ? 'OK' : 'FAILED');
process.exit(ok ? 0 : 1);
