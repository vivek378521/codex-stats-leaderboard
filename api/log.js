import { readLog, countLogEntries } from "../lib/db.js";
import { verifyChain } from "../lib/chain.js";

export const config = { runtime: "nodejs" };

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
// Upper bound on how much of the chain one request will read back to recompute
// it. Set well above the board cap so reaching it would take years of normal
// use, and low enough that a single request cannot be made to pull an unbounded
// amount of data. Past it the response says the check did not cover everything
// rather than reporting a clean bill of health.
const MAX_VERIFIED_ENTRIES = 50_000;

/** Read the first `count` log rows in pages, so verification is not a single huge query. */
async function readPagedLog(count) {
  if (count <= 0) {
    return [];
  }
  const collected = [];
  while (collected.length < count) {
    const page = await readLog(Math.min(MAX_LIMIT, count - collected.length), collected.length);
    if (page.length === 0) {
      break;
    }
    collected.push(...page);
  }
  return collected;
}

function parseClis(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The audit trail, plus a fresh verification pass over every entry.
 *
 * Verification is recomputed on each request rather than stored, so a stored
 * "ok" flag can never be edited to hide a break. The chain is walked from
 * genesis, which means the response is O(total submissions) - fine at this
 * scale, and it would need incremental verification if the log ever grew large.
 */
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
    const [rows, total] = await Promise.all([readLog(limit, offset), countLogEntries()]);

    // Verifying only a page would be misleading: a break earlier in the history
    // changes the expected prev_hash of the first row in this page, so paging
    // changes what "valid" means. Read the whole chain for the check.
    //
    // A previous version read a fixed 10,000 rows and stopped, which meant a
    // longer log was reported intact while the tail went unverified. Past the
    // bound the answer is "not determined" rather than a guess: claims have to
    // be able to mean what they say.
    const covered = Math.min(total, MAX_VERIFIED_ENTRIES);
    const all = await readPagedLog(covered);
    const verdict = verifyChain(all);
    const fullyCovered = covered === total;

    return res.status(200).json({
      ok: true,
      total,
      limit,
      offset,
      chain: {
        verified: verdict.verified,
        brokenAt: verdict.brokenAt,
        reason: verdict.reason,
        intact: verdict.ok,
        entriesVerified: covered,
        // A break inside the covered window is a real finding, so intact stays
        // true there. Beyond the window there is no answer, and reporting true
        // would be claiming a check that did not run.
        verdictReachedEnd: fullyCovered,
        note:
          "Each entry hashes the previous one, so editing a logged submission, or " +
          "removing one from the middle, breaks the chain at a specific sequence " +
          "number that anyone can recompute from this feed. Two limits worth " +
          "stating: this does not prove a reported total was honest, because the " +
          "client signs its own numbers, and dropping entries from the end is not " +
          "detectable here, because a prefix of a valid chain is also valid. " +
          "intact therefore means internally consistent, not complete.",
      },
      entries: rows.map((row) => ({
        seq: Number(row.seq),
        username: String(row.username),
        totalTokens: Number(row.total_tokens),
        requests: Number(row.requests),
        sessions: Number(row.sessions),
        costUsd: Number(row.cost_micros) / 1_000_000,
        clis: parseClis(row.clis),
        recordedAt: String(row.recorded_at),
        prevHash: String(row.prev_hash),
        entryHash: String(row.entry_hash),
      })),
    });
  } catch (error) {
    console.error("log read failed", error);
    return res.status(500).json({ ok: false, error: "Could not load the audit log." });
  }
}
