# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- Self-hosted Node server (`server.js`) running the same request handler as the
  Cloudflare Worker, with SQLite in place of Workers KV, a `/healthz` endpoint,
  a Docker image and deployment examples (compose, Caddy behind Cloudflare).
- Recent checks feed (self-hosted only, `FEED_ENABLED`): live list of recently
  checked players on the home page with a split-flap animation, catch/release
  scrolling, nickname filter and time blocks; Server-Sent Events with polling
  fallback; English, Russian and Ukrainian UI. When checks arrive fast the
  list splits into two or three independent reels; long nicknames fade out.
- Redirect-page teaser showing when the opened profile was last checked, or how
  many players were checked this hour. Clicking it cancels the redirect.
- Private Steam profiles are listed with a lock badge; nickname word masking
  (`BLOCKED_WORDS_FILE`, reloaded on `SIGHUP`).

### Changed
- Request handling moved to `src/core.js` and `src/pages.js`; `worker.js` is now
  a thin adapter. Worker behaviour is unchanged.
- The redirect page's meta-refresh fallback now lives in `<noscript>`; with
  JavaScript the redirect is driven by the script timer only.
