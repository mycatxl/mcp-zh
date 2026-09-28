-- D1 schema for the MCP 中文源.
--
-- Apply once, before importing:
--   wrangler d1 execute mcp-zh --file=generator/lib/schema.sql --remote
--
-- Two tables:
--   servers — one row per entry, holding the full official-shaped record as JSON
--   search  — FTS5 index over CJK-bigram-folded text (see shared/fold.js)
--
-- `servers.id` is both the ordering key and the pagination cursor, and it is
-- reused as the FTS5 `rowid`, so a search hit maps straight back to its record.
--
-- ---------------------------------------------------------------------------
-- WHY THE INDEX IS "external content" AND `columnsize = 0`
--
-- D1's free tier allows 100,000 rows written per day, and FTS5 writes into its
-- own shadow tables, so the index flavour decides whether a full import fits in
-- a single day. Measured on the real dataset (34,294 installable entries), by
-- counting the physical rows each flavour actually creates:
--
--   default fts5  (stores a copy of the text + per-row docsize)
--       search_content 34,294 + search_docsize 34,294 + servers 34,294 = 102,882
--       -> OVER budget; the import would be cut off partway through
--
--   content='servers', columnsize=0   <-- this one
--       search_data 1,115 + search_idx 1,036 + search_config 1 + servers 34,294
--       -> 36,446 rows, 36% of the daily budget, one import, no splitting
--
--   contentless (content='')
--       keeps search_docsize (34,294) -> 70,740 rows; fits, but it cannot
--       report row positions and is a dead end if we ever need them
--
-- `columnsize=0` is safe here because we only ever ask for `rowid`; bm25() was
-- verified to still work without it (measured on SQLite 3.5x: -1.9688613487928486).
-- External content means FTS5 stores no copy of the text — `servers` holds the
-- Chinese text, and the folded bigrams are inserted into the index explicitly.
-- A `rebuild` command would NOT work, because it re-reads the *unfolded* content
-- table; the index must be fed `fold()`ed text at import time.
--
-- NOTE the module name must be lowercase `fts5`. D1 rejects `FTS5` with
-- "not authorized".
--
-- WHY THE SEARCH INDEX HAS EXACTLY TWO COLUMNS (title, description):
-- the host filters results a second time on its side, against
-- [entry.name, entry.description, entry.author] — where entry.name is the display
-- title and author is never set. If we indexed anything else (the registry name,
-- the category), a row could match server-side yet be discarded client-side,
-- silently wasting one of the 100 slots in the page. With this column set, every
-- hit the index produces is guaranteed to survive that local filter.
--
-- Deliberately NO secondary indexes on `servers`. Every index adds a row written
-- per insert, and D1's free tier allows 100,000 rows written per day — two
-- indexes would add ~74,000 writes to a full import for no benefit: browse reads
-- the primary-key range, and category filtering happens client-side.
--
-- Column is `description`, not `desc`, because DESC is a SQL keyword.
--
-- ---------------------------------------------------------------------------
-- WHY EVERY SEARCH QUERY MUST CONSTRAIN `search.rowid`, NOT `servers.id`
--
-- The Worker pages through search results with a cursor. Writing that cursor
-- against the joined table degrades the plan, measured with EXPLAIN QUERY PLAN:
--
--   WHERE search MATCH ?1 AND s.id > ?2    (servers side)
--       SCAN f VIRTUAL TABLE INDEX 0:M2
--       SEARCH s USING INTEGER PRIMARY KEY (rowid=?)
--       USE TEMP B-TREE FOR ORDER BY        <-- sorts every hit, every page
--
--   WHERE search MATCH ?1 AND f.rowid > ?2 (fts side)
--       SCAN f VIRTUAL TABLE INDEX 64:M2>   <-- cursor pushed into the index
--       SEARCH s USING INTEGER PRIMARY KEY (rowid=?)
--                                       (no sort at all)
--
-- Both are correct; the second avoids materialising and sorting the full hit
-- set, which is what keeps a search inside D1's per-query CPU budget.

DROP TABLE IF EXISTS search;
DROP TABLE IF EXISTS servers;

CREATE TABLE servers (
  id          INTEGER PRIMARY KEY,
  registry_id TEXT    NOT NULL,
  name        TEXT    NOT NULL,
  source_name TEXT    NOT NULL,
  title       TEXT,
  description TEXT,
  category    TEXT,
  transport   TEXT,
  json        TEXT    NOT NULL
);

CREATE VIRTUAL TABLE search USING fts5 (
  title,
  description,
  content = 'servers',
  content_rowid = 'id',
  columnsize = 0,
  tokenize = 'unicode61 remove_diacritics 2'
);
