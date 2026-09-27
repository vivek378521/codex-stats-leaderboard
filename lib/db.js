import { createClient } from "@libsql/client";
import { GENESIS_HASH } from "./chain.js";

/**
 * Turso (hosted libSQL) is used because the Vercel filesystem is read-only and
 * per-invocation, so a local SQLite file cannot survive between invocations.
 * The free plan is far larger than a leaderboard needs.
 */
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS entries (
     device_id TEXT PRIMARY KEY,
     username TEXT NOT NULL,
     total_tokens INTEGER NOT NULL,
     requests INTEGER NOT NULL DEFAULT 0,
     sessions INTEGER NOT NULL DEFAULT 0,
     cost_micros INTEGER NOT NULL DEFAULT 0,
     clis TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_entries_ranking ON entries (total_tokens DESC, created_at ASC)`,
  // Append-only audit trail. Each entry hashes the one before it, so editing or
  // deleting history is detectable by anyone who fetches the log, not just by us.
  `CREATE TABLE IF NOT EXISTS submission_log (
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
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_log_hash ON submission_log (entry_hash)`,
  // Turso-backed rate limiting: serverless instances do not share memory, so a
  // per-instance counter would reset on every cold start and limit nothing.
  `CREATE TABLE IF NOT EXISTS rate_limits (
     subject TEXT PRIMARY KEY,
     window_start INTEGER NOT NULL,
     count INTEGER NOT NULL
   )`,
];

const UPSERT_SQL = `
  INSERT INTO entries (
    device_id, username, total_tokens, requests, sessions, cost_micros, clis, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (device_id) DO UPDATE SET
    username = excluded.username,
    total_tokens = excluded.total_tokens,
    requests = excluded.requests,
    sessions = excluded.sessions,
    cost_micros = excluded.cost_micros,
    clis = excluded.clis,
    updated_at = excluded.updated_at
`;

let client = null;
let schemaReady = null;

export function getClient() {
  if (client) {
    return client;
  }
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    throw new Error("TURSO_DATABASE_URL is not set.");
  }
  client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  return client;
}

/** Idempotent DDL, memoised per warm lambda so it runs at most once per instance. */
export async function ensureSchema() {
  if (!schemaReady) {
    const db = getClient();
    schemaReady = db
      .executeMultiple(SCHEMA_STATEMENTS.join(";\n"))
      .then(() => true)
      .catch((error) => {
        schemaReady = null;
        throw error;
      });
  }
  return schemaReady;
}

export async function findEntry(deviceId) {
  const db = getClient();
  const result = await db.execute({
    sql: "SELECT * FROM entries WHERE device_id = ?",
    args: [deviceId],
  });
  return result.rows[0] ?? null;
}

/**
 * Insert or update the single row owned by this machine. Re-submitting overwrites
 * the existing record rather than appending a new one.
 */
export async function upsertEntry(entry) {
  const db = getClient();
  await db.execute({
    sql: UPSERT_SQL,
    args: [
      entry.device_id,
      entry.username,
      entry.total_tokens,
      entry.requests,
      entry.sessions,
      entry.cost_micros,
      JSON.stringify(entry.clis),
      entry.created_at,
      entry.updated_at,
    ],
  });
}

/** Rank is 1 + the number of entries that sort ahead of this one. */
export async function rankFor(totalTokens, createdAt) {
  const db = getClient();
  const result = await db.execute({
    sql: `SELECT COUNT(*) AS ahead FROM entries
          WHERE total_tokens > ? OR (total_tokens = ? AND created_at < ?)`,
    args: [totalTokens, totalTokens, createdAt],
  });
  return Number(result.rows[0]?.ahead ?? 0) + 1;
}

export async function countEntries() {
  const db = getClient();
  const result = await db.execute("SELECT COUNT(*) AS total FROM entries");
  return Number(result.rows[0]?.total ?? 0);
}

export async function topEntries(limit, offset) {
  const db = getClient();
  const result = await db.execute({
    sql: `SELECT username, total_tokens, requests, sessions, cost_micros, clis, created_at, updated_at
          FROM entries
          ORDER BY total_tokens DESC, created_at ASC
          LIMIT ? OFFSET ?`,
    args: [limit, offset],
  });
  return result.rows;
}

/* ---------------------------------------------------------------- audit log */

async function lastLogEntry(db) {
  const result = await db.execute("SELECT entry_hash FROM submission_log ORDER BY seq DESC LIMIT 1");
  return result.rows[0] ?? null;
}

/**
 * Append a submission to the hash chain. Kept separate from the upsert so a
 * rejected submission never reaches the log, and so a failed upsert cannot leave
 * a log entry claiming a write that did not happen.
 */
export async function appendLog(entry, prevHash, entryHashValue) {
  const db = getClient();
  await db.execute({
    sql: `INSERT INTO submission_log
          (device_id, username, total_tokens, requests, sessions, cost_micros, clis, recorded_at, prev_hash, entry_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      entry.device_id,
      entry.username,
      entry.total_tokens,
      entry.requests,
      entry.sessions,
      entry.cost_micros,
      JSON.stringify(entry.clis),
      entry.recorded_at,
      prevHash,
      entryHashValue,
    ],
  });
}

export async function currentChainHead() {
  const db = getClient();
  const row = await lastLogEntry(db);
  return String(row?.entry_hash ?? GENESIS_HASH);
}

export async function readLog(limit, offset) {
  const db = getClient();
  const result = await db.execute({
    sql: `SELECT seq, device_id, username, total_tokens, requests, sessions, cost_micros,
                 clis, recorded_at, prev_hash, entry_hash
          FROM submission_log ORDER BY seq ASC LIMIT ? OFFSET ?`,
    args: [limit, offset],
  });
  return result.rows;
}

export async function countLogEntries() {
  const db = getClient();
  const result = await db.execute("SELECT COUNT(*) AS total FROM submission_log");
  return Number(result.rows[0]?.total ?? 0);
}

/* -------------------------------------------------------------- rate limits */

/**
 * Fixed-window counter stored in Turso. Returns the number of attempts in the
 * current window, which the caller compares against its limit.
 *
 * The read and the write are not one atomic operation, so a burst of concurrent
 * requests can overshoot the limit by a few. That is acceptable for a rate limit
 * whose job is to stop sustained abuse rather than to be an exact quota.
 */
export async function bumpRateLimit(subject, windowSeconds, nowSeconds) {
  const db = getClient();
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  await db.execute({
    sql: `INSERT INTO rate_limits (subject, window_start, count) VALUES (?, ?, 1)
          ON CONFLICT(subject) DO UPDATE SET
            count = CASE WHEN rate_limits.window_start = ? THEN rate_limits.count + 1 ELSE 1 END,
            window_start = ?`,
    args: [subject, windowStart, windowStart, windowStart],
  });
  const result = await db.execute({
    sql: "SELECT count FROM rate_limits WHERE subject = ?",
    args: [subject],
  });
  return Number(result.rows[0]?.count ?? 1);
}
