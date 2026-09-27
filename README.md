# codex-stats-leaderboard

The public board for [codex-stats](https://github.com/) all-time token totals, plus the
signed endpoint that accepts submissions.

```
codex-stats (local Python)            this app                     Turso
  reads ~/.codex, ~/.claude, ...
  computes totals in memory
  HMAC-signs with a shared key  ──▶  POST /api/submit  ──▶  upsert by device_id
  browser only ever sends a name       verify signature            one row per machine
                                        reject stale/forged        ORDER BY tokens DESC
  GET /api/leaderboard  ◀──  renders the board
```

## Why it is built this way

**The dashboard is never trusted with a number.** The HTML that `codex-stats` writes to a
temp file and opens over `file://` is fully readable by anyone who has it. So the page can
only send a username. The token totals are read out of the already-computed
`DashboardData` object inside the Python process, and the loopback endpoint that the page
talks to is the only thing that can read them.

**The shared key never reaches a browser.** It lives in the submitter's environment and in
this app's server environment. The page has no key, so there is nothing in the HTML to
steal, and a forged request cannot produce a valid signature.

**Signatures cover every field.** The HMAC spans the version, device id, username, totals,
cost, CLI breakdown, timestamp, and nonce. Changing any one of them invalidates it. The
comparison is constant-time.

**Cost is zero.** Turso's free plan allows 100 databases and 5GB of storage, which is
several orders of magnitude more than a leaderboard needs. Note that on the free plan,
exceeding a limit blocks the database rather than billing you, so there is no surprise
invoice, but also no overage.

## What is and is not protected

| | |
| --- | --- |
| A third party submitting numbers without the key | Blocked. No valid signature. |
| Editing the generated HTML to inflate a total | Useless. The browser's numbers are discarded. |
| Replaying a captured request | Blocked after 5 minutes by the timestamp window. |
| Truncating your local history to deflate a row | Blocked. All-time totals may only grow. |
| A mismatch between the total and the per-CLI breakdown | Blocked. They must sum exactly. |
| Someone patching their own copy of `codex-stats` | **Not blocked.** They can inflate their own row. |

That last row is the honest limit. The key is a shared secret distributed to users, so it
cannot also function as an anti-cheat device. What the design does buy you is that nobody
can inflate *your* number, and deflation and forgery are both closed off.

## Setup

### 1. Database

Create a database at [app.turso.tech](https://app.turso.tech), then:

```bash
npm install
cp .env.example .env
# fill in TURSO_DATABASE_URL and TURSO_AUTH_TOKEN
npm run init-db
```

The API also runs this DDL lazily on first request, so `init-db` is optional.

### 2. Shared key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set the result as `LEADERBOARD_SUBMIT_KEY` in this app's environment. Contributors set the
same value as `CODEX_STATS_LEADERBOARD_KEY`.

Because the key identifies contributors rather than protecting the public read path, it
does not need to be a secret from the board's viewers — only from people who are not
contributors.

### 3. Deploy

```bash
npx vercel --prod
npx vercel env add TURSO_DATABASE_URL production
npx vercel env add TURSO_AUTH_TOKEN production
npx vercel env add LEADERBOARD_SUBMIT_KEY production
```

## Endpoints

### `POST /api/submit`

Signed submissions only. The signature is checked before any database work, so forged
requests cost nothing and cannot consume rows-written quota.

```jsonc
{
  "v": 1,
  "device_id": "<32 hex>",       // HMAC of the local MAC; never the MAC itself
  "username": "ada_lovelace",    // [A-Za-z0-9_-]{1,20}
  "total_tokens": 619280282,
  "requests": 1129,
  "sessions": 78,
  "cost_micros": 310793800,      // integer, to avoid float disagreement
  "clis": { "claude": 256742158, "opencode": 233718986, "codex": 128819138 },
  "ts": 1780000000,
  "nonce": "<32 hex>",
  "signature": "<64 hex>"
}
```

The signed message is pipe-delimited rather than JSON so the Python and JavaScript
runtimes cannot disagree about key order, float formatting, or unicode escaping:

```
1|<device_id>|<username>|<tokens>|<requests>|<sessions>|<cost_micros>|<k:v,k:v>|<ts>|<nonce>
```

Responses: `200` accepted, `400` malformed, `401` bad signature or stale timestamp,
`409` lower than the stored total, `503` not configured.

### `GET /api/leaderboard?limit=50&offset=0`

Public and unauthenticated. `limit` is capped at 100. Rows are returned in
`total_tokens DESC, created_at ASC` order, so ties go to whoever joined first. The
`device_id` is never included in the response.

## Tests

```bash
npm test
```

`scripts/e2e-check.mjs` runs the real handlers against a local libSQL file and signs every
payload with the actual Python implementation, so it fails if the two sides of the wire
format ever drift apart. It covers acceptance, upsert-in-place, renaming, the monotonic
guard, tampering with each signed field, replay, breakdown consistency, unknown CLI names,
paging, and the guarantee that no device id or signature leaks into the public payload.

## Local development

```bash
npm run dev                      # Vercel dev server
PORT=8787 npm run mock           # just the API, on a local libSQL file
```

The mock server exists so the Python client can be exercised end to end without a Turso
account:

```bash
CODEX_STATS_LEADERBOARD_URL=http://127.0.0.1:8787 \
CODEX_STATS_LEADERBOARD_KEY=mock-key \
codex-stats
```
