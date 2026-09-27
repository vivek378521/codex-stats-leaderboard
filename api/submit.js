import { isFresh, verifySignature } from "../lib/signing.js";
import { parseSubmission } from "../lib/validate.js";
import { entryHash, GENESIS_HASH } from "../lib/chain.js";
import {
  appendLogWithHead,
  bumpRateLimit,
  countEntries,
  ensureSchema,
  findEntry,
  rankFor,
  upsertEntry,
} from "../lib/db.js";

export const config = { runtime: "nodejs" };

// The signing key is public, so these are not about secrecy. They bound how much
// damage one actor can do: MAX_ROWS caps the board, and the per-IP window stops
// bulk filling it.
//
// Read per request rather than once at module load. A module-level constant would
// freeze the values at import time, which makes them impossible to exercise from
// the test suite and ties any change to a redeploy.
const RATE_LIMIT_WINDOW_SECONDS = 3600;

function maxSubmissionsPerIp() {
  const raw = Number(process.env.RATE_LIMIT_PER_IP);
  return Number.isFinite(raw) && raw > 0 ? raw : 20;
}

function maxRows() {
  const raw = Number(process.env.MAX_BOARD_ROWS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}

/** Best-effort client address. Spoofable via x-forwarded-for, so treat it as a hint. */
function clientAddress(req) {
  const forwarded = String(req.headers?.["x-forwarded-for"] ?? "");
  const first = forwarded.split(",")[0].trim();
  return first || String(req.headers?.["x-real-ip"] ?? "unknown");
}

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

    // Rate limiting runs after the signature check so that forged junk from a
    // single address cannot be used to lock a legitimate user out of submitting.
    const address = clientAddress(req);
    const attempts = await bumpRateLimit(address, RATE_LIMIT_WINDOW_SECONDS, Date.now() / 1000);
    if (attempts > maxSubmissionsPerIp()) {
      res.setHeader("Retry-After", String(RATE_LIMIT_WINDOW_SECONDS));
      return res.status(429).json({
        ok: false,
        error: "Too many submissions from this network. Try again later.",
      });
    }

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

    // A new row counts against the board cap; a resubmission of an existing row
    // does not, otherwise the cap would punish someone for correcting a typo.
    if (!existing && (await countEntries()) >= maxRows()) {
      return res.status(503).json({ ok: false, error: "The leaderboard is full." });
    }

    const now = new Date().toISOString();
    const createdAt = existing ? String(existing.created_at) : now;
    const record = {
      device_id: submission.device_id,
      username: submission.username,
      total_tokens: submission.total_tokens,
      requests: submission.requests,
      sessions: submission.sessions,
      cost_micros: submission.cost_micros,
      clis: submission.clis,
    };
    await upsertEntry({ ...record, created_at: createdAt, updated_at: now });

    // Logged only after the row is durably written, so the chain never claims a
    // write that did not happen. appendLogWithHead re-reads the head and retries
    // if a concurrent submission won the race, so the chain cannot fork.
    await appendLogWithHead({ ...record, recorded_at: now }, entryHash);

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
