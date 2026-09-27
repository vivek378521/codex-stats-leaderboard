import { PROTOCOL_VERSION } from "./signing.js";

export const USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,20}$/;
export const DEVICE_ID_PATTERN = /^[0-9a-f]{32}$/;
export const NONCE_PATTERN = /^[0-9a-f]{32}$/;
export const KNOWN_SOURCES = ["claude", "codex", "hermes", "opencode"];

/**
 * Absolute ceiling on a single all-time token count. Local usage beyond this is
 * not physically plausible, and clamping here bounds how much damage a modified
 * client that somehow holds the key can do to the board.
 */
export const MAX_TOTAL_TOKENS = 50_000_000_000;

function toCount(value) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Coerce an untrusted body into a submission we are willing to sign-check and
 * store. Returns `{ ok: true, value }` or `{ ok: false, error }`.
 *
 * Every failure path here is a rejection, never a silent coercion of identity
 * fields: a bad username or an unknown CLI name means the request is dropped.
 */
export function parseSubmission(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object." };
  }
  if (Number(body.v) !== PROTOCOL_VERSION) {
    return { ok: false, error: `Unsupported protocol version: ${String(body.v)}.` };
  }

  const username = String(body.username ?? "");
  if (!USERNAME_PATTERN.test(username)) {
    return { ok: false, error: "Username must be 1-20 characters of A-Z, a-z, 0-9, _ or -." };
  }

  const deviceId = String(body.device_id ?? "");
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    return { ok: false, error: "Malformed device id." };
  }

  const nonce = String(body.nonce ?? "");
  if (!NONCE_PATTERN.test(nonce)) {
    return { ok: false, error: "Malformed nonce." };
  }

  const totalTokens = toCount(body.total_tokens);
  if (totalTokens === 0) {
    return { ok: false, error: "Nothing to submit yet - no tokens recorded on this machine." };
  }
  if (totalTokens > MAX_TOTAL_TOKENS) {
    return { ok: false, error: "Reported token count exceeds the plausible maximum." };
  }

  const rawClis = body.clis ?? {};
  if (typeof rawClis !== "object" || Array.isArray(rawClis)) {
    return { ok: false, error: "CLI breakdown must be an object." };
  }
  const clis = {};
  for (const [key, value] of Object.entries(rawClis)) {
    if (!KNOWN_SOURCES.includes(key)) {
      return { ok: false, error: `Unknown CLI in breakdown: ${key}.` };
    }
    const count = toCount(value);
    if (count > 0) {
      clis[key] = count;
    }
  }
  if (Object.keys(clis).length === 0) {
    return { ok: false, error: "CLI breakdown was empty." };
  }

  return {
    ok: true,
    value: {
      v: PROTOCOL_VERSION,
      device_id: deviceId,
      username,
      total_tokens: totalTokens,
      requests: toCount(body.requests),
      sessions: toCount(body.sessions),
      cost_micros: toCount(body.cost_micros),
      clis,
      ts: Math.trunc(Number(body.ts)),
      nonce,
      signature: String(body.signature ?? ""),
    },
  };
}
