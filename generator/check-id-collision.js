/**
 * Proves the id scheme is safe against the client's own id derivation.
 *
 * The client merges market sources by derived entry id with "first source wins",
 * and `sanitizeMarketSources()` force-prepends the official source. So if our
 * derived id equals an official one, our record is silently DISCARDED no matter
 * how good its translation is.
 *
 * `registryIdFromName()` truncates the slug to 60 characters, which makes the
 * marker's position decisive. Measured on the real dataset with the host's own
 * function:
 *
 *     name + "/zh/<category>"    158 records collapse onto the official id
 *     "zh/<category>/" + name      0 records collapse
 *
 * This re-derives the ids from the records `shared/shape.js` ACTUALLY produces
 * (not from a re-implementation of the scheme), so it fails if the naming
 * regresses.
 *
 * TWO DIFFERENT KINDS OF CLASH — only the first is a defect:
 *
 *   official collision : our id equals an official source's id. Fatal: the
 *                        client keeps the official record and drops ours.
 *   internal duplicate : two of OUR records derive the same id, because the
 *                        registry contains names differing only in case or
 *                        punctuation. Expected and handled: step3 keeps the first
 *                        and skips the rest, since the client would drop the
 *                        second anyway.
 *
 *   node generator/check-id-collision.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registryIdFromName } from './lib/host-mapper.generated.js';
import { buildServedRecord } from '../shared/shape.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');

const raw = fs
  .readFileSync(path.join(DATA, 'raw.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

console.log(`records: ${raw.length.toLocaleString()}`);
console.log('');

// ---------------------------------------------------------------------------
// Part 1: what the SUFFIX scheme would have done (the trap being avoided).
// ---------------------------------------------------------------------------
let suffixCollisions = 0;
const suffixExamples = [];
for (const rec of raw) {
  const name = rec?.server?.name;
  if (!name) continue;
  if (registryIdFromName(name) === registryIdFromName(`${name}/zh/api`)) {
    suffixCollisions += 1;
    if (suffixExamples.length < 4) suffixExamples.push({ name, id: registryIdFromName(name) });
  }
}

console.log('=================== SUFFIX SCHEME (rejected) ===================');
console.log(`"name/zh/<category>" collides with the official id for ${suffixCollisions} records`);
for (const c of suffixExamples) console.log(`    ${c.id}  <-  ${c.name}`);
console.log('  (each would be silently dropped by the client)');
console.log('');

// ---------------------------------------------------------------------------
// Part 2: what the CURRENT scheme actually produces.
// ---------------------------------------------------------------------------
const officialIds = new Set();
for (const rec of raw) {
  const name = rec?.server?.name;
  if (name) officialIds.add(registryIdFromName(name));
}

const firstOwner = new Map(); // id -> registry name
const officialCollisions = [];
const duplicates = [];
const badRegex = [];
const markerLost = [];

for (const rec of raw) {
  const name = rec?.server?.name;
  if (!name) continue;
  const { served, id } = buildServedRecord(rec, {});

  if (officialIds.has(id)) officialCollisions.push({ name, id });
  if (firstOwner.has(id)) duplicates.push({ name, id, first: firstOwner.get(id) });
  else firstOwner.set(id, name);

  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) badRegex.push({ name, id });
  // The marker must survive both on the served name and in the derived id.
  if (!id.startsWith('zh-') || !served.name.startsWith('zh/')) markerLost.push({ name, id, servedName: served.name });
}

console.log('=================== CURRENT SCHEME ===================');
console.log(`unique ids                 : ${firstOwner.size.toLocaleString()}`);
console.log(`official collisions        : ${officialCollisions.length}   (must be 0 — fatal)`);
console.log(`internal duplicates        : ${duplicates.length}   (expected; step3 skips these)`);
console.log(`ids failing the host regex : ${badRegex.length}   (must be 0)`);
console.log(`records losing the marker  : ${markerLost.length}   (must be 0)`);
console.log('');

if (officialCollisions.length) {
  console.log('--- OFFICIAL COLLISIONS (these records would never be shown)');
  for (const c of officialCollisions.slice(0, 10)) console.log(`    ${c.id}  <-  ${c.name}`);
  console.log('');
}

if (duplicates.length) {
  console.log('--- internal duplicates (registry names differing only in case/punctuation)');
  for (const d of duplicates.slice(0, 12)) console.log(`    ${d.id}  <-  ${d.name}   (same as ${d.first})`);
  if (duplicates.length > 12) console.log(`    ... and ${duplicates.length - 12} more`);
  console.log('');
}

for (const b of badRegex.slice(0, 6)) console.log(`    BAD ID     ${b.id}  <-  ${b.name}`);
for (const m of markerLost.slice(0, 6)) console.log(`    NO MARKER  ${m.servedName}  <-  ${m.name}`);

console.log('sample ids:');
for (const [id, name] of [...firstOwner].slice(0, 4)) console.log(`    ${id.padEnd(52)} <- ${name}`);

const longest = [...firstOwner.keys()].sort((a, b) => b.length - a.length)[0];
console.log(`longest id: ${longest}  (${longest.length} chars, limit 64)`);

const ok = officialCollisions.length === 0 && badRegex.length === 0 && markerLost.length === 0;
console.log('');
console.log(ok ? 'OK' : 'FAILED');
process.exit(ok ? 0 : 1);
