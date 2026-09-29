/**
 * Pre-flight checks that would otherwise only fail inside a Cloudflare deploy or
 * a CI run — both of which are slow and awkward to debug.
 *
 *   node test/limits.js
 *
 * Checks:
 *   1. every script path referenced by .github/workflows/refresh.yml exists
 *   2. no INSERT statement in data/import.sql exceeds D1's 100 KB statement limit
 *      (measured in real UTF-8 BYTES — Chinese is 3 bytes/char, so a statement
 *      that looks like 80k "characters" is ~240 KB on the wire)
 *   3. no row exceeds D1's 2 MB row/string limit
 *   4. every file the deploy script touches exists
 *   5. the schema declares no secondary index (each one adds a row written per
 *      insert, and the write budget is the whole reason the schema looks like it does)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

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

const bytes = (s) => Buffer.byteLength(s, 'utf8');

// ---- 1. workflow script paths -------------------------------------------
console.log('1) scripts referenced by the refresh workflow');
{
  const wfPath = path.join(ROOT, '.github', 'workflows', 'refresh.yml');
  const wf = fs.readFileSync(wfPath, 'utf8');
  const refs = new Set();
  for (const m of wf.matchAll(/node\s+(generator|test|scripts)\/([A-Za-z0-9._-]+)/g)) {
    refs.add(`${m[1]}/${m[2]}`);
  }
  check('workflow references at least one script', refs.size > 0, `${refs.size} refs`);
  for (const ref of [...refs].sort()) {
    check(`  ${ref} exists`, fs.existsSync(path.join(ROOT, ref)));
  }
}

// ---- 2/3. import file limits --------------------------------------------
console.log('\n2) data/import.sql against D1 limits');
const importPath = path.join(ROOT, 'data', 'import.sql');
if (!fs.existsSync(importPath)) {
  check('import.sql exists', false, 'run: node generator/step3-sql.js');
} else {
  const D1_STATEMENT_LIMIT = 100 * 1024;
  const D1_ROW_LIMIT = 2_000_000;

  const sql = fs.readFileSync(importPath, 'utf8');
  // Statements are emitted one per line-starting INSERT and terminated by ";\n".
  const statements = sql.split(/;\s*\n/).filter((s) => s.trim().startsWith('INSERT'));
  let maxStmt = 0;
  let maxStmtHead = '';
  let overLimit = 0;
  for (const s of statements) {
    const n = bytes(s) + 1; // + the semicolon
    if (n > maxStmt) {
      maxStmt = n;
      maxStmtHead = s.slice(0, 60).replace(/\s+/g, ' ');
    }
    if (n > D1_STATEMENT_LIMIT) overLimit += 1;
  }

  check('statements were found', statements.length > 0, `${statements.length} INSERT statements`);
  check(
    'no statement exceeds the 100 KB D1 limit',
    overLimit === 0,
    `largest ${(maxStmt / 1024).toFixed(1)} KB (${maxStmt} bytes), ${overLimit} over`,
  );

  // Longest single VALUE tuple approximates the largest row.
  let maxRow = 0;
  for (const s of statements) {
    for (const line of s.split('\n')) {
      const n = bytes(line);
      if (n > maxRow) maxRow = n;
    }
  }
  check(
    'no row approaches the 2 MB row limit',
    maxRow < D1_ROW_LIMIT,
    `largest value tuple ${(maxRow / 1024).toFixed(1)} KB`,
  );
  console.log(`        (largest statement starts: ${maxStmtHead}…)`);
}

// ---- 4. deploy script inputs --------------------------------------------
console.log('\n3) files the deploy script needs');
for (const rel of [
  'scripts/deploy.mjs',
   'wrangler.toml',
  'worker/src/index.js',
  'generator/lib/schema.sql',
  'data/import.sql',
]) {
  check(`  ${rel}`, fs.existsSync(path.join(ROOT, rel)));
}

// ---- 5. schema shape ----------------------------------------------------
console.log('\n4) schema stays inside the write budget');
{
  const schema = fs.readFileSync(path.join(ROOT, 'generator', 'lib', 'schema.sql'), 'utf8');
  const createIndex = schema.match(/CREATE\s+(?:UNIQUE\s+)?INDEX/gi) ?? [];
  check('no secondary indexes', createIndex.length === 0, `${createIndex.length} found`);
  check('fts5 module name is lowercase', /USING fts5/.test(schema) && !/USING\s+FTS5/.test(schema));
  check('external content is used', /content\s*=\s*'servers'/.test(schema));
  check('columnsize is disabled', /columnsize\s*=\s*0/.test(schema));
}

console.log('\n--------------------------------------------');
console.log(`PASS ${pass}   FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
