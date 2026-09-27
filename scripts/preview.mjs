/**
 * Full local preview: serves public/ as static files and mounts the real API
 * handlers against a local libSQL file. No Turso account and no Vercel needed.
 *
 *   npm run preview            # http://127.0.0.1:4173
 *   npm run preview -- --fresh # wipe and reseed the sample board
 *
 * The sample rows are inserted straight into SQLite rather than signed and
 * submitted, because they represent other people's machines. Everything the
 * browser reads still comes through the real api/leaderboard.js.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve } from "node:path";
import { createClient } from "@libsql/client";

import submitHandler from "../api/submit.js";
import leaderboardHandler from "../api/leaderboard.js";
import { ensureSchema } from "../lib/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, "..", "public");
const PORT = Number(process.env.PORT ?? 4173);
const DB_PATH = process.env.PREVIEW_DB ?? join(tmpdir(), "codex-stats-preview.db");
const FRESH = process.argv.includes("--fresh");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

if (FRESH) {
  rmSync(DB_PATH, { force: true });
}
process.env.TURSO_DATABASE_URL = `file:${DB_PATH}`;
process.env.TURSO_AUTH_TOKEN = "";
process.env.LEADERBOARD_SUBMIT_KEY = process.env.LEADERBOARD_SUBMIT_KEY ?? "preview-key";

/** name, tokens, requests, sessions, cost, clis, daysAgoSubmitted */
const SAMPLE = [
  ["ada", 1245884301, 8214, 612, 684.12, { codex: 702118440, opencode: 301220118, claude: 242545743 }, 0],
  ["grace_hopper", 1102449008, 7490, 588, 601.77, { claude: 903118220, codex: 199330788 }, 1],
  ["linus", 968421770, 11203, 934, 402.18, { codex: 968421770 }, 2],
  ["margaret", 742118904, 5102, 401, 388.44, { opencode: 512004118, claude: 230114786 }, 3],
  ["ken_thompson", 655330192, 4488, 372, 291.07, { codex: 402118004, claude: 253212188 }, 5],
  ["radia", 588904417, 3901, 298, 244.63, { opencode: 388904417, hermes: 200000000 }, 4],
  ["barbara", 421776310, 3102, 244, 198.29, { claude: 421776310 }, 6],
  ["dennis", 356204118, 2210, 187, 142.87, { codex: 256204118, opencode: 100000000 }, 8],
  ["katherine", 288119004, 1988, 165, 121.44, { claude: 188119004, opencode: 100000000 }, 7],
  ["tony", 214886320, 1602, 132, 98.71, { codex: 214886320 }, 9],
  ["anita", 176430911, 1288, 104, 74.22, { opencode: 176430911 }, 11],
  ["jean", 118204776, 903, 78, 52.18, { claude: 118204776 }, 10],
];

async function seed() {
  await ensureSchema();
  const db = createClient({ url: `file:${DB_PATH}` });
  const existing = await db.execute("SELECT COUNT(*) AS n FROM entries");
  if (Number(existing.rows[0].n) > 0) {
    return false;
  }
  const now = Date.now();
  for (const [username, totalTokens, requests, sessions, cost, clis, daysAgo] of SAMPLE) {
    const updated = new Date(now - daysAgo * 86_400_000).toISOString();
    const created = new Date(now - (daysAgo + 40) * 86_400_000).toISOString();
    await db.execute({
      sql: `INSERT INTO entries (device_id, username, total_tokens, requests, sessions, cost_micros, clis, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        createClientDeviceId(username),
        username,
        totalTokens,
        requests,
        sessions,
        Math.round(cost * 1_000_000),
        JSON.stringify(clis),
        created,
        updated,
      ],
    });
  }
  return true;
}

/** Stable stand-in for a per-machine HMAC id; the real one is derived in Python. */
function createClientDeviceId(username) {
  let hash = 0x811c9dc5;
  for (const char of username) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").repeat(4);
}

function readBody(req) {
  return new Promise((done) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        return done(null);
      }
      try {
        done(JSON.parse(raw));
      } catch {
        done(raw);
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname.startsWith("/api/")) {
    const body = await readBody(req);
    const query = Object.fromEntries(url.searchParams.entries());
    const handler = url.pathname === "/api/leaderboard" ? leaderboardHandler : submitHandler;
    try {
      await handler({ method: req.method, path: url.pathname, body, query }, {
        setHeader: (key, value) => res.setHeader(key, value),
        status(code) {
          res.statusCode = code;
          return this;
        },
        json(payload) {
          res.end(JSON.stringify(payload));
          return this;
        },
      });
    } catch (error) {
      console.error(error);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end("{}");
      }
    }
    return;
  }

  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = join(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  res.setHeader("Content-Type", CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream");
  res.end(readFileSync(filePath));
});

const seeded = await seed();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Leaderboard preview on http://127.0.0.1:${PORT}`);
  console.log(`  database: ${DB_PATH}`);
  console.log(seeded ? `  seeded ${SAMPLE.length} sample entries` : "  existing data reused (pass --fresh to reseed)");
});
