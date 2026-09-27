/**
 * Runs the real api/submit.js and api/leaderboard.js over HTTP against a local
 * libSQL file, so the Python client can be exercised end to end without Vercel
 * or a Turso account. Used by hand during development; not deployed.
 *
 *   PORT=8787 node scripts/mock-server.mjs
 */
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import submitHandler from "../api/submit.js";
import leaderboardHandler from "../api/leaderboard.js";

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.MOCK_DB ?? join(tmpdir(), "codex-stats-mock.db");

if (process.env.MOCK_FRESH === "1") {
  rmSync(DB_PATH, { force: true });
}

process.env.TURSO_DATABASE_URL = `file:${DB_PATH}`;
process.env.TURSO_AUTH_TOKEN = "";
process.env.LEADERBOARD_SUBMIT_KEY = process.env.LEADERBOARD_SUBMIT_KEY ?? "mock-key";

function toWebRequest(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const query = Object.fromEntries(url.searchParams.entries());
      resolve({ method: req.method, path: url.pathname, body, query });
    });
  });
}

const server = createServer(async (req, res) => {
  const web = await toWebRequest(req);
  const webRes = {
    setHeader: (key, value) => res.setHeader(key, value),
    status(code) {
      res.statusCode = code;
      return webRes;
    },
    json(payload) {
      res.end(JSON.stringify(payload));
      return webRes;
    },
  };
  const handler = web.path === "/api/leaderboard" ? leaderboardHandler : submitHandler;
  try {
    await handler(web, webRes);
  } catch (error) {
    console.error(error);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end();
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock leaderboard listening on http://127.0.0.1:${PORT} (db: ${DB_PATH})`);
});
