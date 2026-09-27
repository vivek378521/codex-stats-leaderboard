import { createClient } from "@libsql/client";

/**
 * Turso (hosted libSQL) is used because the Vercel filesystem is read-only and
 * per-invocation, so a local SQLite file cannot survive between invocations.
 * The free plan is far larger than a leaderboard needs.
 */
const SCHEMA_STATEMENTS = [
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
