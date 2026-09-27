import { isFresh, verifySignature } from "../lib/signing.js";
import { parseSubmission } from "../lib/validate.js";
import { ensureSchema, findEntry, rankFor, upsertEntry } from "../lib/db.js";

export const config = { runtime: "nodejs" };

function readBody(req) {
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return req.body ?? null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Use POST." });
  }

  const key = process.env.LEADERBOARD_SUBMIT_KEY;
  if (!key) {
    return res.status(503).json({ ok: false, error: "Server is not configured for submissions." });
  }

  const parsed = parseSubmission(readBody(req));
  if (!parsed.ok) {
    return res.status(400).json({ ok: false, error: parsed.error });
  }
  const submission = parsed.value;

  // Signature is checked before any database work, so forged requests cost nothing
  // and cannot burn rows-written quota.
  if (!verifySignature(submission, key)) {
    return res.status(401).json({ ok: false, error: "Invalid signature." });
  }
  if (!isFresh(submission.ts)) {
    return res.status(401).json({ ok: false, error: "Submission timestamp is outside the allowed window." });
  }

  // The per-CLI breakdown must account for the headline total. This is what stops a
  // modified client from pairing a real-looking total with a fabricated breakdown.
  const breakdownTotal = Object.values(submission.clis).reduce((sum, value) => sum + value, 0);
  if (breakdownTotal !== submission.total_tokens) {
    return res.status(400).json({
      ok: false,
      error: `CLI breakdown totals ${breakdownTotal} but the reported total is ${submission.total_tokens}.`,
    });
  }

  try {
    await ensureSchema();
    const existing = await findEntry(submission.device_id);

    // All-time token counts only ever grow. A smaller number means the local
    // history was truncated or tampered with, so the existing record is kept.
    if (existing && submission.total_tokens < Number(existing.total_tokens)) {
      const rank = await rankFor(Number(existing.total_tokens), String(existing.created_at));
      return res.status(409).json({
        ok: false,
        error: "That is lower than your previous submission, so your existing record was kept.",
        rank,
        totalTokens: Number(existing.total_tokens),
      });
    }

    const now = new Date().toISOString();
    const createdAt = existing ? String(existing.created_at) : now;
    await upsertEntry({
      device_id: submission.device_id,
      username: submission.username,
      total_tokens: submission.total_tokens,
      requests: submission.requests,
      sessions: submission.sessions,
      cost_micros: submission.cost_micros,
      clis: submission.clis,
      created_at: createdAt,
      updated_at: now,
    });

    const rank = await rankFor(submission.total_tokens, createdAt);
    return res.status(200).json({
      ok: true,
      rank,
      totalTokens: submission.total_tokens,
      username: submission.username,
      updated: existing ? "Your existing record was updated." : "Welcome to the leaderboard.",
    });
  } catch (error) {
    console.error("submit failed", error);
    return res.status(500).json({ ok: false, error: "Could not record the submission." });
  }
}
