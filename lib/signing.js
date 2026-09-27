import { createHmac, timingSafeEqual } from "node:crypto";

export const PROTOCOL_VERSION = 1;
export const MAX_CLOCK_SKEW_SECONDS = 300;

/**
 * Build the exact byte string that gets HMAC'd.
 *
 * This MUST stay byte-identical to `canonical_string()` in
 * codex-stats `src/codex_stats/leaderboard.py`. A pipe-delimited string is used
 * deliberately instead of JSON so there is no dependence on key ordering, float
 * formatting, or unicode escaping differing between the two runtimes.
 *
 * Layout: v|device_id|username|tokens|requests|sessions|cost_micros|clis|ts|nonce
 */
export function canonicalString(payload) {
  const clis = Object.keys(payload.clis ?? {})
    .sort()
    .filter((key) => Number(payload.clis[key]) > 0)
    .map((key) => `${key}:${Math.trunc(Number(payload.clis[key]))}`)
    .join(",");
  return [
    String(PROTOCOL_VERSION),
    String(payload.device_id),
    String(payload.username),
    String(Math.trunc(Number(payload.total_tokens))),
    String(Math.trunc(Number(payload.requests))),
    String(Math.trunc(Number(payload.sessions))),
    String(Math.trunc(Number(payload.cost_micros))),
    clis,
    String(Math.trunc(Number(payload.ts))),
    String(payload.nonce),
  ].join("|");
}

export function signPayload(payload, key) {
  return createHmac("sha256", key).update(canonicalString(payload), "utf8").digest("hex");
}

/** Constant-time signature check. Returns false rather than throwing on any mismatch. */
export function verifySignature(payload, key) {
  const expected = Buffer.from(signPayload(payload, key), "utf8");
  const provided = Buffer.from(String(payload.signature ?? ""), "utf8");
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}

/**
 * A submission older or newer than the allowed skew is rejected, which bounds how
 * long a captured request stays replayable.
 */
export function isFresh(ts, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Number.isFinite(ts)) {
    return false;
  }
  return Math.abs(nowSeconds - ts) <= MAX_CLOCK_SKEW_SECONDS;
}
