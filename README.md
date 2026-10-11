# Steam to Dotabuff Redirector

## Overview
This service converts Steam Vanity URLs and SteamID-based profile URLs into Dotabuff player profile links. It runs either as a **Cloudflare Worker** (`worker.js`) or as a **self-hosted Node server** (`server.js`, Docker image provided). Both share one request handler (`src/core.js`). The self-hosted server additionally runs the optional **recent checks feed**.

## Features
- **Supports Steam Vanity URLs** (e.g., `steamcommunity.com/id/gabelogannewell` → API resolution required)
- **Handles SteamID-based URLs locally** (e.g., `steamcommunity.com/profiles/76561197960287930` → converted without API)
- **Automatic Redirects** to Dotabuff player profiles
- **Analytics**: Google Analytics and/or Matomo on every page, configured through secrets/env
- **Two runtimes**: a Cloudflare Worker, or a self-hosted Node server (Docker image provided) sharing the same request handler
- **Secure API key handling**: Steam keys live in Worker secrets or the server's `.env`, with rotation across several keys and health tracking
- **Recent checks feed** (self-hosted only): live list of recently checked players on the home page, plus a teaser on the redirect page

## How It Works
1. **Vanity URLs**: If a user enters a Steam Vanity URL (`/id/{username}`), the service queries the Steam API to resolve the corresponding SteamID64.
2. **SteamID64 URLs**: If a user enters a `/profiles/{SteamID64}`, the system locally converts it to a Dota 2 Player ID.
3. **Steam3 IDs**: If the URL contains a Steam3 ID format (e.g., `[U:1:22202]`), it is converted directly without API usage.
4. **Redirect page**: a short interstitial loads analytics, then sends the visitor to Dotabuff after 1 second (5 seconds when the optional banner is shown, at most once per hour). With JavaScript off, a `<noscript>` meta refresh does the same.

## URL Usage
- **Vanity Name URL:** `https://steamcommunitx.com/id/{username}` (Requires API resolution)
- **SteamID64 URL:** `https://steamcommunitx.com/profiles/{steamID64}` (Converted locally)
- **Steam3 ID URL:** `https://steamcommunitx.com/profiles/[U:1:{dotaID}]` (Converted locally)

All formats redirect to Dotabuff:
```
https://www.dotabuff.com/players/{dotaID}
```

Anything after the ID (`/inventory`, `/games`, …) is ignored, and the link type is case-insensitive. `/id` or `/profiles` without a player shows a 404 page explaining these formats; any other path is a plain 404.

## Setup & Deployment
### 1. Deploy to Cloudflare Workers
- Clone the repository and navigate to the project folder.
- Deploy the worker using Cloudflare’s dashboard or Wrangler CLI. The Worker build bundles `src/` automatically; the feed is not available on Workers.

### 2. Set Up Secrets and Variables
Go to Cloudflare Dashboard → Workers & Pages → Select Your Worker → **Settings** → **Variables and Secrets**.

**Required:**
- `STEAM_API_KEY` *(secret)* — your Steam Web API key from https://steamcommunity.com/dev/apikey

**Optional:**
- `STEAM_API_KEYS` *(secret)* — comma-separated list of additional Steam API keys for rotation under load. Whitespace around commas is trimmed automatically.
- `GA_ID` *(var)* — Google Analytics 4 measurement ID (e.g. `G-XXXXXXX`). Injected into the `<head>` of every HTML page. Omit to disable GA.
- `MATOMO_URL` and `MATOMO_SITE_ID` *(secret)* — Matomo tracker base URL (must end with `/`, e.g. `//m.example.com/`) and numeric site ID. Both are required together; either alone is ignored. Omit to disable Matomo.
- `BANNERS` *(secret)* — JSON array of `{ "src", "height", "label" }` entries for the iframe shown on the redirect interstitial (one is picked at random per render, at most once per hour per visitor). `src` must be an `https` URL, `height` is in pixels, and `label` is an optional plain-text caption. Omit the secret and the interstitial renders no embed at all — it just shows the redirect message for a second. No embed URLs are baked into the source.

Analytics and banner values are validated against strict format guards before being inlined into HTML, so a malformed value is silently dropped rather than producing broken markup.

Set the secrets with Wrangler instead of the dashboard if you prefer:

```bash
wrangler secret put BANNERS
wrangler secret put MATOMO_URL
wrangler secret put MATOMO_SITE_ID
```

For local `wrangler dev`, copy `.dev.vars.example` to `.dev.vars` (gitignored) and fill in your own values.

### 3. KV Namespace Bindings (Optional)
The worker uses two KV namespaces. Both are optional — the worker degrades gracefully if a binding is missing, but you lose caching / health tracking.

Create namespaces in **Workers & Pages → KV**, then bind them to the worker under **Settings → Variables and Secrets → KV Namespace Bindings**:

| Variable name      | Purpose                                                                 |
|--------------------|-------------------------------------------------------------------------|
| `STEAM_ID_CACHE`   | Caches resolved `vanity → steamID64` for 30 days.                       |
| `API_KEY_STATUS`   | Marks invalid / rate-limited API keys so the next request skips them.   |

> Note: a previous version of the worker used a `RATE_LIMITS` KV binding for in-worker rate limiting. That has been removed — KV is not suitable for atomic counters. If you need rate limiting, configure it via Cloudflare WAF Rate Limiting Rules or the native Workers Rate Limiting binding.

### 4. Bind Custom Domain (Optional)
To use a custom domain like `steamcommunitx.com`, configure Cloudflare DNS settings and map the domain to the worker.

## Code Breakdown
### Key Files:
- **`src/core.js`**: request routing, Steam ID resolution and conversion, `handleRequest(request, env, ctx)` — Web-standard APIs only.
- **`src/pages.js`**: HTML for the home, redirect and error pages.
- **`worker.js`**: Cloudflare Workers adapter.
- **`server.js`**: Node adapter (SQLite instead of KV, in-process feed, `/healthz`).
- **`src/feed/`**: recent checks feed (storage, Steam enrichment, SSE).
- **`src/client/`**: browser feed UI and helpers shared with the server.
- **`README.md`**: This doc.

> The original 2017 PHP prototype is preserved on the [`legacy-php-2017`](https://github.com/faeton/steamcommunitx.com/tree/legacy-php-2017) branch for historical reference.

### Redirect logic
- One request handler (`handleRequest` in `src/core.js`) serves both runtimes.
- SteamID64 and SteamID3 are converted locally; vanity names are resolved through `ISteamUser/ResolveVanityURL` and cached for 30 days. An unknown vanity name is a 404 right away.
- Missing keys, rate limits (429 with `Retry-After`) and Steam outages get their own error pages; on the Node server `/healthz` reports Steam API health too.

## Self-hosting (Node / Docker)

Requires Node 24+ or Docker.

1. `cp .env.example .env` and set at least `STEAM_API_KEY`.
2. `cp docker-compose.example.yml docker-compose.yml`, then `mkdir -p data config && sudo chown 1000:1000 data`.
3. `docker compose up -d --build`. The server listens on `127.0.0.1:8787`; `GET /healthz` returns `{"ok":true,…}`.
4. Put a TLS reverse proxy in front — see `deploy/Caddyfile.example`. Recommended setup with Cloudflare:
   - DNS record **proxied** (orange cloud).
   - SSL/TLS mode **Full (strict)** for the hostname (a Configuration Rule can scope it to one hostname). *Flexible* causes a redirect loop.
   - A Cloudflare **Origin CA** certificate on the proxy, and only Cloudflare IP ranges allowed through.
5. Point an uptime monitor at `/healthz`. It answers `503` (with `steam.reason`) when no Steam API key is configured, or when every Steam call has failed for 15+ minutes (revoked key, outage), so the monitor also catches a broken key, not only a dead process.

Without Docker: `npm start` (reads the same variables from the environment).

### Switching between the Worker and the server

A Worker route on the zone takes precedence over the origin. `wrangler.toml` deliberately declares **no routes**, so `wrangler deploy` only uploads the Worker code and never takes the domain away from the server by accident.

- **Serve from the self-hosted server:** remove the Worker route (Workers & Pages → the worker → Settings → Domains & Routes) and point the proxied DNS record at the server.
- **Serve from the Worker (or roll back):** `npx wrangler deploy --routes "example.com/*"` — the explicit route is the switch. The Worker runs without the feed; everything else is identical.
- If the Worker is connected to Cloudflare Workers Builds (git auto-deploy), keep in mind that a build with a route configured has the same effect.

## Recent checks feed (optional, self-hosted only)

When the server runs with `FEED_ENABLED=1` (default), every real-browser redirect records a *check* of that profile (link-preview bots and crawlers are ignored). Every 30 seconds the queued SteamIDs are enriched with nickname and avatar via `ISteamUser/GetPlayerSummaries` (up to 100 per call, cached for 6 hours). The home page then shows a live list of players checked in the last hour, and the redirect page shows a one-line teaser ("this player was checked 4 min ago" or "132 players checked this hour").

The home list:
- is rendered on the server, so it is there on first paint, then updated live over Server-Sent Events (polling as a fallback);
- reveals new players one at a time with a split-flap animation, grouped into *Just now / Last 5 min / Last hour*;
- splits into two or three independent reels when checks arrive fast (Battle Cup evenings), and back to one when it calms down;
- can be "caught": hovering or scrolling pauses it, and it releases after a few seconds idle or when scrolled back to the top;
- filters by any word of a nickname, or by a Dota ID / SteamID64 (a bare ID, a pasted profile URL or `[U:1:x]` all work);
- links the nickname to the Steam profile and has D / O / S tiles for Dotabuff, OpenDota and STRATZ; each row shows the Dota ID and how long ago it was checked.

Privacy and moderation:
- Only the **checked profile** is shown, never who checked it. IP addresses are never stored (rate limiting uses a daily-salted hash kept in memory).
- Only public Steam data is shown: persona name and avatar. Steam publishes these even for private profiles, so private profiles are listed too, marked with a small lock. Accounts Steam does not know are never shown; a known player Steam temporarily omits keeps its last name and avatar.
- Raw checks are kept for 24 hours (the watchlist can ask about any ID within that window; nothing about the visitor is exposed), player names/avatars for 7 days after the last check.
- Nicknames are cleaned (control/bidi characters, excessive combining marks, length) and words listed in `BLOCKED_WORDS_FILE` are masked. After editing the file, send `SIGHUP` (`docker kill -s HUP <container>`); new and refreshed names use the new list.

### Watching a team (`?check=`)

Before a Battle Cup a team can share one link, for example `/?check=123456789,163191061`, with up to 10 players. Every ID may be a Dota ID, a SteamID64, `[U:1:x]` or a pasted Steam/Dotabuff/OpenDota/STRATZ profile URL; the *+ ID* box also takes vanity links (`/id/name`, ours or Steam's) and bare vanity names, resolved once when added. The *Watching* block above the list shows, for each player, when a check was last recorded here in the last 24 hours and how many, and it updates live:
- the page polls the status every 20 seconds while the list is non-empty, also in a background tab (browsers slow that to about once a minute);
- a new check flashes the row, highlights the player on the board, and puts a counter in the tab title while you are away; the 🔔 button adds a chime and a browser notification;
- the IDs can be edited in place; the address bar always holds the current link, and the last list is remembered in the browser for a bare visit.

"No checks recorded" covers this redirector only, and your own lookups count as checks too. A link with `?check` is marked `noindex`, and the page sends `Referrer-Policy: strict-origin-when-cross-origin` so the IDs do not leak to the sites it links to.

Endpoints: `GET /api/recent.json` (snapshot, cacheable for 10 s), `GET /api/stream` (Server-Sent Events), `GET /api/check.json?ids=…` (watchlist status, up to 10 IDs, 60 lookups per minute per IP), `GET /api/resolve.json?v=<vanity>` (vanity name → Dota ID for the watchlist box, 10 per minute per IP), `GET /healthz`.

## Contributing
Feel free to submit pull requests for improvements, bug fixes, or additional features.

## License
MIT License.

