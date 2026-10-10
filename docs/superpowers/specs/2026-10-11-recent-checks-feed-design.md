# Recent checks feed + self-hostable server — design

Date: 2026-10-11 · Status: draft for review (rev 2: single self-hosted service, Worker kept as fallback)

## Goal

Show a live, good-looking feed of **recently checked players** (avatar, nickname, Dotabuff link, relative time, repeat count):

- **Home page** — a full feed with a split-flap ("airport board") animation that visitors can scroll and "catch", plus a nickname filter so people can see whether *their* name was checked in the last minute or two.
- **Redirect interstitial** — a one-line teaser, rendered into the HTML itself, that works within the existing 1 s (or 5 s with banner) redirect window and makes people want to open the home page.

To make that simple, the site gains a **second runtime**: a small Node server that runs the same request handler as the Worker, plus the feed in-process. The Cloudflare Worker stays fully supported, but runs without the feed, and is the one-step rollback.

Measured today: ~30–41k requests/day for this site, Saturday peak hour ≈ 4.6k req/h (≈ 78/min).

## Non-goals (v1)

- Accounts or Steam login (owner-verified opt-out comes later if needed).
- Ranks, medals or match data beyond Steam persona name and avatar.
- Showing *who* checked a profile. Only the checked profile is ever shown.
- The feed on the Worker runtime (no Durable Object or hybrid ingest; see Later).
- "Opened together" stack grouping (see Later).

## Architecture

```
src/core.js      runtime-agnostic: parseRoute, ID conversion, Steam resolve, analytics,
                 banners, page renderers, handleRequest(request, env, ctx)
src/feed/        feed module (Node only): store, enrichment, sanitize, SSE, HTTP routes
worker.js        Cloudflare adapter: export default { fetch: (r, env, ctx) => handleRequest(r, env, ctx) }
server.js        Node adapter: node:http ⇄ Web Request/Response, env from process.env,
                 SQLite-backed KV shim, env.FEED = feed instance
```

- `handleRequest(request, env, ctx)` only uses Web-standard APIs (`Request`, `Response`, `URL`, `fetch`, `crypto.subtle`), which both runtimes provide.
- Runtime differences are injected through `env`:

| `env` member | Worker | Node server |
|---|---|---|
| `STEAM_ID_CACHE`, `API_KEY_STATUS` | KV bindings (as today) | SQLite KV shim with the same `get(key)` / `put(key, value, { expirationTtl })` / `delete(key)` surface |
| `FEED` | undefined → feature off | feed instance → hit recording, teaser, `/api/*` routes |
| secrets/vars | Wrangler secrets/vars | process env (`.env` file in compose) |

- `ctx.waitUntil` in Node: the adapter tracks the promise, logs rejections and never delays the response.

Request flow on the Node server:

```
Browser ─HTTPS─▶ Cloudflare proxy ─HTTPS (Full strict, Origin CA cert)─▶ Caddy (CF IPs only)
        ─▶ 127.0.0.1:<port> server.js ─▶ handleRequest
              /id/*, /profiles/*  → resolve → env.FEED.recordHit() (in memory) → redirect HTML with teaser
              /                   → home HTML (static, feed loads client-side)
              /api/recent.json, /api/stream, /healthz → feed module
```

## Component 1 — Core (`src/core.js`)

Mostly a move of today's `worker.js` logic, with these changes:

1. `getId` uses `env.STEAM_ID_CACHE` / `env.API_KEY_STATUS` exactly as today. The shim makes them work in Node.
2. **Hit recording.** After a successful resolution, if `env.FEED` exists and the request looks like a real browser, call `env.FEED.recordHit({ steamId64, ipHash })`. This is synchronous and in memory, and never throws into the request.
   - A real browser means: `GET`, `Accept` contains `text/html`, and the UA does not match `/bot|crawl|spider|preview|discord|telegram|whatsapp|slack|facebookexternalhit|twitterbot|skype|embed/i`.
   - `ipHash` = SHA-256 of `CF-Connecting-IP` + a daily-rotating in-memory salt. It is used for rate limiting only and never stored.
   - Add `toSteamId64` next to `convertToDota2Id` so `/profiles/[U:1:x]` hits are recorded too.
3. **Redirect page teaser** (only when `env.FEED` exists):
   - `env.FEED.teaser(dotaId)` returns `{ hourCount, seen: { lastTs, count } | null, faces }` from memory and is rendered **server-side**. No client fetch, so it is visible on the first frame.
   - Copy, first match wins:
     - the profile being opened was checked in the last hour → "This player was checked 4 min ago · ×3 — see who else →"
     - otherwise → "132 players checked this hour — see if you were →", with up to 3 overlapping 20 px avatars.
   - While the ping banner is shown, the teaser is static text with no animation.
   - Clicking the teaser **cancels the redirect** (clears the JS timer) and opens `/` in the same tab. The existing "Not redirected? Click here" Dotabuff link stays.
   - The `<meta http-equiv="refresh">` fallback moves into `<noscript>` on both runtimes, so the JS timer is the only redirect when JS runs.
   - With the feed on, the redirect response is `Cache-Control: no-store`, because the teaser is live and every visit must reach the origin to be counted. Without the feed it stays `max-age=300` as today.
4. **Home page.** When `env.FEED` exists, render the feed section (Component 3) between the hero and the examples. The HTML stays static; data comes from same-origin `/api/*`.
5. **Routing.** `/api/*` is dispatched to `env.FEED.handle(request)` before `parseRoute`. Without `env.FEED` it falls through to today's behaviour (404 page). `/healthz` and `/assets/*` are served by the Node adapter itself, so `/healthz` answers even with the feed disabled.

## Component 2 — Feed module (`src/feed/`, Node only)

- **Stack:** Node 24 built-ins only (`node:sqlite`, `node:http` via the adapter, `fetch`). Zero runtime dependencies.
- **Config (env):** `STEAM_API_KEY` / `STEAM_API_KEYS` (shared with core), `DB_PATH`, optional `BLOCKED_WORDS_FILE`, optional `HIDDEN_IDS_FILE`.
- **SQLite only.** At this volume (~40k checks/day) indexed SQLite queries (WAL mode) are fast enough, so there is no separate in-memory cache, and a restart loses nothing.

### Data model (SQLite)

```sql
pending (steamid TEXT PRIMARY KEY, first_ts INTEGER, last_ts INTEGER, hits INTEGER)
players (steamid TEXT PRIMARY KEY, name TEXT, avatar_hash TEXT, visible INTEGER, fetched_at INTEGER)
checks  (steamid TEXT, ts INTEGER)            -- one row per accepted hit; purged after 24 h
kv      (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER)  -- KV shim for core
CREATE INDEX checks_ts ON checks(ts);
```

### `recordHit`

- Validates the SteamID64.
- Rate limits: ≤ 20 hits/min per `ipHash` and ≤ 6 hits/min per steamid. Excess is silently dropped.
- Appends to `checks` and upserts `pending`.

### Enrichment tick (every 30 s, only when `pending` is non-empty)

- Takes up to 500 pending ids (5 sequential chunks of 100) and skips ids whose player row is under 6 h old.
- Calls `ISteamUser/GetPlayerSummaries/v2` with a 5 s timeout per call, reusing the core's key rotation and health marking.
- Upserts `players`. `visible = communityvisibilitystate === 3`.
- Removes the processed ids from `pending` in the same transaction.
- On Steam failure, the ids stay pending and the tick backs off: 30 s → 60 s → 120 s, capped at 5 min.
- Broadcasts newly visible entries to SSE clients.

### HTTP

Same origin as the site, so no CORS.

- `GET /api/recent.json` → `{ hourCount, generatedAt, entries }`.
  - `entries` holds the latest 200 distinct visible, non-hidden players from the last 60 min, ordered by last check desc.
  - Each entry: `{ steamId64, dotaId, name, avatarHash, lastTs, count }`.
  - Sent with `Cache-Control: public, max-age=10`, so a Cloudflare cache rule can absorb polling.
- `GET /api/stream` (SSE):
  - On connect it sends `event: snapshot` (the recent payload).
  - It then sends `event: entries` per tick.
  - Heartbeat comment every 25 s.
  - At most 2,000 clients; above that it returns 503 and the client falls back to polling.
- `GET /healthz` (served by the Node adapter) → `{ ok, feed: { pending, lastTickAt, clients } | null }`.

### Hygiene

- **Nicknames are sanitised before storing:**
  - Strip control characters and bidi overrides/isolates (U+202A–202E, U+2066–2069).
  - Keep at most 2 combining marks per base character (anti-zalgo).
  - Cap at 32 graphemes.
  - Words from `BLOCKED_WORDS_FILE` are matched case-insensitively after NFKC and masked with `•`, one bullet per character.
- **Avatars:** only the hash is stored. The client builds `https://avatars.steamstatic.com/{hash}_medium.jpg`.
- **Opt-out:** `HIDDEN_IDS_FILE` holds SteamID64s, one per line, re-read on `SIGHUP`. Listed players never appear. Requests come through the contact or issue link in the README.
- **Retention:** `checks` older than 24 h, `players` unseen for 7 days and expired `kv` rows are purged hourly. IPs are never stored.

## Component 3 — Home page feed UI (client-side, inline in the home page)

Validated with the interactive mockup (split-flap option B plus catch/release).

**Layout:**
- Section "Recently checked" with a LIVE dot and an "N checked this hour" counter.
- A search input.
- A scrollable list about 7 rows tall. Rows are grouped under sticky headers: **Just now** (< 1 min), **Last 5 min**, **Last hour**.
- Row: 36 px avatar, nickname (with an `×N` badge when count ≥ 2), relative time, and a "Dotabuff →" link.

**Links** go straight to `https://www.dotabuff.com/players/{dotaId}`, not through `/profiles/…`, so clicks from the feed never create hits.

**Transport:**
- `EventSource('/api/stream')`.
- If SSE fails, it polls `/api/recent.json` every 30 s ± 5 s.
- While the tab is hidden, SSE is closed and polling stops. On return, the client refetches and merges.

**Drip and upsert:**
- New entries are queued and revealed one at a time, spaced across the expected batch gap (min 400 ms, max 3 s). A backlog beyond 3 items is inserted without animation.
- A player already in the list moves to the top, re-flaps, and updates `×N`.

**Split-flap animation:**
- The row height opens (260 ms).
- Avatar `rotateX` flip-in.
- Nickname glyphs cycle and land left-to-right (≈45 ms per tick).
- Transform/opacity only, no blur or filters (in-game CEF browser).
- `prefers-reduced-motion`: rows simply appear.

**Catch / release:**
- Hovering the list, or scrolling away from the top, pauses the feed. The LIVE dot turns gold. A pill shows "⏸ Paused · N new · back to live ↑" with a countdown bar.
- It resumes after 8 s idle (1.5 s if the cursor leaves while at the top), on scrolling back to the top, or when the pill is clicked.
- On resume it smooth-scrolls to the top and drips the queue.

**Filter / pinned nickname:**
- Words are split on whitespace, normalised with NFKC + lowercase, and match if **any** word is a substring of the nickname. Matches are highlighted via DOM `<mark>` nodes, never `innerHTML`.
- The query is kept in `?q=` and `localStorage`. When a matching entry arrives, the row flashes gold and the tab title gets a "★" prefix until the tab is focused.

**Copy & language:**
- English by default.
- Russian / Ukrainian strings are chosen by `navigator.language`, from a small inline dictionary.

## Component 4 — Packaging & deployment (generic, documented in README)

**Container:**
- `Dockerfile`: `node:24-alpine`, runs as the non-root `node` user, `HEALTHCHECK` → `/healthz`.
- `/data` volume for SQLite.
- `CMD ["node", "server.js"]`.

**`docker-compose.example.yml`:**
- Port bound to `127.0.0.1` only.
- `env_file: .env`, `restart: unless-stopped`.
- Resource limits (`cpus: 1`, `mem_limit: 256m`) so traffic spikes cannot starve other services on the host.

**Reverse proxy example (Caddy):**
- TLS with a Cloudflare Origin CA certificate.
- Requests not from Cloudflare IP ranges get a 403 (`remote_ip` matcher).
- `reverse_proxy` with `flush_interval -1` so SSE streams unbuffered.

**Cloudflare:**
- DNS record proxied (orange cloud).
- SSL mode **Full (strict)** for the hostname. Flexible causes an HTTPS redirect loop.
- Optional cache rule for `/api/recent.json`.

**Switching runtimes:**
- The Worker route in `wrangler.toml` takes precedence over the origin. To serve from the Node server, remove the Worker route in the dashboard.
- **Rollback** = `wrangler deploy`, which re-creates the route. The site then serves from the edge again, without the feed.
- The README documents this explicitly, including that any Worker deploy re-enables the route.

**Monitoring:** an uptime check on `/healthz` (any external monitor). Documented as recommended.

**No deployment-specific values in the repo:** hostnames, IPs and keys live only in the deployment's `.env` / Wrangler secrets. Docs use `feed.example.com` / `example.com` placeholders.

## Capacity estimate

| Item | Volume (Saturday peak) | Note |
|---|---|---|
| Requests to origin | ≈ 40k/day, ≈ 1.3/s peak, plus feed reads | trivial for one Node process |
| Steam `GetPlayerSummaries` | ≤ 2/min → ≤ 2.9k/day (fewer with the 6 h cache) | limit 100k/day per key |
| SSE clients | tens to low hundreds concurrent | capped at 2,000 |
| Workers quota | this site's share (~40k/day) leaves the account's 100k/day free quota | headroom for the other Workers |

## Testing

- **Core (`test/core.test.js`, `node --test`):**
  - The existing `worker.test.js` cases move here unchanged.
  - New cases:
    - bot-UA filter;
    - `toSteamId64`;
    - `/api/*` routing with and without `env.FEED`;
    - redirect page: teaser rendered only with a feed, meta refresh inside `<noscript>`, `no-store` only with a feed;
    - home page feed section only with a feed.
- **Feed (`test/feed.test.js`):**
  - Sanitiser (bidi, zalgo, blocked words).
  - Rate limits.
  - Tick with mocked Steam: chunking > 100, private profiles dropped, backoff, atomic pending removal.
  - `/api/recent.json` shape and counts.
  - SSE snapshot and broadcast.
  - Hidden-ids reload.
- **Adapters (`test/server.test.js`):**
  - Boots `server.js` on an ephemeral port with a temp DB.
  - Hits `/`, `/profiles/{id}` and `/api/recent.json`.
  - KV shim TTL expiry.
- **Worker:** `wrangler dev` smoke test, confirming the Worker build still works with no feed.
- **Manual:**
  - `docker compose up` locally.
  - Verify redirect timing is unchanged, the teaser click cancels the redirect, catch/release, filter highlight and reduced-motion.
  - Smoke-test in the Dota in-game browser.

## Docs

- `README.md`:
  - Update the overview: two runtimes (Cloudflare Worker, or self-hosted Node server with the feed).
  - New "Self-hosting" section: Docker, reverse proxy, Cloudflare settings, switching and rollback.
  - New "Recent checks feed" section: what it shows, privacy and retention, opt-out.
- `.env.example` for the server and an updated `.dev.vars.example` for the Worker.
- New `CHANGELOG.md` (Keep a Changelog) with an *Unreleased → Added / Changed* entry.

## Later (explicitly out of v1)

- The feed on the Worker runtime (Durable Object, or hybrid ingest to a remote feed).
- "Opened together" grouping: ≥ 4 distinct profiles within ~10 s collapse into one block.
- A Battle Cup header mode when checks/min spike.
- Owner-verified opt-out via Steam OpenID.
