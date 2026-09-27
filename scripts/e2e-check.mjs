/**
 * End-to-end check of the server path without Vercel or Turso.
 *
 * libSQL speaks the `file:` URL locally, so the real handlers, the real schema,
 * the real upsert, and the real signature verification all run here. Payloads are
 * signed by the Python side, so this also proves the two runtimes agree.
 *
 *   node scripts/e2e-check.mjs
 */
import { rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { createClient } from "@libsql/client";

import submitHandler from "../api/submit.js";
import leaderboardHandler from "../api/leaderboard.js";
import logHandler from "../api/log.js";
import { readLog, appendLogWithHead } from "../lib/db.js";
import { entryHash, verifyChain } from "../lib/chain.js";

const KEY = "e2e-shared-key";
const DB_PATH = join(tmpdir(), `codex-stats-e2e-${process.pid}.db`);

// The codex-stats checkout is expected to sit next to this app. Override with
// CODEX_STATS_SRC if it lives somewhere else.
const here = dirname(fileURLToPath(import.meta.url));
const PYTHON_SRC = process.env.CODEX_STATS_SRC ?? resolve(here, "..", "..", "codex_stats", "src");
if (!existsSync(PYTHON_SRC)) {
  console.error(`Could not find the codex-stats sources at ${PYTHON_SRC}.`);
  console.error("Set CODEX_STATS_SRC to the src directory of the codex-stats checkout.");
  process.exit(1);
}

rmSync(DB_PATH, { force: true });
process.env.TURSO_DATABASE_URL = `file:${DB_PATH}`;
process.env.TURSO_AUTH_TOKEN = "";
process.env.LEADERBOARD_SUBMIT_KEY = KEY;
// This script fires many signed submissions from a single address, which is
// exactly the traffic the production rate limit exists to throttle. Raise it
// rather than let unrelated assertions fail on a 429.
process.env.RATE_LIMIT_PER_IP = "1000";

let failures = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label} ${detail}`);
  }
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) {
      this.headers[key.toLowerCase()] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

async function callSubmit(payload) {
  const res = mockRes();
  await submitHandler({ method: "POST", body: payload }, res);
  return res;
}

async function callLeaderboard(query = {}) {
  const res = mockRes();
  await leaderboardHandler({ method: "GET", query }, res);
  return res;
}

/**
 * Sign a submission with the real Python implementation.
 *
 * `mac` stands in for the submitting machine: the device id is an HMAC of the
 * local MAC address, so two different MACs are two different leaderboard rows.
 */
function signWithPython({ username, tokens, clis, ts, mac }) {
  const script = `
import json, sys, uuid
sys.path.insert(0, ${JSON.stringify(PYTHON_SRC)})
_mac = ${mac === undefined ? "None" : JSON.stringify(mac)}
if _mac is not None:
    uuid.getnode = lambda: int(_mac, 16)
from codex_stats.leaderboard import LocalStats, build_submission_payload
stats = LocalStats(
    total_tokens=${tokens},
    requests=12,
    sessions=3,
    cost_micros=250000,
    clis=json.loads(${JSON.stringify(JSON.stringify(clis))}),
)
payload = build_submission_payload(
    submit_key=${JSON.stringify(KEY)}.encode("utf-8"),
    stats=stats,
    username=${JSON.stringify(username)},
    now=${ts},
)
print(json.dumps(payload))
`;
  const out = execFileSync("python3", ["-c", script], { encoding: "utf8" });
  return JSON.parse(out);
}

const ADA_MAC = "a00a00000001";
const BOB_MAC = "b00b00000002";
const now = Math.floor(Date.now() / 1000);

console.log("\n1. Python-signed submission is accepted");
const ada = signWithPython({ username: "ada_lovelace", tokens: 1500, clis: { codex: 900, opencode: 600 }, ts: now, mac: ADA_MAC });
let res = await callSubmit(ada);
check("status 200", res.statusCode === 200, JSON.stringify(res.body));
check("ok true", res.body?.ok === true, JSON.stringify(res.body));
check("rank 1", res.body?.rank === 1, JSON.stringify(res.body));
check("totalTokens echoed", res.body?.totalTokens === 1500, JSON.stringify(res.body));
check("welcome message for a new entry", /Welcome/.test(res.body?.updated ?? ""), res.body?.updated);

console.log("\n2. A second machine is a separate row");
const bob = signWithPython({ username: "bob", tokens: 9000, clis: { claude: 9000 }, ts: now, mac: BOB_MAC });
res = await callSubmit(bob);
check("status 200", res.statusCode === 200, JSON.stringify(res.body));
check("rank 1", res.body?.rank === 1, JSON.stringify(res.body));
let board = await callLeaderboard();
check("two entries on the board", board.body?.total === 2, JSON.stringify(board.body?.total));

console.log("\n3. Re-submitting from the same machine updates its row");
res = await callSubmit(
  signWithPython({ username: "ada_lovelace", tokens: 1600, clis: { codex: 900, opencode: 700 }, ts: now, mac: ADA_MAC }),
);
check("status 200", res.statusCode === 200, JSON.stringify(res.body));
check("rank 2", res.body?.rank === 2, JSON.stringify(res.body));
check("message says updated", /updated/.test(res.body?.updated ?? ""), res.body?.updated);
board = await callLeaderboard();
check("still exactly 2 entries", board.body?.total === 2, JSON.stringify(board.body?.total));

console.log("\n4. A larger total from the same machine moves it up");
res = await callSubmit(
  signWithPython({ username: "ada_lovelace", tokens: 20000, clis: { codex: 900, opencode: 19100 }, ts: now, mac: ADA_MAC }),
);
check("status 200", res.statusCode === 200, JSON.stringify(res.body));
check("rank 1 now", res.body?.rank === 1, JSON.stringify(res.body));

console.log("\n5. A smaller total is rejected and the record is preserved");
res = await callSubmit(signWithPython({ username: "ada_lovelace", tokens: 5, clis: { codex: 5 }, ts: now, mac: ADA_MAC }));
check("status 409", res.statusCode === 409, JSON.stringify(res.body));
check("explains why", /lower than your previous/.test(res.body?.error ?? ""), res.body?.error);
board = await callLeaderboard();
check("total still 20000", board.body?.entries?.[0]?.totalTokens === 20000, JSON.stringify(board.body?.entries?.[0]));

console.log("\n5b. The same machine may rename itself");
res = await callSubmit(signWithPython({ username: "ada", tokens: 21000, clis: { codex: 900, opencode: 20100 }, ts: now, mac: ADA_MAC }));
check("status 200", res.statusCode === 200, JSON.stringify(res.body));
board = await callLeaderboard();
check("username updated in place", board.body?.entries?.[0]?.username === "ada", JSON.stringify(board.body?.entries?.[0]?.username));
check("still 2 entries", board.body?.total === 2, JSON.stringify(board.body?.total));

console.log("\n6. A tampered payload is rejected");
const forged = signWithPython({ username: "mallory", tokens: 100, clis: { codex: 100 }, ts: now, mac: ADA_MAC });
forged.total_tokens = 999_999_999;
res = await callSubmit(forged);
check("inflated total rejected", res.statusCode === 401, JSON.stringify(res.body));

const impersonate = signWithPython({ username: "ada", tokens: 21000, clis: { codex: 900, opencode: 20100 }, ts: now, mac: ADA_MAC });
impersonate.device_id = "0".repeat(32);
res = await callSubmit(impersonate);
check("swapped device id rejected", res.statusCode === 401, JSON.stringify(res.body));

const stolen = signWithPython({ username: "mallory", tokens: 100, clis: { codex: 100 }, ts: now, mac: ADA_MAC });
stolen.username = "not a valid name";
res = await callSubmit(stolen);
check("invalid username rejected", res.statusCode === 400, JSON.stringify(res.body));

const reCosted = signWithPython({ username: "mallory", tokens: 100, clis: { codex: 100 }, ts: now, mac: ADA_MAC });
reCosted.cost_micros = 0;
res = await callSubmit(reCosted);
check("edited cost rejected", res.statusCode === 401, JSON.stringify(res.body));

console.log("\n7. Replay protection");
const replayed = signWithPython({ username: "carol", tokens: 300, clis: { codex: 300 }, ts: now - 4000, mac: "c0cc00000003" });
res = await callSubmit(replayed);
check("stale timestamp rejected", res.statusCode === 401, JSON.stringify(res.body));
check("error mentions the window", /timestamp/.test(res.body?.error ?? ""), res.body?.error);

console.log("\n8. A breakdown that does not match the total is rejected");
const mismatched = signWithPython({ username: "dave", tokens: 500, clis: { codex: 400 }, ts: now, mac: "da0e00000004" });
res = await callSubmit(mismatched);
check("status 400", res.statusCode === 400, JSON.stringify(res.body));
check("error names both numbers", /400/.test(res.body?.error ?? "") && /500/.test(res.body?.error ?? ""), res.body?.error);

console.log("\n9. Unknown CLI names are rejected");
const unknownCli = signWithPython({ username: "erin", tokens: 10, clis: { codex: 10 }, ts: now, mac: "e71000000005" });
unknownCli.clis = { totallynotacli: 10 };
res = await callSubmit(unknownCli);
check("status 400", res.statusCode === 400, JSON.stringify(res.body));

console.log("\n10. The public board reads back in rank order");
board = await callLeaderboard();
check("status 200", board.statusCode === 200);
check("two entries", board.body?.total === 2, JSON.stringify(board.body?.total));
check("descending by tokens", board.body?.entries?.[0]?.totalTokens > board.body?.entries?.[1]?.totalTokens);
check("first is ada at 21000", board.body?.entries?.[0]?.username === "ada" && board.body?.entries?.[0]?.totalTokens === 21000, JSON.stringify(board.body?.entries?.[0]));
check("clis survive the round trip", JSON.stringify(board.body?.entries?.[0]?.clis) === JSON.stringify({ codex: 900, opencode: 20100 }), JSON.stringify(board.body?.entries?.[0]?.clis));
check("cost is returned in dollars", board.body?.entries?.[0]?.costUsd === 0.25, JSON.stringify(board.body?.entries?.[0]?.costUsd));
check("no device id is exposed", !JSON.stringify(board.body).includes("device_id"), "device id leaked into the public payload");
check("no signature is exposed", !JSON.stringify(board.body).includes("signature"), "signature leaked into the public payload");

console.log("\n11. Paging and method guards");
const paged = await callLeaderboard({ limit: "1", offset: "1" });
check("limit respected", paged.body?.entries?.length === 1, JSON.stringify(paged.body?.entries?.length));
check("offset respected", paged.body?.entries?.[0]?.rank === 2, JSON.stringify(paged.body?.entries?.[0]?.rank));
const capped = await callLeaderboard({ limit: "9999" });
check("limit is capped at 100", capped.body?.limit === 100, JSON.stringify(capped.body?.limit));
const wrongMethod = mockRes();
await leaderboardHandler({ method: "POST", query: {} }, wrongMethod);
check("leaderboard rejects POST", wrongMethod.statusCode === 405);
const submitGet = mockRes();
await submitHandler({ method: "GET", body: null }, submitGet);
check("submit rejects GET", submitGet.statusCode === 405);

const client = createClient({ url: `file:${DB_PATH}` });
const rows = await client.execute("SELECT COUNT(*) AS n FROM entries");
check("database holds exactly 2 rows", Number(rows.rows[0].n) === 2, JSON.stringify(rows.rows[0]));

console.log("\n12. Audit log and hash chain");
async function callLog(query = {}) {
  const res = mockRes();
  await logHandler({ method: "GET", query }, res);
  return res;
}

const log = await callLog();
const chain = log.body?.chain;
// Five accepted: ada 1500, bob 9000, ada 1600, ada 20000, ada 21000. The 409
// downgrade is rejected before it is logged, so it must not appear here.
check("log records every accepted submission", log.body?.total === 5, JSON.stringify(log.body?.total));
check("chain verifies intact", chain?.intact === true, JSON.stringify(chain));
check("the response says how much of the chain it actually checked", chain?.entriesVerified === log.body?.total, JSON.stringify(chain));
check("and that the check reached the end of the log", chain?.verdictReachedEnd === true, JSON.stringify(chain));
check("genesis entry links to all zeroes", log.body?.entries?.[0]?.prevHash === "0".repeat(64), log.body?.entries?.[0]?.prevHash);
const links = (log.body?.entries ?? []).every((entry, i, all) => i === 0 || entry.prevHash === all[i - 1].entryHash);
check("every entry hashes the previous one", links);
check("entry hashes are 64 hex chars", (log.body?.entries ?? []).every((e) => /^[0-9a-f]{64}$/.test(e.entryHash)));
check("log does not expose device ids", !JSON.stringify(log.body).includes("device_id"));
const logPost = mockRes();
await logHandler({ method: "POST", query: {} }, logPost);
check("log rejects POST", logPost.statusCode === 405);

// Snapshot the chain so the tamper scenarios below can be run independently
// instead of each one building on whatever the last left behind. The earlier
// version deleted the first row to test mid-chain removal and then deleted
// everything to test tail removal, so the "prefix" case never had a prefix.
const snapshot = await readLog(100, 0);
async function restoreLog() {
  await client.execute("DELETE FROM submission_log");
  for (const row of snapshot) {
    await client.execute({
      sql: `INSERT INTO submission_log
            (seq, device_id, username, total_tokens, requests, sessions, cost_micros, clis, recorded_at, prev_hash, entry_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [Number(row.seq), row.device_id, row.username, Number(row.total_tokens), Number(row.requests),
             Number(row.sessions), Number(row.cost_micros), row.clis, row.recorded_at, row.prev_hash, row.entry_hash],
    });
  }
}
check("snapshot captured for independent tamper tests", snapshot.length === 5, `${snapshot.length} rows`);

// Tail truncation: remove the last entry and the remaining prefix still verifies,
// because a prefix of a valid chain is itself a valid chain. This is a property of
// hash chains generally, not a bug, so it is pinned here and stated in the API note
// and the page footer rather than left as a surprise.
const lastEntry = snapshot.at(-1);
await client.execute({ sql: "DELETE FROM submission_log WHERE seq = ?", args: [Number(lastEntry.seq)] });
const tailGone = await callLog();
check("dropping entries from the end is NOT detectable (known limit)", tailGone.body?.chain?.intact === true, JSON.stringify(tailGone.body?.chain));
check("a real prefix still verifies, not an empty log", tailGone.body?.chain?.verified === snapshot.length - 1, JSON.stringify(tailGone.body?.chain));
check("the shortened chain still links end to end", (tailGone.body?.entries ?? []).every((e, i, all) => i === 0 || e.prevHash === all[i - 1].entryHash));

// The fix for that needs the head published somewhere immutable, and there is no
// such field anywhere in the log or the response. Assert its absence.
check("no head anchor is published, which is the actual gap", !JSON.stringify(tailGone.body).match(/"(head|anchor|checkpoint)Hash"/i), "no externally anchored head");
await restoreLog();

// Editing a logged total directly, the way an operator trying to hide something
// would, must be caught at that exact sequence number.
const victim = snapshot[0];
await client.execute({ sql: "UPDATE submission_log SET total_tokens = ? WHERE seq = ?", args: [999_999_999, Number(victim.seq)] });
const tampered = await callLog();
check("tampering with a logged total is detected", tampered.body?.chain?.intact === false, JSON.stringify(tampered.body?.chain));
check("the break is pinned to a sequence number", tampered.body?.chain?.brokenAt === Number(victim.seq), JSON.stringify(tampered.body?.chain));
await restoreLog();

// Deleting an entry from the middle breaks the links either side of it: the next
// entry's prev_hash no longer matches anything.
await client.execute({ sql: "DELETE FROM submission_log WHERE seq = ?", args: [Number(victim.seq)] });
const deleted = await callLog();
check("removing a mid-chain entry is detected", deleted.body?.chain?.intact === false, JSON.stringify(deleted.body?.chain));
check("the break points at the entry that should have been there", deleted.body?.chain?.verified === 0, JSON.stringify(deleted.body?.chain));
await restoreLog();

// A server-side fork would be indistinguishable from tampering, so the database
// refuses to record one: prev_hash is unique, because a linear chain gives every
// entry a distinct parent. Two concurrent submissions that read the same head
// would otherwise both insert, and the chain would break itself.
const forkRecord = { device_id: "fork", username: "fork", total_tokens: 1, requests: 1, sessions: 1, cost_micros: 0, clis: { codex: 1 }, recorded_at: new Date().toISOString() };
let forkRejected = false;
try {
  await client.execute({
    sql: `INSERT INTO submission_log
          (device_id, username, total_tokens, requests, sessions, cost_micros, clis, recorded_at, prev_hash, entry_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: ["fork", "fork", 1, 1, 1, 0, JSON.stringify({ codex: 1 }), forkRecord.recorded_at,
           String(snapshot[0].prev_hash), entryHash(String(snapshot[0].prev_hash), forkRecord)],
  });
} catch (error) {
  forkRejected = /UNIQUE constraint failed/i.test(String(error?.message ?? ""));
}
check("two entries claiming the same parent are rejected", forkRejected, "prev_hash is unique, so a concurrent race cannot fork the chain");
const afterFork = await callLog();
check("the chain is still intact after the rejected fork", afterFork.body?.chain?.intact === true, JSON.stringify(afterFork.body?.chain));
check("genesis is still the only entry using the genesis prev_hash", afterFork.body?.chain?.verified === snapshot.length, JSON.stringify(afterFork.body?.chain));

console.log("\n13. Concurrent appends cannot fork the chain");
await restoreLog();
// A real request path would serialise on a transaction. This one cannot, because
// the entry hash is computed in JavaScript from the head, so the head read and
// the insert are necessarily separate. The UNIQUE index on prev_hash plus a
// jittered retry is what stops that becoming a fork. Before the backoff was
// added, 40 simultaneous appends left 5 through and failed the rest; the chain
// stayed valid, but most submissions were lost.
const racers = 60;
const raceResults = await Promise.allSettled(
  Array.from({ length: racers }, (_, i) =>
    appendLogWithHead(
      { device_id: `race${i}`, username: `race${i}`, total_tokens: i + 1, requests: 1, sessions: 1, cost_micros: 0, clis: { codex: i + 1 }, recorded_at: new Date().toISOString() },
      entryHash,
    ),
  ),
);
const raced = raceResults.filter((r) => r.status === "fulfilled").length;
const worstAttempts = Math.max(...raceResults.filter((r) => r.status === "fulfilled").map((r) => r.value.attempts));
check("every simultaneous append lands", raced === racers, `${raced}/${racers}`);
check("a losing race retries rather than failing", worstAttempts > 1, `worst case ${worstAttempts} attempts`);
const racedRows = await readLog(1000, 0);
const racedVerdict = verifyChain(racedRows);
check("the chain is still intact after the burst", racedVerdict.ok === true, JSON.stringify(racedVerdict));
check("every entry has a distinct parent", new Set(racedRows.map((r) => r.prev_hash)).size === racedRows.length, `${racedRows.length} entries`);
await restoreLog();

console.log("\n14. Rate limiting");
const savedLimit = process.env.RATE_LIMIT_PER_IP;
process.env.RATE_LIMIT_PER_IP = "2";
const rl = createClient({ url: `file:${DB_PATH}` });
await rl.execute("DELETE FROM rate_limits");
const burst = [];
for (let i = 0; i < 4; i += 1) {
  burst.push(await callSubmit(signWithPython({ username: "burst", tokens: 100 + i, clis: { codex: 100 + i }, ts: now, mac: "c00c00000003" })));
}
check("requests past the limit are throttled", burst[3].statusCode === 429, JSON.stringify(burst.map((b) => b.statusCode)));
check("throttled request says why", /too many/i.test(burst[3].body?.error ?? ""), burst[3].body?.error);
check("requests under the limit still succeed", burst[0].statusCode === 200 && burst[1].statusCode === 200, JSON.stringify(burst.map((b) => b.statusCode)));
process.env.RATE_LIMIT_PER_IP = savedLimit;

rmSync(DB_PATH, { force: true });
console.log(failures === 0 ? "\nAll end-to-end checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
