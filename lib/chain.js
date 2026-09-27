import { createHash } from "node:crypto";

/**
 * Hash chain for the public submission log.
 *
 * This is a tamper-evidence mechanism, not tamper-prevention. Nothing stops the
 * operator rewriting a total, because the operator is also the party that signs
 * submissions. What it does guarantee is that a rewrite is *provable*: every
 * entry commits to the one before it, so altering any historical entry, or
 * removing one from the middle, breaks the chain at a specific sequence number
 * that anyone can independently recompute.
 *
 * One limitation is worth stating plainly, because it is inherent to hash chains
 * rather than a bug: dropping entries from the *end* is not detectable here,
 * because a prefix of a valid chain is itself a valid chain. Detecting that needs
 * the head hash published somewhere the operator cannot quietly edit. Until that
 * exists, `intact: true` means "internally consistent", not "complete".
 *
 * The chain deliberately covers only the fields that decide a ranking. Keeping it
 * narrow means a verifier needs nothing but this file to check the log.
 */

export const GENESIS_HASH = "0".repeat(64);

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Deterministic serialisation of a submission. Field order is fixed and values
 * are coerced, so the same submission always produces the same string.
 *
 * `clis` arrives as an object when hashing a live submission but as a JSON string
 * when read back out of the database, so it is normalised here. Without that,
 * Object.keys on the string would enumerate character indices and every
 * verification would fail against its own stored hash.
 */
export function canonicalEntry(entry) {
  let clis = entry.clis ?? {};
  if (typeof clis === "string") {
    try {
      const parsed = JSON.parse(clis);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        clis = parsed;
      } else {
        clis = {};
      }
    } catch {
      clis = {};
    }
  }
  const clisField = Object.keys(clis)
    .sort()
    .map((key) => `${key}=${Number(clis[key])}`)
    .join(",");
  return [
    String(entry.device_id),
    String(entry.username),
    Number(entry.total_tokens),
    Number(entry.requests),
    Number(entry.sessions),
    Number(entry.cost_micros),
    clisField,
  ].join("|");
}

/** Each entry hash commits to the previous entry's hash and its own content. */
export function entryHash(prevHash, entry) {
  return sha256(`${String(prevHash)}|${canonicalEntry(entry)}`);
}

/**
 * Recompute a chain and report where it stops agreeing with what is stored.
 *
 * Returns the number of leading entries that verify plus the first sequence
 * number that does not, so a verifier can point at a specific record instead of
 * just saying "invalid".
 */
export function verifyChain(entries) {
  let prev = GENESIS_HASH;
  for (const entry of entries) {
    if (Number(entry.seq) !== Number(entry.seq) || String(entry.prev_hash) !== prev) {
      return { ok: false, brokenAt: Number(entry.seq), verified: entries.indexOf(entry), reason: "prev_hash mismatch" };
    }
    const expected = entryHash(prev, entry);
    if (expected !== String(entry.entry_hash)) {
      return { ok: false, brokenAt: Number(entry.seq), verified: entries.indexOf(entry), reason: "entry_hash mismatch" };
    }
    prev = String(entry.entry_hash);
  }
  return { ok: true, brokenAt: null, verified: entries.length, reason: null };
}
