import { countEntries, ensureSchema, topEntries } from "../lib/db.js";

export const config = { runtime: "nodejs" };

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

function parseClis(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Use GET." });
  }

  const rawLimit = Number.parseInt(String(req.query?.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : DEFAULT_LIMIT;
  const rawOffset = Number.parseInt(String(req.query?.offset ?? ""), 10);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;

  res.setHeader("Cache-Control", "no-store");

  try {
    await ensureSchema();
    const [rows, total] = await Promise.all([topEntries(limit, offset), countEntries()]);
    return res.status(200).json({
      ok: true,
      total,
      limit,
      offset,
      entries: rows.map((row, index) => ({
        rank: offset + index + 1,
        username: String(row.username),
        totalTokens: Number(row.total_tokens),
        requests: Number(row.requests),
        sessions: Number(row.sessions),
        costUsd: Number(row.cost_micros) / 1_000_000,
        clis: parseClis(row.clis),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      })),
    });
  } catch (error) {
    console.error("leaderboard read failed", error);
    return res.status(500).json({ ok: false, error: "Could not load the leaderboard." });
  }
}
