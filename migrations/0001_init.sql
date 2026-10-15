CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  total INTEGER NOT NULL,
  distinct_count INTEGER NOT NULL,
  top_phrase TEXT,
  top_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS players_total ON players (total DESC);
