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
  tokenize = 'unicode61 remove_diacritics 2'
);
