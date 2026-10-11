# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.4.0] - 2026-10-11

### Added
- `/healthz` reports Steam API health (`steam`: calls, failures, last error)
  and answers 503 when no key is configured or Steam calls have only failed
  for 15+ minutes, so uptime checks catch a revoked key.

### Fixed
- An unknown vanity name ("No match" from Steam) is a 404 right away instead of
  retries ending in a 500.
- Filtering while the feed is paused collapses it to one reel; toggling the
  filter no longer resets the reel-change cooldown; name fades follow resizes.
- Feed assets: `If-None-Match` accepts weak and listed ETags; `nosniff`.
- Error page titles are escaped; `/ID/…`, `/id//name` and `///` route sensibly.

## [2.3.2] - 2026-10-11

### Changed
- `/id` and `/profiles` without a player no longer redirect to Dotabuff's
  front page; they show a 404 page explaining the supported URL formats.

## [2.3.1] - 2026-10-11

### Fixed
- Unknown single-segment paths (`/nope`, `/robots.txt`, …) return the 404 page
  instead of a 301 to Dotabuff's home page.

## [2.3.0] - 2026-10-11

### Added
- OpenDota (O) and STRATZ (S) tiles next to the Dotabuff (D) tile in feed
  rows, each in its site's logo colours.

## [2.2.0] - 2026-10-11

### Added
- Clicking a nickname in the feed opens the player's Steam profile; the D tile
  still opens Dotabuff.

## [2.1.0] - 2026-10-11

### Added
- The feed filter also matches Dota IDs and SteamID64s: any run of 4+ digits
  in the query (a bare ID, a pasted profile URL or `[U:1:x]`) finds the player.

## [2.0.1] - 2026-10-11

### Changed
- The home page renders the recent checks feed on the server, so it is
  visible on first paint instead of appearing (and shifting the page) once
  the stream connects. The browser module takes over from the embedded
  snapshot without another request.

## [2.0.0] - 2026-10-11

### Added
- Self-hosted Node server (`server.js`) running the same request handler as the
  Cloudflare Worker, with SQLite in place of Workers KV, a `/healthz` endpoint,
  a Docker image and deployment examples (compose, Caddy behind Cloudflare).
- Recent checks feed (self-hosted only, `FEED_ENABLED`): live list of recently
  checked players on the home page with a split-flap animation, catch/release
  scrolling, nickname filter and time blocks; Server-Sent Events with polling
  fallback; English, Russian and Ukrainian UI. When checks arrive fast the
  list splits into two or three independent reels; long nicknames fade out.
- Feed rows show the Dota ID next to the relative time.
- Redirect-page teaser showing when the opened profile was last checked, or how
  many players were checked this hour. Clicking it cancels the redirect.
- Private Steam profiles are listed with a lock badge; nickname word masking
  (`BLOCKED_WORDS_FILE`, reloaded on `SIGHUP`).

### Changed
- Request handling moved to `src/core.js` and `src/pages.js`; `worker.js` is now
  a thin adapter. Worker behaviour is unchanged.
- The redirect page's meta-refresh fallback now lives in `<noscript>`; with
  JavaScript the redirect is driven by the script timer only.
- `wrangler.toml` no longer declares the domain route: `wrangler deploy` only
  uploads the Worker, and switching the domain to it takes an explicit
  `--routes` flag. CI runs on Node 24.

[2.4.0]: https://github.com/faeton/steamcommunitx.com/releases/tag/v2.4.0
[2.3.2]: https://github.com/faeton/steamcommunitx.com/releases/tag/v2.3.2
[2.3.1]: https://github.com/faeton/steamcommunitx.com/releases/tag/v2.3.1
[2.3.0]: https://github.com/faeton/steamcommunitx.com/releases/tag/v2.3.0
[2.2.0]: https://github.com/faeton/steamcommunitx.com/releases/tag/v2.2.0
[2.1.0]: https://github.com/faeton/steamcommunitx.com/releases/tag/v2.1.0
[2.0.1]: https://github.com/faeton/steamcommunitx.com/releases/tag/v2.0.1
[2.0.0]: https://github.com/faeton/steamcommunitx.com/releases/tag/v2.0.0
