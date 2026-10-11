# Steam to Dotabuff Redirector

## Overview
This service converts Steam Vanity URLs and SteamID-based profile URLs into Dotabuff player profile links. It runs either as a **Cloudflare Worker** (`worker.js`) or as a **self-hosted Node server** (`server.js`, Docker image provided). Both share one request handler (`src/core.js`). The self-hosted server additionally runs the optional **recent checks feed**.

## Features
- **Supports Steam Vanity URLs** (e.g., `steamcommunity.com/id/gabelogannewell` → API resolution required)
- **Handles SteamID-based URLs locally** (e.g., `steamcommunity.com/profiles/76561197960287930` → converted without API)
- **Automatic Redirects** to Dotabuff player profiles
- **Google Analytics Integration** (ensuring tracking before redirection)
- **Cloudflare Workers Optimization**
- **Secure API Key Handling** using Cloudflare Worker Secrets
- **Recent checks feed** (self-hosted only): live list of recently checked players on the home page, plus a teaser on the redirect page

## How It Works
1. **Vanity URLs**: If a user enters a Steam Vanity URL (`/id/{username}`), the service queries the Steam API to resolve the corresponding SteamID64.
2. **SteamID64 URLs**: If a user enters a `/profiles/{SteamID64}`, the system locally converts it to a Dota 2 Player ID.
3. **Steam3 IDs**: If the URL contains a Steam3 ID format (e.g., `[U:1:22202]`), it is converted directly without API usage.
4. **Google Analytics**: The redirect page ensures Google Analytics tracking before sending the user to Dotabuff.

## URL Usage
- **Vanity Name URL:** `https://steamcommunitx.com/id/{username}` (Requires API resolution)
- **SteamID64 URL:** `https://steamcommunitx.com/profiles/{steamID64}` (Converted locally)
- **Steam3 ID URL:** `https://steamcommunitx.com/profiles/[U:1:{dotaID}]` (Converted locally)

All formats redirect to Dotabuff:
```
https://www.dotabuff.com/players/{dotaID}
```

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

### Optimized Redirect Logic
- Uses `window.onload` to ensure all tracking scripts load before redirecting.
- Redirects both SteamID-based URLs and Vanity URLs to Dotabuff.
- Implements proper error handling for missing API keys and invalid Steam IDs.

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

When the server runs with `FEED_ENABLED=1` (default), every real-browser redirect records a *check* of that profile (link-preview bots and crawlers are ignored). Every 30 seconds the queued SteamIDs are enriched with nickname and avatar via `ISteamUser/GetPlayerSummaries` (up to 100 per call, cached for 6 hours). The home page then shows a live list of players checked in the last hour, and the redirect page shows a one-line teaser.

Privacy and moderation:
- Only the **checked profile** is shown, never who checked it. IP addresses are never stored (rate limiting uses a daily-salted hash kept in memory).
- Only public Steam data is shown: persona name and avatar. Steam publishes these even for private profiles, so private profiles are listed too, marked with a small lock. Accounts Steam does not return (deleted or invalid) are never shown.
- Raw checks are kept for 24 hours, player names/avatars for 7 days after the last check.
- Nicknames are cleaned (control/bidi characters, excessive combining marks, length) and words listed in `BLOCKED_WORDS_FILE` are masked. After editing the file, send `SIGHUP` (`docker kill -s HUP <container>`); new and refreshed names use the new list.

Endpoints: `GET /api/recent.json` (snapshot, cacheable for 10 s), `GET /api/stream` (Server-Sent Events), `GET /healthz`.

## Contributing
Feel free to submit pull requests for improvements, bug fixes, or additional features.

## License
MIT License.

