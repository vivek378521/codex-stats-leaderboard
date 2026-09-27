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
CREATE TABLE IF NOT EXISTS submission_log (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     device_id TEXT NOT NULL,
     username TEXT NOT NULL,
     total_tokens INTEGER NOT NULL,
     requests INTEGER NOT NULL,
     sessions INTEGER NOT NULL,
     cost_micros INTEGER NOT NULL,
     clis TEXT NOT NULL,
     recorded_at TEXT NOT NULL,
     prev_hash TEXT NOT NULL,
     entry_hash TEXT NOT NULL
   );
CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_log_hash ON submission_log (entry_hash);
CREATE TABLE IF NOT EXISTS rate_limits (
     subject TEXT PRIMARY KEY,
     window_start INTEGER NOT NULL,
     count INTEGER NOT NULL
   );
