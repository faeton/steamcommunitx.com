# Recent checks feed — design

Date: 2026-10-11 · Status: draft for review

## Goal

Show a live, good-looking feed of **recently checked players** (avatar, nickname, Dotabuff link, relative time, repeat count):

- **Home page** — a full feed with a split-flap ("airport board") animation that visitors can scroll and "catch", plus a nickname filter so people can see whether *their* name was checked in the last minute or two.
- **Redirect interstitial** — a one-line teaser that works within the existing 1 s (or 5 s with banner) redirect window and makes people want to open the home page.

Expected peak: Saturday evenings (Battle Cup). Measured today: ~30–41k Worker requests/day for this site, peak hour ≈ 4.6k req/h (≈ 78/min).

## Non-goals (v1)

- Accounts or Steam login (owner-verified opt-out comes later if needed).
- Ranks, medals, match stats or any data beyond Steam persona name and avatar.
- Showing *who* checked a profile. Only the checked profile is ever shown.
- "Opened together" stack grouping (see Later).

## Architecture

The redirect stays on the Cloudflare Worker. The feed is a separate, **optional, self-hosted module** (`feed/`) that a deployment can run anywhere (any host with Docker behind a reverse proxy). When the Worker has no feed configuration, nothing changes: no hit is sent, no teaser is rendered, and the home page shows no feed section.

```
Browser ──GET /profiles/X──▶ Worker ──302-style HTML (unchanged)──▶ Browser
                               │ ctx.waitUntil(POST {FEED_URL}/hit)   (subrequest, 1.5 s timeout)
                               ▼
                       Feed service (feed/, Node + SQLite)
                         • pending queue → every 30 s GetPlayerSummaries (≤100 ids per call)
                         • GET /recent.json        (public, cacheable 10 s)
                         • GET /teaser/{dotaId}.json (public, cacheable 10 s)
                         • GET /stream             (SSE, live push)
                               ▲
Home page / teaser JS ─────────┘  (direct to FEED_PUBLIC_URL, never through the Worker)
```

Why this split:

- Worker → feed is a **subrequest**, so it does not count against the Workers daily request quota. Browser → feed traffic goes to the feed host (optionally through a CDN proxy) and never invokes the Worker. Net Worker-request cost of the feature ≈ 0.
- Feed-host downtime cannot break redirects. The hit is fire-and-forget inside `waitUntil` with a short timeout, and the teaser/feed simply don't render.
- Plain SQLite with no per-row-write billing, and SSE for real-time push instead of polling.

## Component 1 — Worker changes (`worker.js`)

Config (all optional; the feature is off unless both `FEED_URL` and `FEED_TOKEN` are valid):

| Name | Kind | Purpose |
|---|---|---|
| `FEED_URL` | secret | Ingest base URL, `https://…`, validated like `BANNER_SRC_RE`. |
| `FEED_TOKEN` | secret | Bearer token for `POST /hit`. |
| `FEED_PUBLIC_URL` | secret | Public base URL the browser uses (may equal `FEED_URL`). Validated, then inlined into HTML. |

Behaviour:

1. `fetch(request, env, ctx)` passes `ctx` to `handleRequest`.
2. After a successful ID resolution (the same branch that renders `redirectPage`), if the request **looks like a real browser** call `ctx.waitUntil(sendHit(...))`:
   - Method `GET`, `Accept` contains `text/html`, and the UA does not match `/bot|crawl|spider|preview|discord|telegram|whatsapp|slack|facebookexternalhit|twitterbot|skype|embed/i`.
   - Body `{ steamId64, ts, ipHash }`. `ipHash` is a SHA-256 of `CF-Connecting-IP` + a salt that rotates daily, used only for in-memory rate limiting and never stored.
   - `AbortSignal.timeout(1500)`. Errors are logged and swallowed.
   - The Vanity path already has the SteamID64. For the `/profiles/` path, SteamID3 is converted to SteamID64 (add `toSteamId64` next to `convertToDota2Id`).
3. **Redirect page teaser** (only when `FEED_PUBLIC_URL` is set):
   - Inline JS fetches `{FEED_PUBLIC_URL}/teaser/{dotaId}.json` with a 600 ms abort. On success it renders one line under the "Taking you to the Dotabuff profile…" message. On failure or timeout it renders nothing.
   - The redirect timer is never extended to wait for the teaser.
   - Line content, first match wins:
     - The profile being opened was checked in the last hour → "This player was checked 4 min ago · ×3 — see who else →"
     - otherwise → "132 players checked this hour — see if you were →", with up to 3 small overlapping avatars.
   - While the ping banner is shown, the teaser is static text, with no animation.
   - Clicking the teaser **cancels the redirect** (clears the timer) and navigates to `/` in the same tab. The in-game CEF browser handles new tabs poorly. The existing "Not redirected? Click here" Dotabuff link stays.
   - The `<meta http-equiv="refresh">` fallback moves inside `<noscript>`, so the JS timer is the only redirect when JS runs and the teaser click can actually cancel it.
4. **Home page**: when `FEED_PUBLIC_URL` is set, render the feed section (Component 3) between the hero and the examples. The HTML stays static and cacheable; all data loads client-side.

## Component 2 — Feed service (`feed/`)

- **Stack:** Node 24, zero runtime dependencies (`node:http`, `node:sqlite`, `fetch`). Ships with a `Dockerfile` and a sample `docker-compose.yml`. A volume holds the SQLite file.
- **Config (env):** `FEED_TOKEN`, `STEAM_API_KEY`, `PORT`, `DB_PATH`, `ALLOWED_ORIGINS` (CORS for the site's origin), optional `BLOCKED_WORDS_FILE`, optional `HIDDEN_IDS_FILE`.

### Data model (SQLite)

```sql
pending (steamid TEXT PRIMARY KEY, first_ts INTEGER, last_ts INTEGER, hits INTEGER)
players (steamid TEXT PRIMARY KEY, name TEXT, avatar_hash TEXT, visible INTEGER, fetched_at INTEGER)
checks  (steamid TEXT, ts INTEGER)          -- one row per accepted hit; purged after 24 h
CREATE INDEX checks_ts ON checks(ts);
```

### Ingest — `POST /hit`

- Requires `Authorization: Bearer FEED_TOKEN`. Validates the SteamID64 format (`7656119…`, 17 digits).
- Rate limits: ≤ 20 hits/min per `ipHash` and ≤ 6 hits/min per `steamid`, both in memory. Excess is accepted with 202 and silently dropped.
- Inserts into `checks` and upserts `pending`. Returns 202.

### Enrichment tick (every 30 s, only when `pending` is non-empty)

- Takes up to 500 pending ids (5 chunks of 100) and skips ids whose `players.fetched_at` is under 6 h old.
- Calls `ISteamUser/GetPlayerSummaries/v2` sequentially per chunk, with a 5 s timeout each.
- Upserts `players`. `visible = communityvisibilitystate === 3`.
- Commits the deletion from `pending` in the same transaction.
- On Steam failure, the ids stay pending and the next tick backs off: 30 s → 60 s → 120 s, capped at 5 min.
- Broadcasts the newly visible entries to SSE clients.

### Public read endpoints

All are CORS-limited to `ALLOWED_ORIGINS`, sent with `Cache-Control: public, max-age=10`, and include only `visible = 1` players that are not hidden.

- `GET /recent.json` → `{ hourCount, generatedAt, entries: [...] }`. `entries` holds the latest 200 distinct players from the last 60 min, ordered by last check desc. Each entry: `{ steamId64, dotaId, name, avatarHash, lastTs, count }`, where `count` is the number of checks in the last hour.
- `GET /teaser/{dotaId}.json` → `{ hourCount, seen: { lastTs, count } | null, faces: [avatarHash×3] }`.
- `GET /stream` (SSE):
  - On connect it sends `event: snapshot` (same payload as `/recent.json`).
  - It then sends `event: entries` per enrichment tick.
  - Heartbeat comment every 25 s.
  - At most 2,000 concurrent clients; above that it returns 503 and the client falls back to polling.
- `GET /healthz`.

### Hygiene

- **Nickname sanitising (server side, before storing):**
  - Strip control characters and bidi overrides/isolates (U+202A–202E, U+2066–2069).
  - Keep at most 2 combining marks per base character (anti-zalgo).
  - Cap at 32 graphemes.
  - Words from `BLOCKED_WORDS_FILE` are matched case-insensitively after NFKC and replaced with `•••`.
- **Avatars:** only the hash is stored. The client builds `https://avatars.steamstatic.com/{hash}_medium.jpg`, so no arbitrary URLs reach the page.
- **Hidden ids:** `HIDDEN_IDS_FILE` holds SteamID64s, one per line, re-read on SIGHUP. Listed players never appear. This is the v1 opt-out, handled on request via the contact or issue link documented in the README.
- **Retention:** `checks` older than 24 h and `players` not seen for 7 days are purged hourly. IPs are never stored.

## Component 3 — Home page feed UI (client-side, inline in `indexPage`)

Validated with the interactive mockup (split-flap option B plus catch/release behaviour).

**Layout:**
- Section "Recently checked" with a LIVE dot and an "N checked this hour" counter.
- A search input.
- A scrollable list about 7 rows tall. Rows are grouped under sticky headers: **Just now** (< 1 min), **Last 5 min**, **Last hour**.
- Row: 36 px Steam avatar, nickname (with an `×N` badge when count ≥ 2), relative time, and a "Dotabuff →" link.

**Links** go straight to `https://www.dotabuff.com/players/{dotaId}`, *not* through `/profiles/…`. Clicks from the feed must not create new hits, otherwise popular rows would feed themselves.

**Transport:**
- `EventSource(FEED_PUBLIC_URL + '/stream')`.
- If SSE fails, it falls back to polling `/recent.json` every 30 s ± 5 s.
- While the tab is hidden, SSE is closed and polling stops. On return, the client refetches `/recent.json` and merges.

**Drip:** incoming entries go into a queue and are revealed one at a time, spaced evenly across the gap until the next expected batch (min 400 ms, max 3 s). A backlog beyond 3 items is inserted without animation.

**Upsert:** an entry whose player is already in the list moves to the top, re-flaps, and updates `×N`.

**Split-flap animation:**
- The row height opens (260 ms).
- Avatar `rotateX` flip-in.
- Nickname characters cycle through random glyphs and land left-to-right (≈45 ms per tick).
- Transform/opacity only, no blur or filters (in-game CEF browser).
- `prefers-reduced-motion`: rows simply appear.

**Catch / release:**
- Hovering the list, or scrolling away from the top, pauses the feed. The LIVE dot turns gold. A pill shows "⏸ Paused · N new · back to live ↑" with a countdown bar.
- It resumes after 8 s idle (1.5 s if the cursor leaves while at the top), immediately when the user scrolls back to the top, or when the pill is clicked.
- On resume it smooth-scrolls to the top and drips the queued items.

**Filter:**
- Words are split on whitespace, normalised with NFKC + lowercase, and match if **any** word is a substring of the nickname. Matches are highlighted with `<mark>` built via DOM nodes, never `innerHTML`.
- The query is kept in `?q=` and `localStorage`. A persisted query acts as a "pinned nickname": when a new matching entry arrives, the row flashes gold and the tab title gets a "★" prefix until the tab is focused.

**Copy & language:**
- English by default.
- Russian / Ukrainian strings are chosen by `navigator.language`. The dictionary is small and inline.

**Safety:** all user-derived text goes through `textContent`, and avatar `<img>` sources are built only from a validated hash.

## Capacity estimate

| Item | Volume (Saturday peak) | Limit |
|---|---|---|
| Worker requests added | ≈ 0 (hit is a subrequest; feed reads bypass the Worker) | 100k/day account-wide |
| Feed `/hit` | ≈ 40k/day, ≈ 1.3/s peak | trivial for Node + SQLite |
| Steam `GetPlayerSummaries` | ≤ 2/min → ≤ 2.9k/day (fewer with the 6 h cache) | 100k/day per key |
| SSE clients | estimated tens to low hundreds concurrent | capped at 2,000 |

## Testing

- **Worker (`worker.test.js`, `node --test`):**
  - Bot-UA filter.
  - `toSteamId64` for all ID forms.
  - Feed config validation (bad or missing values → feature off).
  - `redirectPage` renders the teaser script only when configured and puts the meta refresh inside `<noscript>`.
  - `indexPage` renders the feed section only when configured.
  - `sendHit` is invoked through `waitUntil` and swallows errors (mocked `fetch`).
- **Feed service (`feed/test/*.test.js`, `node --test`):**
  - Sanitiser (bidi, zalgo, blocked words).
  - Rate limits.
  - Enrichment tick with mocked Steam: chunking >100, private profiles dropped, failure backoff, atomic pending removal.
  - `/recent.json` grouping and counts.
  - SSE snapshot and broadcast.
  - Auth on `/hit`.
- **Manual:**
  - Run the feed locally with Docker plus `wrangler dev` with `.dev.vars`.
  - Verify the redirect timing is unchanged, the teaser click cancels the redirect, catch/release works, the filter highlights matches, and reduced-motion is respected.
  - Smoke-test in the Dota in-game browser.

## Docs

- `README.md`: a new "Recent checks feed (optional module)" section covering what it is, privacy notes, Worker secrets, and a link to `feed/README.md`.
- `feed/README.md`: deploy with Docker behind any HTTPS reverse proxy, env reference, opt-out procedure, and CDN caching tips. Placeholder hosts only (`feed.example.com`).
- `.dev.vars.example`: the new secrets with placeholder values.
- New `CHANGELOG.md` (Keep a Changelog format) with an *Unreleased → Added* entry.

## Later (explicitly out of v1)

- "Opened together" grouping: ≥ 4 distinct profiles within ~10 s collapse into one block (e.g. "5 profiles · 18:42").
- A Battle Cup header mode when checks/min spike.
- Owner-verified opt-out via Steam OpenID.
