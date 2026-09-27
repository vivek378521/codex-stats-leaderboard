CREATE TABLE IF NOT EXISTS entries (
  device_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  total_tokens INTEGER NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  clis TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_ranking ON entries (total_tokens DESC, created_at ASC);
