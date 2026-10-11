# Recent Checks Feed + Self-Hostable Server — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live "recently checked players" feed (home page split-flap list + server-rendered teaser on the redirect page), served by a new self-hostable Node server that shares one request handler with the existing Cloudflare Worker.

**Architecture:** Today's `worker.js` becomes a thin Cloudflare adapter over a runtime-agnostic `src/core.js` (routing, Steam resolve, `handleRequest`) and `src/pages.js` (HTML renderers). A new `server.js` adapts `node:http` to the same `handleRequest`, swaps KV for a SQLite shim, and injects `env.FEED` — an in-process feed module (`src/feed/`) that records hits, enriches them via Steam `GetPlayerSummaries` every 30 s, and serves `/api/recent.json` + `/api/stream` (SSE). The browser feed UI is a static ES module (`src/client/feed.js`) sharing pure helpers with the server (`src/client/feed-shared.js`).

**Tech Stack:** Node 24 built-ins only (`node:http`, `node:sqlite`, `node:test`, `fetch`, Web Streams), Cloudflare Workers (Wrangler), vanilla browser JS/CSS, Docker (`node:24-alpine`), Caddy (example config only).

**Spec:** `docs/superpowers/specs/2026-10-11-recent-checks-feed-design.md`

## Global Constraints

- Zero runtime npm dependencies. Node ≥ 24 for the server (local dev may be newer); Worker code may only use Web-standard APIs.
- This repo is **open source**: no deployment-specific hostnames, IPs, server names or keys anywhere in code, docs, tests or commit messages. Use `example.com` / `feed.example.com` placeholders.
- Commits: Conventional Commits (`feat(scope): …`, `refactor: …`, `docs: …`, `test: …`) with an explanatory body. **No `Co-Authored-By` trailer.**
- Without `env.FEED` (Worker runtime, or server with `FEED_ENABLED=0`) the site must behave exactly as today, except the meta-refresh fallback moving into `<noscript>`.
- All user-derived text (Steam nicknames) reaches the DOM via `textContent` / DOM nodes only — never `innerHTML` — and server-side HTML only via `escapeHtml`.
- Avatars are only ever built from a validated 40-hex hash: `https://avatars.steamstatic.com/{hash}_medium.jpg`.
- Feed links go straight to `https://www.dotabuff.com/players/{dotaId}` (never through `/profiles/…`).
- Animations: transform/opacity only, no `filter`/blur; honour `prefers-reduced-motion`.
- UI copy: English default; Russian/Ukrainian by `navigator.language` (client) / `Accept-Language` (server teaser).
- Timings: enrichment tick 30 s (backoff 60 s → 120 s → … cap 300 s); Steam call timeout 5 s; ≤ 100 ids per Steam call, ≤ 500 ids per tick; SSE heartbeat 25 s, max 2,000 clients; rate limits 20 hits/min per IP hash and 6 hits/min per SteamID; retention 24 h checks / 7 d players; feed window 60 min, ≤ 200 entries; catch/release idle 8 s, leave-at-top 1.5 s.

## Review Focus

1. **A visitor must never see their own visit in the teaser** ("checked just now ×1" for the profile they are opening right now) — teaser must be computed *before* the hit is recorded. Pinned in Task 2 (call order test) and Task 6 (teaser before/after hit).
2. **Steam API down or no keys** — redirects for `/profiles/…` must still work, queued ids must stay pending and be retried with backoff, nothing crashes. Pinned in Task 5 (failure keeps pending + backoff) and Task 7 (server serves redirects with a failing Steam fetch).
3. **Feed disabled** (Worker, or `FEED_ENABLED=0`) — `/api/*` returns today's 404 page, home has no feed section, redirect keeps `max-age=300`, `/healthz` on the server still answers. Pinned in Task 2 and Task 7.
4. **Hostile nicknames** (bidi overrides, zalgo, control chars, `<script>` text, blocked words) — sanitised server-side and still rendered as inert text. Pinned in Task 3 (sanitiser) and Task 6 (stored name is sanitised; `<script>` survives as literal text in JSON, never as HTML).
5. **Accounts Steam did not return** (deleted / invalid) must not appear anywhere: not in `/api/recent.json`, SSE or the teaser's "seen" line. Private profiles *are* shown, flagged `private: true`. Pinned in Task 6.

## Amendment (2026-10-11): no opt-out, private profiles shown

Decided after the plan was written; it overrides the code below wherever they differ.

- **No opt-out list.** Drop `HIDDEN_IDS_FILE`, `loadIds`, the `hidden` set and the hidden-id tests. `reloadLists()` (SIGHUP) only re-reads `BLOCKED_WORDS_FILE` and broadcasts nothing.
- **`players` columns:** `found INTEGER` (Steam returned the player) replaces `visible`; new `private INTEGER` (`communityvisibilitystate !== 3`). `recent`, `hourCount` and the teaser's `seen` require `found = 1` only.
- **Entries** gain `private: boolean`. The browser row shows a small lock badge on the avatar (`title`: "Private Steam profile", i18n key `privateProfile`).
- **No removal broadcasts.** A known player Steam omits keeps its last data, so `onEntries(ids)` has no `removed` argument (changed during the final review).

---

## File Structure

| Path | Responsibility |
|---|---|
| `worker.js` (rewrite) | Cloudflare adapter: default export `{ fetch }` → `handleRequest`; re-exports for back-compat. |
| `src/core.js` (new, moved code) | API-key helpers, `getId`, ID conversion (`convertToDota2Id`, `toSteamId64`, `accountIdToSteamId64`), `parseRoute`, `isRealBrowser`, `ipHash`, `handleRequest`. |
| `src/pages.js` (new, moved code) | `analyticsSnippet`, `resolveBanners`, `indexPage`, `errorPage`, `redirectPage`, `renderTeaser`, `escapeHtml`. |
| `src/client/feed-shared.js` | Pure helpers shared by server + browser: i18n (`pickLang`, `t`, `ago`), `avatarUrl`, search (`splitTerms`, `matchesTerms`, `highlightRanges`), `timeBlock`, `dripDelay`, `isNewer`, `diffEntries`, `idsToRemove`. |
| `src/client/feed.js` | Browser feed UI (DOM, SSE/polling, drip, split-flap, catch/release, filter). Served at `/assets/feed.js`. |
| `src/feed/sanitize.js` | `sanitizeName`, `maskBlocked`, `loadWords`, `loadIds`. |
| `src/feed/store.js` | `openDb`, `SqliteKV` (KV shim), `FeedStore` (checks/pending/players queries). |
| `src/feed/ratelimit.js` | `RateLimiter` (fixed window per key). |
| `src/feed/enrich.js` | `createSteamSummaries`, `toPlayerRow`, `Enricher` (tick + backoff). |
| `src/feed/sse.js` | `SseHub` (clients, broadcast, heartbeat). |
| `src/feed/index.js` | `createFeed` → `{ recordHit, teaser, handle, health, reloadLists, start, stop, tick }`. |
| `server.js` | Node adapter: `createServer()`, static `/assets/*`, `/healthz`, main entry with signals. |
| `test/*.test.js` | `core`, `pages`, `feed-shared`, `sanitize`, `store`, `enrich`, `feed`, `server`. |
| `Dockerfile`, `.dockerignore`, `docker-compose.example.yml`, `deploy/Caddyfile.example`, `.env.example` | Packaging. |
| `README.md`, `CHANGELOG.md`, `.dev.vars.example` | Docs. |

---

### Task 1: Split `worker.js` into core + pages (pure refactor)

**Files:**
- Create: `src/core.js`, `src/pages.js`, `test/core.test.js`
- Modify: `worker.js` (replace entirely)
- Delete: `worker.test.js` (moved to `test/core.test.js`)

**Interfaces:**
- Produces: `src/core.js` exports `getConfiguredApiKeys, getAvailableApiKeys, markProblemKey, markRateLimitedKey, markWorkingKey, convertToDota2Id, parseRoute, handleRequest(request, env, ctx)`. `src/pages.js` exports `analyticsSnippet, resolveBanners, indexPage, errorPage, redirectPage` (`handleFavicon` stays in core). `worker.js` default export `{ fetch(request, env, ctx) }`.

- [ ] **Step 1: Move the code**

```bash
mkdir -p src test
sed -n '1,284p' worker.js > src/core.js
sed -n '286,796p' worker.js > src/pages.js
git mv worker.test.js test/core.test.js
```

Then edit `src/core.js`:
- Delete the block `export default { async fetch(request, env) { return handleRequest(request, env); } };` (lines 63–67 of the old file).
- Add `export` to `getAvailableApiKeys`, `markProblemKey`, `markRateLimitedKey`, `markWorkingKey`, `handleRequest`.
- Change the signature to `export async function handleRequest(request, env, ctx) {`.
- Add at the top:

```js
import { analyticsSnippet, resolveBanners, indexPage, errorPage, redirectPage } from './pages.js';
```

Edit `src/pages.js`: add `export` to `indexPage`, `errorPage`, `redirectPage` (`analyticsSnippet` and `resolveBanners` are already exported).

- [ ] **Step 2: Rewrite `worker.js` as the adapter**

```js
// Cloudflare Workers entry point. All request handling lives in src/core.js so
// the same code can also run under Node (see server.js). The recent-checks
// feed is a Node-only module, so on Workers env.FEED is undefined and the
// feature stays off.
import { handleRequest } from './src/core.js';

export { convertToDota2Id, getConfiguredApiKeys, parseRoute } from './src/core.js';
export { analyticsSnippet, resolveBanners } from './src/pages.js';

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};
```

- [ ] **Step 3: Point the moved tests at the new modules**

In `test/core.test.js` replace the import line with:

```js
import { convertToDota2Id, getConfiguredApiKeys, parseRoute } from '../src/core.js';
import { analyticsSnippet, resolveBanners } from '../src/pages.js';
```

Add one adapter test at the end:

```js
import worker from '../worker.js';

test('worker adapter: serves the home page through handleRequest', async () => {
  const res = await worker.fetch(new Request('https://example.com/'), {}, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /One-line redirect to/);
});
```

- [ ] **Step 4: Run tests and a Worker dry-run build**

Run: `npm test`
Expected: all tests pass (previous count + 1).

Run: `npx wrangler deploy --dry-run --outdir "$TMPDIR/wrangler-dry"`
Expected: build succeeds, no deploy performed.

- [ ] **Step 5: Commit**

```bash
git add -A src test worker.js
git commit -m "refactor: split worker into runtime-agnostic core and pages

Move request handling into src/core.js and the HTML renderers into
src/pages.js. worker.js becomes a thin Cloudflare adapter, so the same
handler can also run under Node. No behaviour change."
```

---

### Task 2: Shared client helpers + core feed hooks + teaser rendering

**Files:**
- Create: `src/client/feed-shared.js`, `test/feed-shared.test.js`, `test/pages.test.js`
- Modify: `src/core.js`, `src/pages.js`
- Test: `test/core.test.js`

**Interfaces:**
- Produces (`src/client/feed-shared.js`): `AVATAR_HASH_RE`, `HOUR_MS`, `avatarUrl(hash) → string`, `pickLang(tag) → 'en'|'ru'|'uk'`, `t(lang, key, vars?) → string`, `ago(lang, ts, now) → string`, `normalize(s)`, `splitTerms(q) → string[]`, `matchesTerms(name, terms) → boolean`, `highlightRanges(name, terms) → [start,end][]`, `timeBlock(ts, now) → 'justNow'|'last5'|'lastHour'`, `dripDelay(queueLen, windowMs?) → ms`, `isNewer(a, b?) → boolean` (later `lastTs`, or same `lastTs` with higher `count`), `diffEntries(entries, known: Map<id, entry>) → entries oldest-first`, `idsToRemove(shown: Map<id, entry>, snapshotEntries, limit?) → id[]`.
- Produces (`src/core.js`): `accountIdToSteamId64(acc) → string|null`, `toSteamId64(value) → string|null`, `isRealBrowser(request) → boolean`, `ipHash(ip, now?) → Promise<string>`.
- Produces (`src/pages.js`): `escapeHtml(s)`, `renderTeaser(teaser, lang, now?) → string`, `indexPage(hostname, analytics, { feed, lang })`, `redirectPage(dest, hostname, analytics, banners, { teaser, lang })`.
- Consumes `env.FEED` contract (implemented in Task 6): `recordHit({ steamId64, ipHash }) → boolean`, `teaser(dotaId) → { hourCount, seen: {lastTs,count}|null, faces: string[] }`, `handle(request) → Promise<Response>`.

- [ ] **Step 1: Write failing tests for the shared helpers** — `test/feed-shared.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  avatarUrl, pickLang, t, ago, splitTerms, matchesTerms, highlightRanges,
  timeBlock, dripDelay, isNewer, diffEntries, idsToRemove
} from '../src/client/feed-shared.js';

const HASH = 'fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb';

test('avatarUrl: only a 40-hex hash builds a Steam CDN URL', () => {
  assert.equal(avatarUrl(HASH), `https://avatars.steamstatic.com/${HASH}_medium.jpg`);
  assert.equal(avatarUrl('javascript:alert(1)'), '');
  assert.equal(avatarUrl(undefined), '');
});

test('pickLang: maps browser / Accept-Language tags', () => {
  assert.equal(pickLang('uk-UA'), 'uk');
  assert.equal(pickLang('ru-RU,ru;q=0.9,en;q=0.8'), 'ru');
  assert.equal(pickLang('be'), 'ru');
  assert.equal(pickLang('de-DE'), 'en');
  assert.equal(pickLang(''), 'en');
  assert.equal(pickLang(null), 'en');
});

test('t: interpolates and falls back to English', () => {
  assert.equal(t('en', 'teaserHour', { n: 132 }), '132 players checked this hour — see if you were →');
  assert.equal(t('ru', 'hits', { n: 3 }), 'совпадений: 3');
  assert.equal(t('xx', 'live'), 'Live');
});

test('ago: seconds and minutes per language', () => {
  const now = 1_000_000;
  assert.equal(ago('en', now - 2000, now), 'just now');
  assert.equal(ago('en', now - 12_000, now), '12s ago');
  assert.equal(ago('en', now - 240_000, now), '4 min ago');
  assert.equal(ago('ru', now - 240_000, now), '4 мин назад');
  assert.equal(ago('uk', now + 5000, now), 'щойно');
});

test('search: any word matches, NFKC + case-insensitive', () => {
  const terms = splitTerms('  Akamai   KVYZE ');
  assert.deepEqual(terms, ['akamai', 'kvyze']);
  assert.equal(matchesTerms('kvyze smurf', terms), true);
  assert.equal(matchesTerms('Ｓｉｌｅｎｔ', splitTerms('silent')), true);
  assert.equal(matchesTerms('pudge', terms), false);
  assert.equal(matchesTerms('anything', []), true);
});

test('highlightRanges: merged, sorted ranges in the original string', () => {
  assert.deepEqual(highlightRanges('akamai_twink akamai', ['akamai']), [[0, 6], [13, 19]]);
  assert.deepEqual(highlightRanges('abcdef', ['bcd', 'cde']), [[1, 5]]);
  assert.deepEqual(highlightRanges('ﬃx', ['ffi']), []); // NFKC changes length: no highlight
});

test('timeBlock and dripDelay', () => {
  const now = 10_000_000;
  assert.equal(timeBlock(now - 30_000, now), 'justNow');
  assert.equal(timeBlock(now - 120_000, now), 'last5');
  assert.equal(timeBlock(now - 900_000, now), 'lastHour');
  assert.equal(dripDelay(1), 3000);
  assert.equal(dripDelay(20), 1500);
  assert.equal(dripDelay(500), 400);
});

test('isNewer / diffEntries: unseen, later, or same-ms higher count; oldest first', () => {
  const known = new Map([
    ['a', { lastTs: 100, count: 1 }],
    ['b', { lastTs: 200, count: 1 }],
    ['d', { lastTs: 50, count: 1 }]
  ]);
  const out = diffEntries([
    { steamId64: 'c', lastTs: 300, count: 1 },
    { steamId64: 'b', lastTs: 250, count: 2 },
    { steamId64: 'a', lastTs: 100, count: 1 },
    { steamId64: 'd', lastTs: 50, count: 2 }
  ], known);
  assert.deepEqual(out.map(e => e.steamId64), ['d', 'b', 'c']);
  assert.equal(isNewer({ lastTs: 5, count: 1 }, undefined), true);
  assert.equal(isNewer({ lastTs: 5, count: 1 }, { lastTs: 6, count: 1 }), false);
  assert.equal(isNewer({ lastTs: 6, count: 1 }, { lastTs: 6, count: 1 }), false);
});

test('idsToRemove: rows missing from an authoritative snapshot', () => {
  const shown = new Map([
    ['keep', { lastTs: 500 }],
    ['gone', { lastTs: 400 }],
    ['old', { lastTs: 10 }]
  ]);
  assert.deepEqual(idsToRemove(shown, [{ steamId64: 'keep', lastTs: 500 }]).sort(), ['gone', 'old']);
  // A full (truncated) snapshot only speaks for its own time range.
  const full = [{ steamId64: 'keep', lastTs: 500 }, { steamId64: 'x', lastTs: 300 }];
  assert.deepEqual(idsToRemove(shown, full, 2), ['gone']);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `node --test test/feed-shared.test.js`
Expected: FAIL — `Cannot find module '…/src/client/feed-shared.js'`.

- [ ] **Step 3: Implement `src/client/feed-shared.js`**

```js
// Shared by the server (redirect teaser) and the browser (/assets/feed.js).
// Pure functions only: no DOM, no Node APIs.

export const AVATAR_HASH_RE = /^[0-9a-f]{40}$/;
export const HOUR_MS = 60 * 60 * 1000;

export function avatarUrl(hash) {
  return AVATAR_HASH_RE.test(hash || '') ? `https://avatars.steamstatic.com/${hash}_medium.jpg` : '';
}

export function pickLang(tag) {
  const primary = String(tag || '').trim().toLowerCase().split(/[,;]/)[0].split('-')[0];
  if (primary === 'uk') return 'uk';
  if (primary === 'ru' || primary === 'be') return 'ru';
  return 'en';
}

const DICT = {
  en: {
    feedTitle: 'Recently checked',
    live: 'Live',
    paused: 'Paused',
    hourCount: '{n} checked this hour',
    searchPlaceholder: 'Your nickname or a few words: akamai kvyze',
    hits: '{n} matches',
    justNow: 'Just now',
    last5: 'Last 5 min',
    lastHour: 'Last hour',
    pillNew: '⏸ Paused · {n} new · back to live ↑',
    pillHover: '⏸ Paused while hovering',
    pill: '⏸ Paused · back to live ↑',
    empty: 'Nobody checked in the last hour yet.',
    dotabuff: 'Dotabuff →',
    agoNow: 'just now',
    agoSec: '{n}s ago',
    agoMin: '{n} min ago',
    teaserSeenOnce: 'This player was checked {ago} — see who else →',
    teaserSeenMany: 'This player was checked {ago} · ×{count} — see who else →',
    teaserHour: '{n} players checked this hour — see if you were →'
  },
  ru: {
    feedTitle: 'Кого сейчас проверяют',
    live: 'Live',
    paused: 'Пауза',
    hourCount: '{n} за час',
    searchPlaceholder: 'Свой ник или пару слов: akamai kvyze',
    hits: 'совпадений: {n}',
    justNow: 'Только что',
    last5: 'Последние 5 мин',
    lastHour: 'Последний час',
    pillNew: '⏸ Пауза · новых: {n} · к live ↑',
    pillHover: '⏸ Пауза, пока курсор на ленте',
    pill: '⏸ Пауза · к live ↑',
    empty: 'За последний час никого не проверяли.',
    dotabuff: 'Dotabuff →',
    agoNow: 'только что',
    agoSec: '{n} сек назад',
    agoMin: '{n} мин назад',
    teaserSeenOnce: 'Этого игрока проверяли {ago} — посмотри, кого ещё →',
    teaserSeenMany: 'Этого игрока проверяли {ago} · ×{count} — посмотри, кого ещё →',
    teaserHour: 'Проверок за час: {n} — проверь, нет ли тебя →'
  },
  uk: {
    feedTitle: 'Кого зараз перевіряють',
    live: 'Live',
    paused: 'Пауза',
    hourCount: '{n} за годину',
    searchPlaceholder: 'Свій нік або кілька слів: akamai kvyze',
    hits: 'збігів: {n}',
    justNow: 'Щойно',
    last5: 'Останні 5 хв',
    lastHour: 'Остання година',
    pillNew: '⏸ Пауза · нових: {n} · до live ↑',
    pillHover: '⏸ Пауза, поки курсор на стрічці',
    pill: '⏸ Пауза · до live ↑',
    empty: 'За останню годину нікого не перевіряли.',
    dotabuff: 'Dotabuff →',
    agoNow: 'щойно',
    agoSec: '{n} с тому',
    agoMin: '{n} хв тому',
    teaserSeenOnce: 'Цього гравця перевіряли {ago} — подивись, кого ще →',
    teaserSeenMany: 'Цього гравця перевіряли {ago} · ×{count} — подивись, кого ще →',
    teaserHour: 'Перевірок за годину: {n} — перевір, чи немає тебе →'
  }
};

export function t(lang, key, vars = {}) {
  const s = (DICT[lang] && DICT[lang][key]) ?? DICT.en[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

export function ago(lang, ts, now) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return t(lang, 'agoNow');
  if (s < 60) return t(lang, 'agoSec', { n: s });
  return t(lang, 'agoMin', { n: Math.floor(s / 60) });
}

export function normalize(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase();
}

export function splitTerms(q) {
  return normalize(q).split(/\s+/).filter(Boolean);
}

export function matchesTerms(name, terms) {
  if (!terms.length) return true;
  const n = normalize(name);
  return terms.some(term => n.includes(term));
}

// Ranges index into the original string, so they are only reliable when
// normalisation keeps the length; otherwise no highlight (the row still matches).
export function highlightRanges(name, terms) {
  const n = normalize(name);
  if (!terms.length || n.length !== String(name).length) return [];
  const ranges = [];
  for (const term of terms) {
    let i = n.indexOf(term);
    while (i !== -1) {
      ranges.push([i, i + term.length]);
      i = n.indexOf(term, i + term.length);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

export function timeBlock(ts, now) {
  const s = (now - ts) / 1000;
  if (s < 60) return 'justNow';
  if (s < 300) return 'last5';
  return 'lastHour';
}

export function dripDelay(queueLen, windowMs = 30000) {
  if (queueLen <= 0) return 0;
  return Math.min(3000, Math.max(400, Math.floor(windowMs / queueLen)));
}

// a supersedes b: a later check, or the same millisecond with a higher count.
export function isNewer(a, b) {
  return !b || a.lastTs > b.lastTs || (a.lastTs === b.lastTs && a.count > b.count);
}

export function diffEntries(entries, known) {
  return entries
    .filter(e => isNewer(e, known.get(e.steamId64)))
    .sort((a, b) => a.lastTs - b.lastTs);
}

// Snapshots are authoritative: anything shown but absent (opted out, went
// private) is removed. A snapshot cut at `limit` only covers its own time range.
export function idsToRemove(shown, entries, limit = 200) {
  const present = new Set(entries.map(e => e.steamId64));
  const floor = entries.length >= limit ? Math.min(...entries.map(e => e.lastTs)) : -Infinity;
  return [...shown].filter(([id, e]) => !present.has(id) && e.lastTs >= floor).map(([id]) => id);
}
```

- [ ] **Step 4: Run** `node --test test/feed-shared.test.js` — Expected: PASS.

- [ ] **Step 5: Write failing core + pages tests**

Append to `test/core.test.js`:

```js
import { handleRequest, toSteamId64, accountIdToSteamId64, isRealBrowser, ipHash } from '../src/core.js';

const BROWSER = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  'cf-connecting-ip': '203.0.113.7'
};
const ctx = { waitUntil() {} };

function fakeFeed(teaser = { hourCount: 5, seen: null, faces: [] }) {
  const calls = [];
  return {
    calls,
    recordHit(hit) { calls.push(['recordHit', hit]); return true; },
    teaser(dotaId) { calls.push(['teaser', dotaId]); return teaser; },
    async handle(request) { calls.push(['handle', new URL(request.url).pathname]); return new Response('api'); }
  };
}

test('toSteamId64 / accountIdToSteamId64: all ID forms', () => {
  assert.equal(toSteamId64('76561197960287930'), '76561197960287930');
  assert.equal(toSteamId64('[U:1:22202]'), '76561197960287930');
  assert.equal(toSteamId64('U:1:22202'), '76561197960287930');
  assert.equal(toSteamId64('garbage'), null);
  assert.equal(accountIdToSteamId64('22202'), '76561197960287930');
  assert.equal(accountIdToSteamId64('12345678901'), null);
});

test('isRealBrowser: filters bots, previews and non-HTML requests', () => {
  const mk = (h, method = 'GET') => new Request('https://example.com/profiles/1', { method, headers: h });
  assert.equal(isRealBrowser(mk(BROWSER)), true);
  assert.equal(isRealBrowser(mk({ ...BROWSER, 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0)' })), false);
  assert.equal(isRealBrowser(mk({ ...BROWSER, 'user-agent': 'TelegramBot (like TwitterBot)' })), false);
  assert.equal(isRealBrowser(mk({ ...BROWSER, accept: 'application/json' })), false);
  assert.equal(isRealBrowser(mk({ ...BROWSER, 'user-agent': '' })), false);
  assert.equal(isRealBrowser(mk(BROWSER, 'HEAD')), false);
});

test('ipHash: stable within a day, short hex', async () => {
  const a = await ipHash('203.0.113.7', Date.UTC(2026, 9, 10, 12));
  const b = await ipHash('203.0.113.7', Date.UTC(2026, 9, 10, 18));
  const c = await ipHash('198.51.100.1', Date.UTC(2026, 9, 10, 18));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('redirect with feed: teaser computed BEFORE the hit, hit recorded, no-store', async () => {
  const feed = fakeFeed();
  const res = await handleRequest(new Request('https://example.com/profiles/[U:1:22202]', { headers: BROWSER }), { FEED: feed }, ctx);
  assert.deepEqual(feed.calls.map(c => c[0]), ['teaser', 'recordHit']);
  assert.equal(feed.calls[0][1], '22202');
  assert.equal(feed.calls[1][1].steamId64, '76561197960287930');
  assert.match(feed.calls[1][1].ipHash, /^[0-9a-f]{16}$/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = await res.text();
  assert.match(html, /5 players checked this hour/);
  assert.match(html, /<noscript><meta http-equiv="refresh"/);
});

test('redirect with feed: bots get the page but are not recorded', async () => {
  const feed = fakeFeed();
  const res = await handleRequest(new Request('https://example.com/profiles/76561197960287930', {
    headers: { ...BROWSER, 'user-agent': 'facebookexternalhit/1.1' }
  }), { FEED: feed }, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(feed.calls.map(c => c[0]), ['teaser']);
});

test('redirect with feed: a throwing feed never breaks the redirect', async () => {
  const feed = { recordHit() { throw new Error('boom'); }, teaser() { throw new Error('boom'); }, handle() {} };
  const res = await handleRequest(new Request('https://example.com/profiles/76561197960287930', { headers: BROWSER }), { FEED: feed }, ctx);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /dotabuff\.com\/players\/22202/);
});

test('redirect without feed: unchanged caching, no teaser, meta refresh in noscript', async () => {
  const res = await handleRequest(new Request('https://example.com/profiles/76561197960287930', { headers: BROWSER }), {}, ctx);
  assert.equal(res.headers.get('cache-control'), 'max-age=300');
  const html = await res.text();
  assert.doesNotMatch(html, /id="teaser"/);
  assert.match(html, /<noscript><meta http-equiv="refresh" content="1;url=https:\/\/www\.dotabuff\.com\/players\/22202"><\/noscript>/);
});

test('teaser language follows Accept-Language', async () => {
  const res = await handleRequest(new Request('https://example.com/profiles/76561197960287930', {
    headers: { ...BROWSER, 'accept-language': 'ru-RU,ru;q=0.9' }
  }), { FEED: fakeFeed() }, ctx);
  assert.match(await res.text(), /Проверок за час: 5/);
});

test('/api/* goes to the feed when present, 404 page otherwise', async () => {
  const feed = fakeFeed();
  const withFeed = await handleRequest(new Request('https://example.com/api/recent.json'), { FEED: feed }, ctx);
  assert.equal(await withFeed.text(), 'api');
  assert.deepEqual(feed.calls[0], ['handle', '/api/recent.json']);
  const without = await handleRequest(new Request('https://example.com/api/recent.json'), {}, ctx);
  assert.equal(without.status, 404);
});

test('home page renders the feed section only with a feed', async () => {
  const withFeed = await (await handleRequest(new Request('https://example.com/'), { FEED: fakeFeed() }, ctx)).text();
  assert.match(withFeed, /id="feed-section"/);
  assert.match(withFeed, /<script type="module" src="\/assets\/feed\.js"><\/script>/);
  const without = await (await handleRequest(new Request('https://example.com/'), {}, ctx)).text();
  assert.doesNotMatch(without, /feed-section/);
});
```

Create `test/pages.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTeaser, escapeHtml } from '../src/pages.js';

const HASH = 'fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb';
const NOW = 1_800_000_000_000;

test('renderTeaser: nothing without data or when the hour is empty', () => {
  assert.equal(renderTeaser(null, 'en', NOW), '');
  assert.equal(renderTeaser({ hourCount: 0, seen: null, faces: [] }, 'en', NOW), '');
});

test('renderTeaser: personal "seen" line wins over the hour counter', () => {
  const once = renderTeaser({ hourCount: 9, seen: { lastTs: NOW - 240_000, count: 1 }, faces: [HASH] }, 'en', NOW);
  assert.match(once, /This player was checked 4 min ago — see who else →/);
  assert.doesNotMatch(once, /<img/);
  const many = renderTeaser({ hourCount: 9, seen: { lastTs: NOW - 240_000, count: 3 }, faces: [] }, 'en', NOW);
  assert.match(many, /· ×3 — see who else/);
});

test('renderTeaser: hour line with up to 3 validated avatars', () => {
  const html = renderTeaser({ hourCount: 132, seen: null, faces: [HASH, 'bad"><script>', HASH, HASH, HASH] }, 'en', NOW);
  assert.match(html, /132 players checked this hour/);
  assert.equal((html.match(/<img /g) || []).length, 3);
  assert.doesNotMatch(html, /script/);
  assert.match(html, /^<a class="teaser" id="teaser" href="\/">/);
});

test('escapeHtml: escapes the five HTML specials', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});
```

- [ ] **Step 6: Run** `npm test` — Expected: FAIL (missing exports `toSteamId64`, `renderTeaser`, …).

- [ ] **Step 7: Implement core additions** — in `src/core.js`:

Add below `convertToDota2Id`:

```js
const STEAM64_BASE = 76561197960265728n;

export function accountIdToSteamId64(accountId) {
  const s = String(accountId ?? '').trim();
  if (!/^\d{1,10}$/.test(s)) return null;
  return (BigInt(s) + STEAM64_BASE).toString();
}

// Any supported profile ID form (SteamID64, [U:1:x], U:1:x) → SteamID64.
export function toSteamId64(value) {
  const s = String(value ?? '').trim();
  if (/^\d{17}$/.test(s)) return s;
  const m = s.match(/^\[?U:1:(\d+)\]?$/i);
  return m ? accountIdToSteamId64(m[1]) : null;
}

// Link-preview bots and crawlers fetch profile URLs too; only real page views
// should show up in the recent-checks feed.
const BOT_UA_RE = /bot|crawl|spider|preview|discord|telegram|whatsapp|slack|facebookexternalhit|twitterbot|skype|embed/i;

export function isRealBrowser(request) {
  if (request.method !== 'GET') return false;
  if (!(request.headers.get('accept') || '').includes('text/html')) return false;
  const ua = request.headers.get('user-agent') || '';
  return ua.length > 0 && !BOT_UA_RE.test(ua);
}

// Rate-limit key for the feed. The salt is random, in memory only, and rotates
// daily, so the hash cannot be reversed or linked across days. IPs are never
// stored.
let saltDay = '';
let salt = '';
export async function ipHash(ip, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (day !== saltDay) {
    saltDay = day;
    salt = crypto.randomUUID();
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${ip || ''}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
}
```

Add `import { pickLang } from './client/feed-shared.js';` to the imports and replace `handleRequest` with:

```js
export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname, hostname } = url;
  if (env.FEED && pathname.startsWith('/api/')) return env.FEED.handle(request);
  const route = parseRoute(pathname);
  if (route.kind === 'favicon') return handleFavicon();
  const analytics = analyticsSnippet(env);
  const lang = pickLang(request.headers.get('accept-language'));
  if (route.kind === 'home') {
    return new Response(indexPage(hostname, analytics, { feed: Boolean(env.FEED), lang }), {
      status: 200,
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'max-age=3600' }
    });
  }
  if (route.kind === 'redirect-base') {
    return Response.redirect(base, 301);
  }
  if (route.kind === 'unknown') {
    return new Response(
      errorPage(hostname, 404, "Not Found", "Only /id/{vanity} and /profiles/{steamID} are supported.", analytics),
      { status: 404, headers: { 'Content-Type': 'text/html' } }
    );
  }
  try {
    let linkid;
    let steamId64 = null;
    if (route.kind === 'id') {
      steamId64 = await getId(route.value, env);
      linkid = steamId64 ? convertToDota2Id(steamId64) : null;
    } else {
      linkid = convertToDota2Id(route.value);
      steamId64 = linkid ? toSteamId64(route.value) : null;
    }
    if (!linkid) {
      return new Response(
        errorPage(hostname, 404, "Profile Not Found", "We could not resolve a valid Steam ID for the provided URL.", analytics),
        { status: 404, headers: { 'Content-Type': 'text/html' } }
      );
    }
    const destinationURL = `${base}players/${linkid}`;
    let teaser = null;
    if (env.FEED) {
      // Teaser first: it must reflect earlier visits, not the one being served.
      try { teaser = env.FEED.teaser(linkid); } catch (e) { console.error("Feed teaser failed:", e); }
      if (steamId64 && isRealBrowser(request)) {
        try {
          env.FEED.recordHit({ steamId64, ipHash: await ipHash(request.headers.get('cf-connecting-ip')) });
        } catch (e) {
          console.error("Feed recordHit failed:", e);
        }
      }
    }
    return new Response(
      redirectPage(destinationURL, hostname, analytics, resolveBanners(env), { teaser, lang }),
      { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': env.FEED ? 'no-store' : 'max-age=300' } }
    );
  } catch (error) {
    // (keep the existing catch block unchanged)
  }
}
```

(Keep the original `catch (error) { … }` body verbatim.)

- [ ] **Step 8: Implement pages additions** — in `src/pages.js`:

At the top:

```js
import { t, ago, avatarUrl } from './client/feed-shared.js';

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// One-line teaser on the redirect interstitial. Rendered server-side so it is
// visible on the first frame of a 1-second page.
export function renderTeaser(teaser, lang = 'en', now = Date.now()) {
  if (!teaser) return '';
  let text;
  let faces = '';
  if (teaser.seen) {
    const key = teaser.seen.count > 1 ? 'teaserSeenMany' : 'teaserSeenOnce';
    text = t(lang, key, { ago: ago(lang, teaser.seen.lastTs, now), count: teaser.seen.count });
  } else if (teaser.hourCount > 0) {
    text = t(lang, 'teaserHour', { n: teaser.hourCount });
    faces = (teaser.faces || []).map(avatarUrl).filter(Boolean).slice(0, 3)
      .map(src => `<img src="${src}" alt="" width="20" height="20">`).join('');
  } else {
    return '';
  }
  return `<a class="teaser" id="teaser" href="/">${faces ? `<span class="faces">${faces}</span>` : ''}<span>${escapeHtml(text)}</span></a>`;
}
```

In `redirectPage`:
- Signature: `export function redirectPage(destinationURL, hostname, analytics = '', banners = [], opts = {}) {` and first line inside: `const teaserHtml = renderTeaser(opts.teaser, opts.lang || 'en');`
- Replace `<meta http-equiv="refresh" content="${delaySeconds};url=${destinationURL}">` with `<noscript><meta http-equiv="refresh" content="${delaySeconds};url=${destinationURL}"></noscript>`.
- In the inline script, directly after `function go() { window.location.replace(DEST); }` add:

```js
      var timer = null;
      function later(ms) { timer = setTimeout(go, ms); }
      // The teaser links to the home page; clicking it must cancel the redirect.
      document.addEventListener("click", function(e) {
        if (e.target.closest && e.target.closest("#teaser")) clearTimeout(timer);
      });
```

  and replace each `setTimeout(go, QUICK_MS)` / `setTimeout(go, BANNER_MS)` with `later(QUICK_MS)` / `later(BANNER_MS)` (three occurrences).
- In `<body>`, directly after `<p class="redirect-message">Taking you to the Dotabuff profile…</p>` insert `${teaserHtml}`.
- Add to the `<style>` block (before the `${banner ? …}` part):

```css
    .teaser {
      display: inline-flex; align-items: center; gap: 10px;
      margin: 4px auto 18px; padding: 8px 16px; border-radius: 999px;
      background: rgba(102,192,244,0.1); border: 1px solid rgba(102,192,244,0.3);
      color: var(--text); font-size: 0.92rem; font-weight: 500;
      animation: teaser-in .35s ease-out both;
    }
    .teaser:hover { border-color: var(--accent); text-decoration: none; }
    .teaser .faces { display: inline-flex; }
    .teaser .faces img { width: 20px; height: 20px; border-radius: 6px; border: 2px solid var(--bg); margin-left: -6px; }
    .teaser .faces img:first-child { margin-left: 0; }
    html.show-banner .teaser { animation: none; }
    @keyframes teaser-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .teaser { animation: none; } }
```

In `indexPage`:
- Signature: `export function indexPage(hostname, analytics = '', opts = {}) {` with `const feed = Boolean(opts.feed);`.
- Add `--gold: #f5c451;` to `:root`.
- Before `</style>` add `${feed ? FEED_CSS : ''}`; after `</header>` add `${feed ? FEED_SECTION : ''}`; before `</body>` add `${feed ? '<script type="module" src="/assets/feed.js"></script>' : ''}`.
- Define above `indexPage`:

```js
const FEED_SECTION = `
    <section class="fd" id="feed-section" aria-label="Recently checked players" hidden>
      <div class="fd-head">
        <h2 data-i18n="feedTitle">Recently checked</h2>
      </div>
      <div class="fd-search">
        <input id="feed-q" type="search" autocomplete="off" spellcheck="false" aria-label="Filter by nickname">
        <span class="fd-hits" id="feed-hits" aria-live="polite"></span>
      </div>
      <div class="fd-box" id="feed">
        <div class="fd-top">
          <span class="fd-live"><i></i><span id="feed-live" data-i18n="live">Live</span></span>
          <span class="fd-count" id="feed-count"></span>
        </div>
        <button class="fd-pill" id="feed-pill" type="button"><span id="feed-pill-text"></span><span class="fd-bar" id="feed-bar"></span></button>
        <div class="fd-list" id="feed-list" tabindex="0" aria-label="Recently checked players"></div>
      </div>
    </section>`;

const FEED_CSS = `
    .fd { margin-bottom: 40px; }
    .fd-head h2 { margin: 0 0 12px; font-size: 1rem; color: var(--accent); letter-spacing: 0.04em; text-transform: uppercase; }
    .fd-search { display: flex; gap: 10px; margin-bottom: 12px; align-items: center; }
    .fd-search input {
      flex: 1; min-width: 0; font: inherit; font-size: 15px; color: var(--text); background: var(--surface);
      border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; outline: none;
    }
    .fd-search input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(102,192,244,0.18); }
    .fd-hits { color: var(--muted); font-size: 13px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .fd-box { position: relative; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    .fd-top { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--border); font-size: 13px; color: var(--muted); }
    .fd-live { display: inline-flex; align-items: center; gap: 7px; color: var(--text); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; font-size: 12px; }
    .fd-live i { width: 8px; height: 8px; border-radius: 50%; background: #e5484d; }
    .fd-box.paused .fd-live i { background: var(--gold); }
    .fd-count { font-variant-numeric: tabular-nums; }
    .fd-list { height: 392px; overflow-y: auto; overscroll-behavior: contain; background: var(--bg); scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
    .fd-blk { position: sticky; top: 0; z-index: 1; padding: 6px 16px; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); background: var(--bg-2); }
    .fd-row { height: 56px; display: flex; align-items: center; gap: 12px; padding: 0 16px; overflow: hidden; }
    .fd-row + .fd-row { border-top: 1px solid rgba(42,56,72,0.55); }
    .fd-row:hover { background: rgba(102,192,244,0.05); }
    .fd-row[hidden] { display: none; }
    .fd-row.fd-pinned { animation: fd-flash 1.6s ease-out; }
    .fd-av { width: 36px; height: 36px; border-radius: 8px; flex: none; background: var(--surface-2); object-fit: cover; }
    .fd-who { flex: 1; min-width: 0; }
    .fd-nick { font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; unicode-bidi: isolate; }
    .fd-nick mark { background: rgba(102,192,244,0.25); color: var(--text); border-radius: 3px; padding: 0 1px; }
    .fd-meta { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .fd-x { font-size: 11px; font-weight: 700; color: var(--gold); background: rgba(245,196,81,0.12); border-radius: 6px; padding: 1px 6px; margin-left: 6px; }
    .fd-go { color: var(--accent); font-size: 13px; font-weight: 600; white-space: nowrap; }
    .fd-empty { padding: 24px 16px; color: var(--muted); text-align: center; font-size: 14px; }
    .fd-flap { display: inline-block; min-width: 0.55em; text-align: center; }
    .fd-flap.spin { color: var(--accent); }
    .fd-flip { animation: fd-flip .45s cubic-bezier(.3,1.4,.5,1); transform-origin: top; }
    @keyframes fd-flip { from { transform: rotateX(-90deg); } to { transform: rotateX(0); } }
    @keyframes fd-flash { from { background: rgba(245,196,81,0.2); } to { background: transparent; } }
    .fd-pill {
      position: absolute; left: 50%; top: 48px; transform: translate(-50%, -8px); opacity: 0; pointer-events: none; z-index: 3;
      background: var(--surface-2); border: 1px solid #3b5068; color: var(--text); border-radius: 999px;
      padding: 7px 14px 9px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap;
      box-shadow: 0 6px 20px rgba(0,0,0,0.4); transition: opacity .18s, transform .18s; overflow: hidden;
    }
    .fd-box.paused .fd-pill { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
    .fd-bar { position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; background: var(--accent); transform-origin: left; }
    @media (prefers-reduced-motion: reduce) { .fd-flip, .fd-row.fd-pinned { animation: none; } .fd-pill { transition: none; } }
    @media (max-width: 480px) { .fd-list { height: 336px; } .fd-go { font-size: 12px; } }`;
```

- [ ] **Step 9: Run** `npm test` — Expected: PASS (all suites). Then `npx wrangler deploy --dry-run --outdir "$TMPDIR/wrangler-dry"` — Expected: builds.

- [ ] **Step 10: Commit**

```bash
git add src test
git commit -m "feat(core): feed hooks, server-rendered teaser and noscript refresh

handleRequest now accepts an optional env.FEED: /api/* is delegated to
it, real-browser redirects record a hit (bots and link previews are
skipped), and the redirect page renders a one-line teaser computed
before the hit so visitors never see their own visit. With a feed the
redirect is no-store; without one caching is unchanged.

The meta-refresh fallback moves into <noscript> so the JS timer is the
only redirect and a teaser click can cancel it. Shared, DOM-free
helpers (i18n en/ru/uk, search, time blocks) live in
src/client/feed-shared.js for both server and browser."
```

---

### Task 3: Nickname sanitiser and list loaders

**Files:**
- Create: `src/feed/sanitize.js`, `test/sanitize.test.js`

**Interfaces:**
- Produces: `sanitizeName(raw, blockedWords?) → string` (never empty; `'—'` fallback), `maskBlocked(s, blockedWords) → string`, `loadWords(path?, log?) → string[]` (NFKC-lowercased), `loadIds(path?, log?) → Set<string>` (valid SteamID64s only).

- [ ] **Step 1: Write the failing test** — `test/sanitize.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sanitizeName, maskBlocked, loadWords, loadIds } from '../src/feed/sanitize.js';

test('sanitizeName: strips control and bidi characters', () => {
  assert.equal(sanitizeName('abc‮def\u0007'), 'abcdef');
  assert.equal(sanitizeName('⁦x⁩'), 'x');
});

test('sanitizeName: caps combining marks (anti-zalgo)', () => {
  assert.equal(sanitizeName('a' + '́'.repeat(12)), 'á́');
});

test('sanitizeName: caps length at 32 graphemes, keeps emoji whole', () => {
  assert.equal(sanitizeName('x'.repeat(50)).length, 32);
  const flags = '🇺🇦'.repeat(40);
  assert.equal(sanitizeName(flags), '🇺🇦'.repeat(32));
});

test('sanitizeName: markup stays literal text (escaping is the renderer\'s job)', () => {
  assert.equal(sanitizeName('<script>alert(1)</script>'), '<script>alert(1)</script>');
});

test('sanitizeName: empty result falls back to an em dash', () => {
  assert.equal(sanitizeName('‮\u0000'), '—');
  assert.equal(sanitizeName(undefined), '—');
});

test('maskBlocked: case-insensitive after NFKC, length-preserving bullets', () => {
  assert.equal(maskBlocked('Hello BADWORD x', ['badword']), 'Hello ••••••• x');
  assert.equal(maskBlocked('ｂａｄｗｏｒｄ', ['badword']), '•••••••');
  assert.equal(maskBlocked('clean', ['badword']), 'clean');
  assert.equal(sanitizeName('my badword nick', ['badword']), 'my ••••••• nick');
});

test('loadWords / loadIds: comments, blanks, validation, missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-lists-'));
  const words = join(dir, 'words.txt');
  const ids = join(dir, 'ids.txt');
  writeFileSync(words, '# comment\nBadWord\n\n  ｓｌｕｒ  \n');
  writeFileSync(ids, '76561197960287930\nnot-an-id\n# 76561197960287931\n');
  assert.deepEqual(loadWords(words), ['badword', 'slur']);
  assert.deepEqual([...loadIds(ids)], ['76561197960287930']);
  const quiet = { warn() {} };
  assert.deepEqual(loadWords(join(dir, 'missing.txt'), quiet), []);
  assert.deepEqual(loadWords(undefined), []);
});
```

- [ ] **Step 2: Run** `node --test test/sanitize.test.js` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/feed/sanitize.js`

```js
import { readFileSync } from 'node:fs';

const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
const BIDI_RE = /[؜‎‏‪-‮⁦-⁩]/g;
const EXCESS_MARKS_RE = /(\p{M}{2})\p{M}+/gu;
const MAX_GRAPHEMES = 32;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

// Steam persona names are arbitrary Unicode. Clean them once, before storing,
// so every consumer (JSON, SSE, teaser) gets the same safe text.
export function sanitizeName(raw, blockedWords = []) {
  let s = String(raw ?? '')
    .replace(CONTROL_RE, '')
    .replace(BIDI_RE, '')
    .replace(EXCESS_MARKS_RE, '$1')
    .trim();
  const graphemes = Array.from(segmenter.segment(s), g => g.segment);
  if (graphemes.length > MAX_GRAPHEMES) s = graphemes.slice(0, MAX_GRAPHEMES).join('');
  if (blockedWords.length) s = maskBlocked(s, blockedWords);
  return s || '—';
}

export function maskBlocked(s, blockedWords) {
  const folded = s.normalize('NFKC');
  let lower = folded.toLowerCase();
  if (lower.length !== folded.length) lower = folded;
  let out = folded;
  let hit = false;
  for (const word of blockedWords) {
    if (!word) continue;
    let i = lower.indexOf(word);
    while (i !== -1) {
      const mask = '•'.repeat(word.length);
      out = out.slice(0, i) + mask + out.slice(i + word.length);
      lower = lower.slice(0, i) + mask + lower.slice(i + word.length);
      hit = true;
      i = lower.indexOf(word, i + word.length);
    }
  }
  return hit ? out : s;
}

function readLines(path, log) {
  if (!path) return [];
  try {
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch (e) {
    log.warn(`Could not read ${path}: ${e.message}`);
    return [];
  }
}

export function loadWords(path, log = console) {
  return readLines(path, log).map(w => w.normalize('NFKC').toLowerCase());
}

export function loadIds(path, log = console) {
  return new Set(readLines(path, log).filter(line => /^7656119\d{10}$/.test(line)));
}
```

- [ ] **Step 4: Run** `node --test test/sanitize.test.js` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/feed/sanitize.js test/sanitize.test.js
git commit -m "feat(feed): nickname sanitiser and opt-out/blocked-word lists

Strip control and bidi characters, cap combining marks and length, and
mask configured words before persona names are stored. Loaders read
the optional blocked-words and hidden-ids files."
```

---

### Task 4: SQLite store, KV shim and rate limiter

**Files:**
- Create: `src/feed/store.js`, `src/feed/ratelimit.js`, `test/store.test.js`

**Interfaces:**
- Produces: `openDb(path) → DatabaseSync`; `new SqliteKV(db, namespace, clock?)` with async `get(key) → string|null`, `put(key, value, { expirationTtl? })`, `delete(key)`; `new FeedStore(db, clock?)` with `addCheck(steamId64, ts?)`, `takePending(limit) → string[]`, `pendingCount() → number`, `getPlayer(id) → {steamid,name,avatarHash,visible,fetchedAt}|null`, `freshPlayerIds(ids, maxAgeMs) → Set`, `completePending(ids, players[{steamid,name,avatarHash,visible,fetchedAt}])`, `recent(sinceTs, limit) → [{steamId64,name,avatarHash,lastTs,count}]`, `hourCount(sinceTs) → number` (checks of visible players only), `seen(steamId64, sinceTs) → {lastTs,count}|null`, `purge(now?)`; `new RateLimiter(limit, windowMs, clock?)` with `allow(key) → boolean`.

- [ ] **Step 1: Write the failing test** — `test/store.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, SqliteKV, FeedStore } from '../src/feed/store.js';
import { RateLimiter } from '../src/feed/ratelimit.js';

const A = '76561197960287930';
const B = '76561197960287931';

function clockAt(start) {
  const c = () => c.now;
  c.now = start;
  return c;
}

test('SqliteKV: get/put/delete with namespaces and TTL', async () => {
  const db = openDb(':memory:');
  const clock = clockAt(1000);
  const kv = new SqliteKV(db, 'one', clock);
  const other = new SqliteKV(db, 'two', clock);
  assert.equal(await kv.get('k'), null);
  await kv.put('k', 'v', { expirationTtl: 60 });
  await kv.put('forever', 'x');
  assert.equal(await kv.get('k'), 'v');
  assert.equal(await other.get('k'), null);
  clock.now += 61_000;
  assert.equal(await kv.get('k'), null);
  assert.equal(await kv.get('forever'), 'x');
  await kv.delete('forever');
  assert.equal(await kv.get('forever'), null);
});

test('FeedStore: checks feed pending; completion stores players atomically', () => {
  const clock = clockAt(10_000_000);
  const store = new FeedStore(openDb(':memory:'), clock);
  store.addCheck(A);
  store.addCheck(A);
  store.addCheck(B);
  assert.equal(store.pendingCount(), 2);
  assert.deepEqual(store.takePending(10), [A, B]);
  store.completePending([A, B], [
    { steamid: A, name: 'akamai', avatarHash: 'a'.repeat(40), visible: 1, fetchedAt: clock() },
    { steamid: B, name: 'hidden', avatarHash: '', visible: 0, fetchedAt: clock() }
  ]);
  assert.equal(store.pendingCount(), 0);
  const recent = store.recent(clock() - 3_600_000, 10);
  assert.deepEqual(recent, [{ steamId64: A, name: 'akamai', avatarHash: 'a'.repeat(40), lastTs: clock(), count: 2 }]);
  assert.equal(store.hourCount(clock() - 3_600_000), 2); // B is private: not counted
  assert.deepEqual(store.seen(A, clock() - 3_600_000), { lastTs: clock(), count: 2 });
  assert.equal(store.seen('76561197960287999', clock() - 3_600_000), null);
});

test('FeedStore: completePending rolls back as a unit on error', () => {
  const store = new FeedStore(openDb(':memory:'), clockAt(5));
  store.addCheck(A);
  assert.throws(() => store.completePending([A], [{ steamid: A, name: null, avatarHash: '', visible: 1, fetchedAt: 5 }]));
  assert.equal(store.pendingCount(), 1);
  assert.equal(store.getPlayer(A), null);
});

test('FeedStore: freshPlayerIds and purge', () => {
  const clock = clockAt(100 * 86_400_000);
  const store = new FeedStore(openDb(':memory:'), clock);
  store.addCheck(A, clock() - 2 * 86_400_000);
  store.completePending([A], [{ steamid: A, name: 'old', avatarHash: '', visible: 1, fetchedAt: clock() - 8 * 86_400_000 }]);
  store.addCheck(B);
  store.completePending([B], [{ steamid: B, name: 'new', avatarHash: '', visible: 1, fetchedAt: clock() }]);
  assert.deepEqual([...store.freshPlayerIds([A, B], 6 * 3_600_000)], [B]);
  store.purge();
  assert.equal(store.getPlayer(A), null);
  assert.equal(store.getPlayer(B).name, 'new');
  assert.equal(store.hourCount(0), 1);
});

test('RateLimiter: fixed window per key', () => {
  const clock = clockAt(0);
  const rl = new RateLimiter(2, 60_000, clock);
  assert.equal(rl.allow('x'), true);
  assert.equal(rl.allow('x'), true);
  assert.equal(rl.allow('x'), false);
  assert.equal(rl.allow('y'), true);
  clock.now = 60_000;
  assert.equal(rl.allow('x'), true);
});
```

- [ ] **Step 2: Run** `node --test test/store.test.js` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/feed/store.js`

```js
import { DatabaseSync } from 'node:sqlite';

const DAY_MS = 24 * 60 * 60 * 1000;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS pending (steamid TEXT PRIMARY KEY, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL, hits INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS players (steamid TEXT PRIMARY KEY, name TEXT NOT NULL, avatar_hash TEXT NOT NULL, visible INTEGER NOT NULL, fetched_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS checks (steamid TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS checks_ts ON checks(ts);
CREATE INDEX IF NOT EXISTS checks_steamid_ts ON checks(steamid, ts);
`;

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

// Same surface as the Workers KV binding methods the core uses, so getId()
// and the API-key health helpers run unchanged under Node.
export class SqliteKV {
  constructor(db, namespace, clock = Date.now) {
    this.prefix = `${namespace}:`;
    this.clock = clock;
    this.getStmt = db.prepare('SELECT value, expires_at FROM kv WHERE key = ?');
    this.putStmt = db.prepare(
      'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at'
    );
    this.delStmt = db.prepare('DELETE FROM kv WHERE key = ?');
  }

  async get(key) {
    const row = this.getStmt.get(this.prefix + key);
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= this.clock()) {
      this.delStmt.run(this.prefix + key);
      return null;
    }
    return row.value;
  }

  async put(key, value, options = {}) {
    const ttl = Number(options.expirationTtl);
    const expiresAt = Number.isFinite(ttl) && ttl > 0 ? this.clock() + ttl * 1000 : null;
    this.putStmt.run(this.prefix + key, String(value), expiresAt);
  }

  async delete(key) {
    this.delStmt.run(this.prefix + key);
  }
}

export class FeedStore {
  constructor(db, clock = Date.now) {
    this.db = db;
    this.clock = clock;
    this.s = {
      insertCheck: db.prepare('INSERT INTO checks (steamid, ts) VALUES (?, ?)'),
      upsertPending: db.prepare(
        'INSERT INTO pending (steamid, first_ts, last_ts, hits) VALUES (?, ?, ?, 1) ' +
        'ON CONFLICT(steamid) DO UPDATE SET last_ts = excluded.last_ts, hits = hits + 1'
      ),
      takePending: db.prepare('SELECT steamid FROM pending ORDER BY first_ts LIMIT ?'),
      pendingCount: db.prepare('SELECT COUNT(*) AS n FROM pending'),
      deletePending: db.prepare('DELETE FROM pending WHERE steamid = ?'),
      upsertPlayer: db.prepare(
        'INSERT INTO players (steamid, name, avatar_hash, visible, fetched_at) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(steamid) DO UPDATE SET name = excluded.name, avatar_hash = excluded.avatar_hash, ' +
        'visible = excluded.visible, fetched_at = excluded.fetched_at'
      ),
      getPlayer: db.prepare(
        'SELECT steamid, name, avatar_hash AS avatarHash, visible, fetched_at AS fetchedAt FROM players WHERE steamid = ?'
      ),
      recent: db.prepare(
        'SELECT c.steamid AS steamId64, p.name AS name, p.avatar_hash AS avatarHash, ' +
        'MAX(c.ts) AS lastTs, COUNT(*) AS count ' +
        'FROM checks c JOIN players p ON p.steamid = c.steamid ' +
        'WHERE c.ts >= ? AND p.visible = 1 ' +
        'GROUP BY c.steamid ORDER BY lastTs DESC LIMIT ?'
      ),
      // Only checks of shown players count, so the number cannot reveal private ones.
      hourCount: db.prepare('SELECT COUNT(*) AS n FROM checks c JOIN players p ON p.steamid = c.steamid WHERE c.ts >= ? AND p.visible = 1'),
      seen: db.prepare('SELECT MAX(ts) AS lastTs, COUNT(*) AS count FROM checks WHERE steamid = ? AND ts >= ?'),
      purgeChecks: db.prepare('DELETE FROM checks WHERE ts < ?'),
      purgePlayers: db.prepare('DELETE FROM players WHERE fetched_at < ? AND steamid NOT IN (SELECT steamid FROM checks)'),
      purgeKv: db.prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?')
    };
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  addCheck(steamId64, ts = this.clock()) {
    this.tx(() => {
      this.s.insertCheck.run(steamId64, ts);
      this.s.upsertPending.run(steamId64, ts, ts);
    });
  }

  takePending(limit) {
    return this.s.takePending.all(limit).map(r => r.steamid);
  }

  pendingCount() {
    return this.s.pendingCount.get().n;
  }

  getPlayer(steamId64) {
    const row = this.s.getPlayer.get(steamId64);
    return row ? { ...row } : null;
  }

  freshPlayerIds(ids, maxAgeMs) {
    const cutoff = this.clock() - maxAgeMs;
    return new Set(ids.filter(id => {
      const p = this.getPlayer(id);
      return p && p.fetchedAt >= cutoff;
    }));
  }

  completePending(ids, players) {
    this.tx(() => {
      for (const p of players) this.s.upsertPlayer.run(p.steamid, p.name, p.avatarHash, p.visible, p.fetchedAt);
      for (const id of ids) this.s.deletePending.run(id);
    });
  }

  recent(sinceTs, limit) {
    return this.s.recent.all(sinceTs, limit).map(r => ({ ...r }));
  }

  hourCount(sinceTs) {
    return this.s.hourCount.get(sinceTs).n;
  }

  seen(steamId64, sinceTs) {
    const r = this.s.seen.get(steamId64, sinceTs);
    return r && r.count > 0 ? { lastTs: r.lastTs, count: r.count } : null;
  }

  purge(now = this.clock()) {
    this.tx(() => {
      this.s.purgeChecks.run(now - DAY_MS);
      this.s.purgePlayers.run(now - 7 * DAY_MS);
      this.s.purgeKv.run(now);
    });
  }
}
```

Implement `src/feed/ratelimit.js`:

```js
// Fixed-window counter per key, in memory only.
export class RateLimiter {
  constructor(limit, windowMs, clock = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
    this.buckets = new Map();
  }

  allow(key) {
    const now = this.clock();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start >= this.windowMs) {
      bucket = { start: now, count: 0 };
      this.buckets.set(key, bucket);
      if (this.buckets.size > 50_000) this.sweep(now);
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }

  sweep(now = this.clock()) {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.start >= this.windowMs) this.buckets.delete(key);
    }
  }
}
```

- [ ] **Step 4: Run** `node --test test/store.test.js` — Expected: PASS. (`node:sqlite` may print an ExperimentalWarning on Node 24; that is fine.)

- [ ] **Step 5: Commit**

```bash
git add src/feed/store.js src/feed/ratelimit.js test/store.test.js
git commit -m "feat(feed): SQLite store, KV shim and rate limiter

One SQLite file holds the pending queue, enriched players, raw checks
and a KV table that mirrors the Workers KV surface used by the core.
Pending completion is transactional so a failed batch can be retried."
```

---

### Task 5: Steam enrichment with batching and backoff

**Files:**
- Create: `src/feed/enrich.js`, `test/enrich.test.js`

**Interfaces:**
- Consumes: `getAvailableApiKeys, markProblemKey, markRateLimitedKey` from `src/core.js`; `sanitizeName` (Task 3); `FeedStore` (Task 4); `AVATAR_HASH_RE` (Task 2).
- Produces: `createSteamSummaries({ env, fetchImpl?, timeoutMs? }) → async (ids[]) → SteamPlayer[]` (throws on malformed payloads); `toPlayerRow(summary, blockedWords, now) → playerRow`; `new Enricher({ store, fetchSummaries, onEntries(ids, removedIds), blockedWords: () => string[], clock?, log? })` with `tick() → Promise<{ processed, error? }>`, `nextDelay() → ms`, `failures`. `removedIds` = ids that were visible before this tick and are not any more (went private / vanished).

- [ ] **Step 1: Write the failing test** — `test/enrich.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, FeedStore } from '../src/feed/store.js';
import { createSteamSummaries, toPlayerRow, Enricher } from '../src/feed/enrich.js';

const HASH = 'fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb';
const quiet = { error() {}, warn() {}, log() {} };
const id = n => (76561197960265728n + BigInt(n)).toString();

function summary(steamid, extra = {}) {
  return { steamid, personaname: `p${steamid.slice(-3)}`, avatarhash: HASH, communityvisibilitystate: 3, ...extra };
}

test('toPlayerRow: sanitises, validates avatar, maps visibility', () => {
  const row = toPlayerRow({ steamid: id(1), personaname: 'x‮y badword', avatarhash: 'nope', communityvisibilitystate: 1 }, ['badword'], 42);
  assert.deepEqual(row, { steamid: id(1), name: 'xy •••••••', avatarHash: '', visible: 0, fetchedAt: 42 });
});

test('createSteamSummaries: calls GetPlayerSummaries and rotates past a rejected key', async () => {
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    if (url.includes('key=bad')) return new Response('', { status: 403 });
    return Response.json({ response: { players: [summary(id(1))] } });
  };
  const fetchSummaries = createSteamSummaries({ env: { STEAM_API_KEY: 'bad', STEAM_API_KEYS: 'good' }, fetchImpl });
  const players = await fetchSummaries([id(1)]);
  assert.equal(players[0].steamid, id(1));
  assert.match(urls[0], /ISteamUser\/GetPlayerSummaries\/v2\/\?key=bad&steamids=76561197960265729/);
  assert.match(urls[1], /key=good/);
});

test('createSteamSummaries: a 200 without a players array is an error', async () => {
  const fetchSummaries = createSteamSummaries({ env: { STEAM_API_KEY: 'k' }, fetchImpl: async () => Response.json({}) });
  await assert.rejects(fetchSummaries([id(1)]), /malformed/);
});

test('Enricher.tick: reports players that turned private since the last fetch', async () => {
  const store = new FeedStore(openDb(':memory:'), () => 100 * 3_600_000);
  store.addCheck(id(1));
  store.completePending([id(1)], [{ steamid: id(1), name: 'was public', avatarHash: HASH, visible: 1, fetchedAt: 0 }]);
  store.addCheck(id(1));
  const seen = [];
  const enricher = new Enricher({
    store,
    fetchSummaries: async ids => ids.map(s => summary(s, { communityvisibilitystate: 1 })),
    onEntries: (ids, removed) => seen.push(removed),
    blockedWords: () => [], clock: () => 100 * 3_600_000, log: quiet
  });
  await enricher.tick();
  assert.deepEqual(seen, [[id(1)]]);
});

test('createSteamSummaries: no keys is an error', async () => {
  await assert.rejects(createSteamSummaries({ env: {}, fetchImpl: async () => Response.json({}) })([id(1)]), /no Steam API keys/);
});

test('Enricher.tick: chunks of 100, private dropped from entries, pending cleared', async () => {
  const store = new FeedStore(openDb(':memory:'), () => 1_000_000);
  for (let i = 1; i <= 150; i++) store.addCheck(id(i));
  const calls = [];
  const announced = [];
  const enricher = new Enricher({
    store,
    fetchSummaries: async ids => { calls.push(ids.length); return ids.map(s => summary(s, s === id(7) ? { communityvisibilitystate: 1 } : {})); },
    onEntries: ids => announced.push(...ids),
    blockedWords: () => [],
    clock: () => 1_000_000,
    log: quiet
  });
  const result = await enricher.tick();
  assert.deepEqual(calls, [100, 50]);
  assert.equal(result.processed, 150);
  assert.equal(store.pendingCount(), 0);
  assert.equal(store.getPlayer(id(7)).visible, 0);
  assert.equal(store.recent(0, 500).length, 149);
  assert.equal(announced.length, 150);
});

test('Enricher.tick: fresh players skip Steam but are still announced', async () => {
  const store = new FeedStore(openDb(':memory:'), () => 2_000_000);
  store.addCheck(id(1));
  store.completePending([id(1)], [{ steamid: id(1), name: 'cached', avatarHash: HASH, visible: 1, fetchedAt: 1_999_000 }]);
  store.addCheck(id(1));
  let called = false;
  const announced = [];
  const enricher = new Enricher({
    store, fetchSummaries: async () => { called = true; return []; },
    onEntries: ids => announced.push(...ids), blockedWords: () => [], clock: () => 2_000_000, log: quiet
  });
  await enricher.tick();
  assert.equal(called, false);
  assert.deepEqual(announced, [id(1)]);
  assert.equal(store.pendingCount(), 0);
});

test('Enricher.tick: Steam failure keeps pending and backs off, success resets', async () => {
  const store = new FeedStore(openDb(':memory:'), () => 1);
  store.addCheck(id(1));
  let fail = true;
  const enricher = new Enricher({
    store,
    fetchSummaries: async ids => { if (fail) throw new Error('Steam down'); return ids.map(s => summary(s)); },
    onEntries() {}, blockedWords: () => [], clock: () => 1, log: quiet
  });
  assert.equal(enricher.nextDelay(), 30_000);
  const r1 = await enricher.tick();
  assert.match(r1.error.message, /Steam down/);
  assert.equal(store.pendingCount(), 1);
  assert.equal(enricher.nextDelay(), 60_000);
  await enricher.tick();
  await enricher.tick();
  await enricher.tick();
  assert.equal(enricher.nextDelay(), 300_000);
  fail = false;
  await enricher.tick();
  assert.equal(store.pendingCount(), 0);
  assert.equal(enricher.nextDelay(), 30_000);
});

test('Enricher.tick: empty queue is a no-op', async () => {
  const store = new FeedStore(openDb(':memory:'));
  const enricher = new Enricher({ store, fetchSummaries: async () => { throw new Error('unused'); }, onEntries() { throw new Error('unused'); }, blockedWords: () => [], log: quiet });
  assert.deepEqual(await enricher.tick(), { processed: 0 });
});
```

- [ ] **Step 2: Run** `node --test test/enrich.test.js` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/feed/enrich.js`

```js
import { getAvailableApiKeys, markProblemKey, markRateLimitedKey } from '../core.js';
import { AVATAR_HASH_RE } from '../client/feed-shared.js';
import { sanitizeName } from './sanitize.js';

const SUMMARIES_URL = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/';
const CHUNK = 100;
const MAX_PER_TICK = 500;
const FRESH_MS = 6 * 60 * 60 * 1000;
const TICK_MS = 30_000;
const MAX_DELAY_MS = 300_000;

export function createSteamSummaries({ env, fetchImpl = fetch, timeoutMs = 5000 }) {
  return async function fetchSummaries(ids) {
    const keys = await getAvailableApiKeys(env);
    if (!keys.length) throw new Error('no Steam API keys configured');
    let lastError = null;
    for (const key of keys) {
      const url = `${SUMMARIES_URL}?key=${encodeURIComponent(key)}&steamids=${ids.join(',')}`;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (res.status === 401 || res.status === 403) {
          await markProblemKey(env, key);
          lastError = new Error(`Steam rejected API key (${res.status})`);
          continue;
        }
        if (res.status === 429) {
          await markRateLimitedKey(env, key, parseInt(res.headers.get('retry-after') || '300', 10));
          lastError = new Error('Steam rate limited');
          continue;
        }
        if (!res.ok) throw new Error(`Steam HTTP ${res.status}`);
        const data = await res.json();
        const players = data?.response?.players;
        // A 200 without a players array is not "everyone vanished": fail so the
        // ids stay queued and the tick backs off.
        if (!Array.isArray(players)) throw new Error('Steam returned a malformed GetPlayerSummaries payload');
        return players;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  };
}

export function toPlayerRow(summary, blockedWords, now) {
  return {
    steamid: String(summary.steamid),
    name: sanitizeName(summary.personaname, blockedWords),
    avatarHash: AVATAR_HASH_RE.test(summary.avatarhash || '') ? summary.avatarhash : '',
    visible: summary.communityvisibilitystate === 3 ? 1 : 0,
    fetchedAt: now
  };
}

export class Enricher {
  constructor({ store, fetchSummaries, onEntries, blockedWords, clock = Date.now, log = console }) {
    Object.assign(this, { store, fetchSummaries, onEntries, blockedWords, clock, log });
    this.failures = 0;
  }

  nextDelay() {
    return Math.min(TICK_MS * 2 ** this.failures, MAX_DELAY_MS);
  }

  // One batch: up to 500 queued ids, Steam calls of 100. On any Steam failure
  // nothing is committed, so the ids stay queued for the next (backed-off) tick.
  async tick() {
    const ids = this.store.takePending(MAX_PER_TICK);
    if (!ids.length) return { processed: 0 };
    const now = this.clock();
    const fresh = this.store.freshPlayerIds(ids, FRESH_MS);
    const stale = ids.filter(id => !fresh.has(id));
    const wasVisible = new Set(stale.filter(id => this.store.getPlayer(id)?.visible));
    const players = [];
    try {
      for (let i = 0; i < stale.length; i += CHUNK) {
        const chunk = stale.slice(i, i + CHUNK);
        const got = await this.fetchSummaries(chunk);
        const byId = new Map(got.map(p => [String(p.steamid), p]));
        for (const id of chunk) {
          const summary = byId.get(id);
          players.push(summary
            ? toPlayerRow(summary, this.blockedWords(), now)
            : { steamid: id, name: '—', avatarHash: '', visible: 0, fetchedAt: now });
        }
      }
    } catch (error) {
      this.failures += 1;
      this.log.error(`Feed enrichment failed (${ids.length} queued, attempt ${this.failures}):`, error.message);
      return { processed: 0, error };
    }
    this.failures = 0;
    this.store.completePending(ids, players);
    const removed = players.filter(p => !p.visible && wasVisible.has(p.steamid)).map(p => p.steamid);
    this.onEntries(ids, removed);
    return { processed: ids.length };
  }
}
```

- [ ] **Step 4: Run** `node --test test/enrich.test.js` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/feed/enrich.js test/enrich.test.js
git commit -m "feat(feed): batch Steam persona enrichment with backoff

Every tick takes up to 500 queued SteamIDs, skips players fetched in
the last 6 hours, and calls GetPlayerSummaries in chunks of 100 with
the existing API-key rotation. A Steam failure leaves the queue intact
and doubles the delay up to 5 minutes."
```

---

### Task 6: SSE hub and `createFeed`

**Files:**
- Create: `src/feed/sse.js`, `src/feed/index.js`, `test/feed.test.js`

**Interfaces:**
- Consumes: Tasks 2–5 (`convertToDota2Id`, `accountIdToSteamId64`, `HOUR_MS`, `loadWords`, `loadIds`, `FeedStore`, `RateLimiter`, `createSteamSummaries`, `Enricher`).
- Produces: `new SseHub({ maxClients?, heartbeatMs? })` with `connect(snapshot) → Response|null`, `broadcast(event, data)`, `start()`, `stop()`, `size`; `createFeed({ db, env, fetchImpl?, clock?, blockedWordsFile?, hiddenIdsFile?, log?, maxClients? }) → { recordHit, teaser, handle, health, reloadLists, start, stop: () => Promise<void>, tick }`. SSE events: `snapshot` (authoritative, also re-sent on removals/list reloads), `entries` (additions/updates). — this is the `env.FEED` contract from Task 2, plus `health() → { pending, lastTickAt, clients }`.

- [ ] **Step 1: Write the failing test** — `test/feed.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/feed/store.js';
import { createFeed } from '../src/feed/index.js';
import { SseHub } from '../src/feed/sse.js';

const HASH = 'fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb';
const A = '76561197960287930'; // dota 22202
const B = '76561197960287931'; // dota 22203
const quiet = { error() {}, warn() {}, log() {} };

function steam(overrides = {}) {
  return async url => {
    const ids = new URL(url).searchParams.get('steamids').split(',');
    return Response.json({ response: { players: ids.map(steamid => ({
      steamid, personaname: `name-${steamid.slice(-2)}`, avatarhash: HASH, communityvisibilitystate: 3, ...(overrides[steamid] || {})
    })) } });
  };
}

function makeFeed(opts = {}) {
  const clock = () => clock.now;
  clock.now = 1_800_000_000_000;
  const feed = createFeed({ db: openDb(':memory:'), env: { STEAM_API_KEY: 'k' }, fetchImpl: steam(opts.overrides), clock, log: quiet, ...opts.extra });
  return { feed, clock };
}

async function readEvent(reader) {
  const { value } = await reader.read();
  return new TextDecoder().decode(value);
}

test('recordHit: validates ids and enforces per-id and per-IP limits', () => {
  const { feed } = makeFeed();
  assert.equal(feed.recordHit({ steamId64: 'nope', ipHash: 'i' }), false);
  for (let i = 0; i < 6; i++) assert.equal(feed.recordHit({ steamId64: A, ipHash: `ip${i}` }), true);
  assert.equal(feed.recordHit({ steamId64: A, ipHash: 'ip-x' }), false);
  for (let i = 0; i < 20; i++) feed.recordHit({ steamId64: (76561197960300000n + BigInt(i)).toString(), ipHash: 'same' });
  assert.equal(feed.recordHit({ steamId64: B, ipHash: 'same' }), false);
});

test('/api/recent.json: enriched entries with dotaId and counts, sanitised names', async () => {
  const { feed } = makeFeed({ overrides: { [A]: { personaname: '<script>x</script>‮' } } });
  feed.recordHit({ steamId64: A, ipHash: '1' });
  feed.recordHit({ steamId64: A, ipHash: '2' });
  feed.recordHit({ steamId64: B, ipHash: '3' });
  await feed.tick();
  const res = await feed.handle(new Request('https://example.com/api/recent.json'));
  assert.equal(res.headers.get('cache-control'), 'public, max-age=10');
  const body = await res.json();
  assert.equal(body.hourCount, 3);
  const a = body.entries.find(e => e.steamId64 === A);
  assert.deepEqual(a, { steamId64: A, dotaId: '22202', name: '<script>x</script>', avatarHash: HASH, lastTs: a.lastTs, count: 2 });
});

test('teaser: computed from earlier visits only; hour counter + faces', async () => {
  const { feed } = makeFeed();
  assert.deepEqual(feed.teaser('22202'), { hourCount: 0, seen: null, faces: [] });
  feed.recordHit({ steamId64: A, ipHash: '1' });
  await feed.tick();
  const t = feed.teaser('22202');
  assert.equal(t.hourCount, 1);
  assert.equal(t.seen.count, 1);
  assert.deepEqual(t.faces, [HASH]);
  assert.equal(feed.teaser('22203').seen, null);
});

test('private and hidden players never leak: recent, teaser, SSE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-hidden-'));
  const hiddenFile = join(dir, 'hidden.txt');
  writeFileSync(hiddenFile, `${B}\n`);
  const C = '76561197960287932';
  const { feed } = makeFeed({ overrides: { [C]: { communityvisibilitystate: 1 } }, extra: { hiddenIdsFile: hiddenFile } });
  const stream = await feed.handle(new Request('https://example.com/api/stream'));
  const reader = stream.body.getReader();
  await readEvent(reader); // snapshot
  for (const id of [A, B, C]) feed.recordHit({ steamId64: id, ipHash: id });
  await feed.tick();
  const event = await readEvent(reader);
  assert.match(event, /^event: entries\n/);
  assert.match(event, new RegExp(A));
  assert.doesNotMatch(event, new RegExp(`${B}|${C}`));
  const body = await (await feed.handle(new Request('https://example.com/api/recent.json'))).json();
  assert.deepEqual(body.entries.map(e => e.steamId64), [A]);
  assert.equal(feed.teaser('22203').seen, null);
  assert.equal(feed.teaser('22204').seen, null);
  await reader.cancel();
});

test('reloadLists: hides the id and pushes an authoritative snapshot to clients', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-reload-'));
  const hiddenFile = join(dir, 'hidden.txt');
  writeFileSync(hiddenFile, '');
  const { feed } = makeFeed({ extra: { hiddenIdsFile: hiddenFile } });
  feed.recordHit({ steamId64: A, ipHash: '1' });
  await feed.tick();
  assert.equal((await (await feed.handle(new Request('https://example.com/api/recent.json'))).json()).entries.length, 1);
  const reader = (await feed.handle(new Request('https://example.com/api/stream'))).body.getReader();
  await readEvent(reader); // initial snapshot
  writeFileSync(hiddenFile, `${A}\n`);
  feed.reloadLists();
  const pushed = await readEvent(reader);
  assert.match(pushed, /^event: snapshot\n/);
  assert.doesNotMatch(pushed, new RegExp(A));
  assert.equal((await (await feed.handle(new Request('https://example.com/api/recent.json'))).json()).entries.length, 0);
  await reader.cancel();
});

test('handle: HEAD on the stream opens no client; other methods get 405', async () => {
  const { feed } = makeFeed();
  const head = await feed.handle(new Request('https://example.com/api/stream', { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(feed.health().clients, 0);
  const post = await feed.handle(new Request('https://example.com/api/recent.json', { method: 'POST' }));
  assert.equal(post.status, 405);
});

test('hourCount excludes opted-out players; nothing is served after stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-count-'));
  const hiddenFile = join(dir, 'hidden.txt');
  writeFileSync(hiddenFile, `${B}\n`);
  const { feed } = makeFeed({ extra: { hiddenIdsFile: hiddenFile } });
  feed.recordHit({ steamId64: A, ipHash: '1' });
  feed.recordHit({ steamId64: B, ipHash: '2' });
  feed.recordHit({ steamId64: B, ipHash: '3' });
  await feed.tick();
  assert.equal((await (await feed.handle(new Request('https://example.com/api/recent.json'))).json()).hourCount, 1);
  assert.equal(feed.teaser('22202').hourCount, 1);
  await feed.stop();
  assert.equal(feed.recordHit({ steamId64: A, ipHash: '4' }), false);
  assert.equal((await feed.handle(new Request('https://example.com/api/stream'))).status, 503);
});

test('stop: waits for an in-flight tick', async () => {
  const clock = () => 1;
  let release;
  const slowSteam = () => new Promise(r => { release = () => r(Response.json({ response: { players: [] } })); });
  const feed = createFeed({ db: openDb(':memory:'), env: { STEAM_API_KEY: 'k' }, fetchImpl: slowSteam, clock, log: quiet });
  feed.recordHit({ steamId64: A, ipHash: '1' });
  const ticking = feed.tick();
  await new Promise(r => setImmediate(r));
  let stopped = false;
  const stopping = feed.stop().then(() => { stopped = true; });
  await new Promise(r => setImmediate(r));
  assert.equal(stopped, false);
  release();
  await ticking;
  await stopping;
  assert.equal(stopped, true);
});

test('SseHub: snapshot on connect, broadcast, client removed on cancel, capacity', async () => {
  const hub = new SseHub({ maxClients: 1 });
  const res = hub.connect({ hello: 1 });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  assert.match(await readEvent(reader), /event: snapshot\ndata: \{"hello":1\}\n\n/);
  assert.equal(hub.connect({}), null);
  hub.broadcast('entries', { n: 2 });
  assert.match(await readEvent(reader), /event: entries\ndata: \{"n":2\}\n\n/);
  await reader.cancel();
  assert.equal(hub.size, 0);
});

test('SseHub: at most maxPerKey streams per client key', () => {
  const hub = new SseHub({ maxPerKey: 2 });
  assert.ok(hub.connect({}, 'ip-1'));
  assert.ok(hub.connect({}, 'ip-1'));
  assert.equal(hub.connect({}, 'ip-1'), null);
  assert.ok(hub.connect({}, 'ip-2'));
  hub.stop();
  assert.equal(hub.size, 0);
  assert.equal(hub.perKey.size, 0);
});

test('SseHub: a client that stops reading is dropped once its queue is full', () => {
  const hub = new SseHub();
  hub.connect({});
  for (let i = 0; i < 100; i++) hub.broadcast('entries', { i });
  assert.equal(hub.size, 0);
});

test('handle: stream busy → 503 JSON; unknown /api path → 404 JSON', async () => {
  const { feed } = makeFeed({ extra: { maxClients: 0 } });
  const busy = await feed.handle(new Request('https://example.com/api/stream'));
  assert.equal(busy.status, 503);
  const missing = await feed.handle(new Request('https://example.com/api/nope'));
  assert.equal(missing.status, 404);
});

test('health: queue depth and last tick', async () => {
  const { feed } = makeFeed();
  feed.recordHit({ steamId64: A, ipHash: '1' });
  assert.equal(feed.health().pending, 1);
  await feed.tick();
  assert.equal(feed.health().pending, 0);
  assert.equal(typeof feed.health().lastTickAt, 'number');
});
```

- [ ] **Step 2: Run** `node --test test/feed.test.js` — Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/feed/sse.js`

```js
const encoder = new TextEncoder();

function frame(event, data) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Frames buffered for one client before it counts as too slow and is dropped,
// so a stalled connection cannot grow memory without bound.
const MAX_QUEUED_FRAMES = 64;

// Server-Sent Events fan-out. Each client is a ReadableStream controller; a
// client that disconnects cancels its stream and is dropped.
export class SseHub {
  constructor({ maxClients = 2000, maxPerKey = 4, heartbeatMs = 25_000 } = {}) {
    this.maxClients = maxClients;
    this.maxPerKey = maxPerKey;
    this.heartbeatMs = heartbeatMs;
    this.clients = new Set();
    this.keyOf = new Map();   // controller -> client key (IP)
    this.perKey = new Map();  // key -> open streams
    this.timer = null;
  }

  remove(c) {
    if (!this.clients.delete(c)) return;
    const key = this.keyOf.get(c);
    this.keyOf.delete(c);
    const n = (this.perKey.get(key) || 1) - 1;
    if (n > 0) this.perKey.set(key, n);
    else this.perKey.delete(key);
  }

  get size() {
    return this.clients.size;
  }

  // `key` identifies the client (its IP) so one peer cannot take every slot.
  connect(snapshot, key = '') {
    if (this.clients.size >= this.maxClients) return null;
    if ((this.perKey.get(key) || 0) >= this.maxPerKey) return null;
    const hub = this;
    let controller;
    const stream = new ReadableStream({
      start(c) {
        controller = c;
        hub.clients.add(c);
        hub.keyOf.set(c, key);
        hub.perKey.set(key, (hub.perKey.get(key) || 0) + 1);
        c.enqueue(encoder.encode(`retry: 5000\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`));
      },
      cancel() {
        hub.remove(controller);
      }
    }, { highWaterMark: MAX_QUEUED_FRAMES });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no'
      }
    });
  }

  send(chunk) {
    for (const c of this.clients) {
      try {
        if (c.desiredSize !== null && c.desiredSize <= 0) {
          c.close(); // lagging client: it will reconnect and get a fresh snapshot
          this.remove(c);
          continue;
        }
        c.enqueue(chunk);
      } catch {
        this.remove(c);
      }
    }
  }

  broadcast(event, data) {
    this.send(frame(event, data));
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.send(encoder.encode(': hb\n\n')), this.heartbeatMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    for (const c of [...this.clients]) {
      try { c.close(); } catch { /* already closed */ }
      this.remove(c);
    }
  }
}
```

- [ ] **Step 4: Implement** `src/feed/index.js`

```js
import { convertToDota2Id, accountIdToSteamId64 } from '../core.js';
import { HOUR_MS } from '../client/feed-shared.js';
import { loadWords, loadIds } from './sanitize.js';
import { FeedStore } from './store.js';
import { RateLimiter } from './ratelimit.js';
import { createSteamSummaries, Enricher } from './enrich.js';
import { SseHub } from './sse.js';

const STEAM64_RE = /^7656119\d{10}$/;
const RECENT_LIMIT = 200;
const MAX_PENDING = 5000; // beyond this, hits are dropped until Steam catches up
const FIRST_TICK_MS = 30_000;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  });
}

export function createFeed({
  db, env, fetchImpl = fetch, clock = Date.now, log = console,
  blockedWordsFile, hiddenIdsFile, maxClients = 2000
}) {
  const store = new FeedStore(db, clock);
  const perIp = new RateLimiter(20, 60_000, clock);
  const perPlayer = new RateLimiter(6, 60_000, clock);
  const hub = new SseHub({ maxClients });
  let blocked = loadWords(blockedWordsFile, log);
  let hidden = loadIds(hiddenIdsFile, log);
  let lastTickAt = null;
  let timer = null;
  let purgeTimer = null;
  let running = false;

  function recentEntries(limit = RECENT_LIMIT) {
    return store.recent(clock() - HOUR_MS, limit + hidden.size)
      .filter(e => !hidden.has(e.steamId64))
      .slice(0, limit)
      .map(e => ({ steamId64: e.steamId64, dotaId: convertToDota2Id(e.steamId64), name: e.name, avatarHash: e.avatarHash, lastTs: e.lastTs, count: e.count }));
  }

  // Visible players only (store), minus opted-out ones (hidden list).
  function hourCount() {
    const since = clock() - HOUR_MS;
    let n = store.hourCount(since);
    for (const id of hidden) {
      if (store.getPlayer(id)?.visible) n -= store.seen(id, since)?.count ?? 0;
    }
    return n;
  }

  function snapshot() {
    return { hourCount: hourCount(), generatedAt: clock(), entries: recentEntries() };
  }

  const enricher = new Enricher({
    store,
    fetchSummaries: createSteamSummaries({ env, fetchImpl }),
    blockedWords: () => blocked,
    clock,
    log,
    onEntries(ids, removed = []) {
      // Removals go out as a full snapshot (clients reconcile against it), so
      // the SteamIDs of players who are no longer shown are never broadcast.
      if (removed.length) {
        hub.broadcast('snapshot', snapshot());
        return;
      }
      const wanted = new Set(ids);
      const entries = recentEntries().filter(e => wanted.has(e.steamId64));
      if (entries.length) hub.broadcast('entries', { hourCount: hourCount(), entries });
    }
  });

  const ticks = new Set(); // in-flight ticks; stop() waits for all of them
  let stopped = false;
  async function tick() {
    const p = enricher.tick();
    ticks.add(p);
    try {
      return await p;
    } finally {
      ticks.delete(p);
      lastTickAt = clock();
    }
  }

  function schedule(ms) {
    timer = setTimeout(async () => {
      try {
        await tick();
      } catch (e) {
        log.error('Feed tick crashed:', e);
      }
      if (running) schedule(enricher.nextDelay());
    }, ms);
    timer.unref?.();
  }

  return {
    recordHit({ steamId64, ipHash }) {
      if (stopped || !STEAM64_RE.test(String(steamId64))) return false;
      if (store.pendingCount() >= MAX_PENDING) return false;
      if (!perIp.allow(ipHash || '-') || !perPlayer.allow(steamId64)) return false;
      store.addCheck(steamId64, clock());
      return true;
    },

    teaser(dotaId) {
      const now = clock();
      const steamId64 = accountIdToSteamId64(dotaId);
      let seen = null;
      if (steamId64 && !hidden.has(steamId64) && store.getPlayer(steamId64)?.visible) {
        seen = store.seen(steamId64, now - HOUR_MS);
      }
      return {
        hourCount: hourCount(),
        seen,
        faces: recentEntries(3).map(e => e.avatarHash).filter(Boolean)
      };
    },

    async handle(request) {
      const { pathname } = new URL(request.url);
      if (stopped) return json({ error: 'shutting down' }, 503);
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ error: 'method not allowed' }, 405, { Allow: 'GET, HEAD' });
      }
      if (pathname === '/api/recent.json') {
        return json(snapshot(), 200, { 'Cache-Control': 'public, max-age=10' });
      }
      if (pathname === '/api/stream') {
        // HEAD must not open a stream: nobody would ever read or cancel it.
        if (request.method === 'HEAD') return new Response(null, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
        // CF-Connecting-IP is trustworthy because the reverse proxy only admits Cloudflare.
        const key = request.headers.get('cf-connecting-ip') || '';
        return hub.connect(snapshot(), key) ?? json({ error: 'busy' }, 503, { 'Retry-After': '30' });
      }
      return json({ error: 'not found' }, 404);
    },

    health() {
      return { pending: store.pendingCount(), lastTickAt, clients: hub.size };
    },

    reloadLists() {
      blocked = loadWords(blockedWordsFile, log);
      hidden = loadIds(hiddenIdsFile, log);
      hub.broadcast('snapshot', snapshot()); // connected clients drop newly hidden rows
    },

    tick,

    start() {
      if (running) return;
      running = true;
      stopped = false;
      hub.start();
      schedule(FIRST_TICK_MS);
      purgeTimer = setInterval(() => {
        try { store.purge(); } catch (e) { log.error('Feed purge failed:', e); }
      }, HOUR_MS);
      purgeTimer.unref?.();
    },

    // Resolves once an in-flight tick has finished, so the caller can close the DB.
    async stop() {
      stopped = true;
      running = false;
      clearTimeout(timer);
      clearInterval(purgeTimer);
      hub.stop();
      await Promise.allSettled([...ticks]);
    }
  };
}
```

Note: `teaser` for an empty hour returns `{ hourCount: 0, seen: null, faces: [] }` — matches the first assertion in the teaser test. The teaser's "seen" only appears for profiles that have **already** been enriched as visible, which also guarantees the visitor's own (just-recorded, not yet enriched) visit is never echoed.

- [ ] **Step 5: Run** `node --test test/feed.test.js` — Expected: PASS. Then `npm test` — Expected: all suites PASS.

- [ ] **Step 6: Commit**

```bash
git add src/feed/sse.js src/feed/index.js test/feed.test.js
git commit -m "feat(feed): in-process feed with SSE, teaser and opt-out list

createFeed wires store, rate limits, enrichment and an SSE hub into the
env.FEED contract used by the core: recordHit, teaser, and /api routes
(recent.json, stream). Private profiles and ids in HIDDEN_IDS_FILE are
excluded from every output; SIGHUP-style reloadLists picks up edits."
```

---

### Task 7: Node server adapter

**Files:**
- Create: `server.js`, `test/server.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `handleRequest` (Task 2), `openDb`, `SqliteKV` (Task 4), `createFeed` (Task 6).
- Produces: `createServer({ env?, dbPath?, fetchImpl?, log? }) → { server: http.Server, feed, close(): Promise<void> }`; running `node server.js` listens on `HOST`/`PORT`.

- [ ] **Step 1: Write the failing test** — `test/server.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server.js';

const HASH = 'fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb';
const quiet = { error() {}, warn() {}, log() {} };
const BROWSER = { 'user-agent': 'Mozilla/5.0 Chrome/120', accept: 'text/html' };

const steamOk = async url => {
  const ids = new URL(url).searchParams.get('steamids').split(',');
  return Response.json({ response: { players: ids.map(steamid => ({ steamid, personaname: 'tester', avatarhash: HASH, communityvisibilitystate: 3 })) } });
};
const steamDown = async () => { throw new Error('network down'); };

async function boot(env, fetchImpl = steamOk) {
  const app = createServer({ env, dbPath: ':memory:', fetchImpl, log: quiet });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, base };
}

test('server with feed: home, redirect + hit, recent.json, assets, healthz', async () => {
  const app = await boot({ STEAM_API_KEY: 'k' });
  try {
    const home = await fetch(`${app.base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /id="feed-section"/);

    const redirect = await fetch(`${app.base}/profiles/76561197960287930`, { headers: BROWSER, redirect: 'manual' });
    assert.equal(redirect.status, 200);
    assert.equal(redirect.headers.get('cache-control'), 'no-store');
    await redirect.text();

    await app.feed.tick();
    const recent = await (await fetch(`${app.base}/api/recent.json`)).json();
    assert.deepEqual(recent.entries.map(e => [e.dotaId, e.name]), [['22202', 'tester']]);

    const js = await fetch(`${app.base}/assets/feed.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /text\/javascript/);
    await js.text();
    assert.equal((await fetch(`${app.base}/assets/nope.js`)).status, 404);

    const health = await (await fetch(`${app.base}/healthz`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.feed.pending, 0);

    const headStream = await fetch(`${app.base}/api/stream`, { method: 'HEAD' });
    assert.equal(headStream.status, 200);
    assert.equal(app.feed.health().clients, 0);

    const head = await fetch(`${app.base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await app.close();
  }
});

test('server with Steam down: /profiles redirects still work, hit stays queued', async () => {
  const app = await boot({ STEAM_API_KEY: 'k' }, steamDown);
  try {
    const res = await fetch(`${app.base}/profiles/76561197960287930`, { headers: BROWSER });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /dotabuff\.com\/players\/22202/);
    await app.feed.tick();
    assert.equal(app.feed.health().pending, 1);
  } finally {
    await app.close();
  }
});

test('server with FEED_ENABLED=0: behaves like the Worker', async () => {
  const app = await boot({ FEED_ENABLED: '0' });
  try {
    assert.equal(app.feed, null);
    assert.doesNotMatch(await (await fetch(`${app.base}/`)).text(), /feed-section/);
    assert.equal((await fetch(`${app.base}/api/recent.json`)).status, 404);
    assert.equal((await fetch(`${app.base}/assets/feed.js`)).status, 404);
    const redirect = await fetch(`${app.base}/profiles/76561197960287930`, { headers: BROWSER });
    assert.equal(redirect.headers.get('cache-control'), 'max-age=300');
    await redirect.text();
    const health = await (await fetch(`${app.base}/healthz`)).json();
    assert.deepEqual(health, { ok: true, feed: null });
  } finally {
    await app.close();
  }
});

test('server: SSE stream delivers a snapshot and closes cleanly on shutdown', async () => {
  const app = await boot({ STEAM_API_KEY: 'k' });
  const res = await fetch(`${app.base}/api/stream`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /event: snapshot/);
  await app.close();
  const end = await reader.read().catch(() => ({ done: true }));
  assert.equal(end.done, true);
});
```

- [ ] **Step 2: Run** `node --test test/server.test.js` — Expected: FAIL (`Cannot find module '…/server.js'`).

- [ ] **Step 3: Implement** `server.js`

```js
// Node entry point: serves the same handleRequest as the Cloudflare Worker,
// with SQLite standing in for Workers KV and the recent-checks feed running
// in-process (env.FEED). Configuration comes from environment variables; see
// .env.example and the "Self-hosting" section of the README.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleRequest } from './src/core.js';
import { openDb, SqliteKV } from './src/feed/store.js';
import { createFeed } from './src/feed/index.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ASSETS = {
  '/assets/feed.js': resolve(ROOT, 'src/client/feed.js'),
  '/assets/feed-shared.js': resolve(ROOT, 'src/client/feed-shared.js')
};

function toWebRequest(req, url) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach(v => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(url.href, { method: req.method, headers });
}

function waitDrain(res) {
  if (res.destroyed || res.writableEnded) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

async function writeWebResponse(response, req, res) {
  const headers = {};
  response.headers.forEach((value, name) => { headers[name] = value; });
  res.writeHead(response.status, headers);
  if (req.method === 'HEAD' || !response.body) {
    response.body?.cancel().catch(() => {}); // never leave a body (e.g. an SSE stream) unread
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on('error', () => {}); // a client abort must never become an unhandled error
  res.on('close', () => { reader.cancel().catch(() => {}); });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Respect socket backpressure; a stalled SSE client then fills its own
      // bounded queue in SseHub and gets dropped.
      if (!res.write(value)) await waitDrain(res);
      if (res.destroyed) break;
    }
  } catch {
    // client went away or the stream was cancelled
  }
  if (!res.destroyed && !res.writableEnded) res.end();
}

async function serveAsset(path, res) {
  try {
    const body = await readFile(ASSETS[path]);
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function createServer({ env = process.env, dbPath = env.DB_PATH || './data/steamcommunitx.db', fetchImpl = fetch, log = console } = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = openDb(dbPath);
  const runtimeEnv = {
    ...env,
    STEAM_ID_CACHE: new SqliteKV(db, 'steamid'),
    API_KEY_STATUS: new SqliteKV(db, 'keystatus')
  };
  const feed = env.FEED_ENABLED === '0'
    ? null
    : createFeed({ db, env: runtimeEnv, fetchImpl, log, blockedWordsFile: env.BLOCKED_WORDS_FILE, hiddenIdsFile: env.HIDDEN_IDS_FILE });
  if (feed) runtimeEnv.FEED = feed;

  const inflight = new Set();
  const ctx = {
    waitUntil(promise) {
      const p = Promise.resolve(promise).catch(e => log.error('waitUntil task failed:', e));
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    }
  };

  async function handle(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true, feed: feed ? feed.health() : null });
      }
      if (url.pathname.startsWith('/assets/')) {
        if (feed && Object.hasOwn(ASSETS, url.pathname)) return await serveAsset(url.pathname, res);
        res.writeHead(404).end();
        return;
      }
      const response = await handleRequest(toWebRequest(req, url), runtimeEnv, ctx);
      await writeWebResponse(response, req, res);
    } catch (e) {
      log.error('Unhandled request error:', e);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }

  const active = new Set();
  const server = http.createServer((req, res) => {
    const p = handle(req, res).catch(e => log.error('Request failed after response started:', e));
    active.add(p);
    p.finally(() => active.delete(p));
  });

  // Order matters: stop the feed (ends SSE streams, waits for a running tick),
  // stop accepting connections, let in-flight requests finish (5 s cap), then
  // drop what is left and only then close SQLite.
  async function close() {
    await feed?.stop();
    const closed = new Promise(r => server.close(() => r()));
    server.closeIdleConnections?.();
    await Promise.race([
      Promise.allSettled([...active]),
      new Promise(r => setTimeout(r, 5000).unref())
    ]);
    server.closeAllConnections?.();
    await closed;
    await Promise.allSettled([...active]); // handlers woken by the forced close
    await Promise.allSettled([...inflight]);
    db.close();
  }

  return { server, feed, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const app = createServer();
  app.feed?.start();
  app.server.listen(port, host, () => console.log(`steamcommunitx listening on http://${host}:${port}`));
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', () => app.feed?.reloadLists());
}
```

Note: Task 8 creates `src/client/feed.js`. Until then the `/assets/feed.js` assertion fails — create a placeholder now so this task's suite is green:

```bash
mkdir -p src/client
printf '// Feed UI — implemented in the next task.\n' > src/client/feed.js
```

- [ ] **Step 4: Add scripts** — `package.json`:

```json
{
  "name": "steamcommunitx-com",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "node --test",
    "start": "node --disable-warning=ExperimentalWarning server.js"
  }
}
```

- [ ] **Step 5: Run** `npm test` — Expected: all suites PASS.

Manual smoke: `PORT=8787 FEED_ENABLED=0 npm start` in one shell, `curl -s localhost:8787/healthz` → `{"ok":true,"feed":null}`; stop with Ctrl-C (the process exits cleanly).

- [ ] **Step 6: Commit**

```bash
git add server.js test/server.test.js package.json src/client/feed.js
git commit -m "feat(server): Node runtime for the shared request handler

server.js adapts node:http to handleRequest, backs the KV bindings
with SQLite, runs the feed in-process, serves the feed's static
modules, and exposes /healthz. FEED_ENABLED=0 gives Worker-identical
behaviour. SIGTERM/SIGINT shut down cleanly; SIGHUP reloads the
blocked-words and hidden-ids lists."
```

---

### Task 8: Home page feed UI (browser module)

**Files:**
- Modify: `src/client/feed.js` (replace placeholder)
- Test: manual in a browser (DOM behaviour); `npm test` must stay green.

**Interfaces:**
- Consumes: DOM ids from `FEED_SECTION` (Task 2): `feed-section, feed, feed-list, feed-pill, feed-pill-text, feed-bar, feed-q, feed-hits, feed-count, feed-live`; endpoints `/api/stream` (events `snapshot`, `entries` with `{ hourCount, entries[] }`) and `/api/recent.json`; helpers from `./feed-shared.js`.

- [ ] **Step 1: Implement** `src/client/feed.js`

```js
// Home page "Recently checked" feed: SSE (polling fallback), drip-in with a
// split-flap animation, catch/release scrolling, and a nickname filter.
// All nickname text goes through DOM text nodes, never innerHTML. Optional
// browser APIs (Element.animate, getAnimations) are feature-checked because
// the Dota in-game browser runs an older Chromium.
import {
  t, ago, pickLang, avatarUrl, splitTerms, matchesTerms, highlightRanges,
  timeBlock, dripDelay, isNewer, diffEntries, idsToRemove, HOUR_MS
} from './feed-shared.js';

const ROW = 56;
const IDLE_MS = 8000;
const LEAVE_MS = 1500;
const HOVER_MAX_MS = 30000; // a cursor parked on the list does not freeze it forever
const RELEASE_SCROLL_MS = 350;
const BURST = 3;
const MAX_DRIP = 60;
const MAX_ROWS = 200;
const POLL_MS = 30000;
const FLAP_TICK_MS = 45;
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZАБВГДЕЖЗИКЛМНОПРСТУ0123456789#@*';

const lang = pickLang(navigator.language);
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canHover = matchMedia('(hover: hover)').matches;
const $ = id => document.getElementById(id);
const section = $('feed-section');
const box = $('feed');
const list = $('feed-list');
const pill = $('feed-pill');
const pillText = $('feed-pill-text');
const bar = $('feed-bar');
const qInput = $('feed-q');
const hitsEl = $('feed-hits');
const countEl = $('feed-count');
const liveEl = $('feed-live');
const baseTitle = document.title;

const rows = new Map();   // steamId64 -> row element (row._e holds the entry)
const latest = new Map(); // steamId64 -> newest known entry, shown or still queued
const held = [];          // entries that arrived while paused
const incoming = [];      // entries waiting to drip in
let terms = [];
let loaded = false;
let hourCount = 0;
let paused = false;
let hover = false;
let releaseTimer = null;  // idle countdown until auto-release
let flushTimer = null;    // release in progress (scrolling back to top)
let lastIntent = 0;
let ignoreScrollUntil = 0;
let dripTimer = null;
let layoutKey = '';
let es = null;
let streamUp = false;
let pollTimer = null;

section.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(lang, el.dataset.i18n); });
qInput.placeholder = t(lang, 'searchPlaceholder');

function animate(el, keyframes, options) {
  try { return el.animate ? el.animate(keyframes, options) : null; } catch { return null; }
}

// ---- rows ----

function paint(r) {
  const e = r._e;
  const nick = r._nick;
  nick.removeAttribute('aria-label');
  nick.textContent = '';
  let pos = 0;
  for (const [a, b] of highlightRanges(e.name, terms)) {
    nick.append(e.name.slice(pos, a));
    const mark = document.createElement('mark');
    mark.textContent = e.name.slice(a, b);
    nick.append(mark);
    pos = b;
  }
  nick.append(e.name.slice(pos));
  if (e.count > 1) {
    const x = document.createElement('span');
    x.className = 'fd-x';
    x.textContent = '×' + e.count;
    nick.append(x);
  }
  r._meta.textContent = ago(lang, e.lastTs, Date.now());
  r.hidden = !matchesTerms(e.name, terms);
}

function makeRow(e) {
  const r = document.createElement('div');
  r.className = 'fd-row';
  r._e = e;
  const img = document.createElement('img');
  img.className = 'fd-av';
  img.alt = '';
  img.width = 36;
  img.height = 36;
  img.decoding = 'async';
  const src = avatarUrl(e.avatarHash);
  if (src) img.src = src;
  const who = document.createElement('div');
  who.className = 'fd-who';
  r._nick = document.createElement('div');
  r._nick.className = 'fd-nick';
  r._meta = document.createElement('div');
  r._meta.className = 'fd-meta';
  who.append(r._nick, r._meta);
  const go = document.createElement('a');
  go.className = 'fd-go';
  go.href = 'https://www.dotabuff.com/players/' + encodeURIComponent(e.dotaId);
  go.textContent = t(lang, 'dotabuff');
  r.append(img, who, go);
  paint(r);
  return r;
}

function dropRow(r) {
  if (r._flap) clearInterval(r._flap);
  r._flap = null;
  rows.delete(r._e.steamId64);
  r.remove();
}

// One interval per row drives every glyph; it stops when done or when the
// row is dropped. Screen readers get the real name via aria-label.
function flap(r) {
  const name = r._e.name;
  const chars = Array.from(name);
  const nick = r._nick;
  nick.setAttribute('aria-label', name);
  nick.textContent = '';
  const spans = chars.map(c => {
    const s = document.createElement('span');
    s.className = 'fd-flap spin';
    s.setAttribute('aria-hidden', 'true');
    s.textContent = c === ' ' ? ' ' : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
    nick.append(s);
    return s;
  });
  const lastTick = 4 + (chars.length - 1) * 2;
  let tick = 0;
  r._flap = setInterval(() => {
    tick++;
    spans.forEach((s, i) => {
      if (s._done) return;
      if (chars[i] === ' ' || tick >= 4 + i * 2) {
        s._done = true;
        s.textContent = chars[i];
        s.classList.remove('spin');
        s.classList.add('fd-flip');
      } else {
        s.textContent = GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
      }
    });
    if (tick >= lastTick) {
      clearInterval(r._flap);
      r._flap = null;
      setTimeout(() => { if (r.isConnected) paint(r); }, 450);
    }
  }, FLAP_TICK_MS);
  r.firstChild.classList.add('fd-flip');
  animate(r, [{ height: '0px' }, { height: ROW + 'px' }], { duration: 260, easing: 'ease-out' });
}

function notifyPinned(r) {
  r.classList.add('fd-pinned');
  if (document.hidden || !document.hasFocus()) document.title = '★ ' + baseTitle;
}

function insert(e, animated) {
  const old = rows.get(e.steamId64);
  if (old && !isNewer(e, old._e)) return; // a stale queued copy must not overwrite newer data
  if (old) dropRow(old);
  const r = makeRow(e);
  rows.set(e.steamId64, r);
  list.insertBefore(r, list.querySelector('.fd-row'));
  if (animated && !r.hidden && !reduce) flap(r);
  if (loaded && terms.length && !r.hidden) notifyPinned(r);
}

// Rows past the hour are forgotten entirely; rows past the display cap only
// lose their DOM node, so the next snapshot does not resurrect them as new.
function trim() {
  const cutoff = Date.now() - HOUR_MS;
  [...list.querySelectorAll('.fd-row')].forEach((r, i) => {
    if (r._e.lastTs < cutoff || i >= MAX_ROWS) dropRow(r);
  });
  for (const [id, e] of latest) if (e.lastTs < cutoff) latest.delete(id);
}

// Rebuild time-block headers only when the grouping changed, and keep the
// scroll position so a paused reader is not moved.
function layout() {
  const now = Date.now();
  const visible = [...list.querySelectorAll('.fd-row')].filter(r => !r.hidden);
  const blocks = visible.map(r => timeBlock(r._e.lastTs, now));
  const key = visible.map((r, i) => r._e.steamId64 + ':' + blocks[i]).join('|');
  hitsEl.textContent = terms.length ? t(lang, 'hits', { n: visible.length }) : '';
  if (key === layoutKey) return;
  layoutKey = key;
  const top = list.scrollTop;
  list.querySelectorAll('.fd-blk, .fd-empty').forEach(el => el.remove());
  let current = null;
  visible.forEach((r, i) => {
    if (blocks[i] === current) return;
    current = blocks[i];
    const h = document.createElement('div');
    h.className = 'fd-blk';
    h.textContent = t(lang, current);
    list.insertBefore(h, r);
  });
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'fd-empty';
    empty.textContent = t(lang, 'empty');
    list.append(empty);
  }
  if (paused) list.scrollTop = top;
}

function renderCount() {
  countEl.textContent = t(lang, 'hourCount', { n: hourCount });
}

function removeIds(ids) {
  if (!ids.length) return;
  const gone = new Set(ids);
  for (const id of gone) {
    const r = rows.get(id);
    if (r) dropRow(r);
    latest.delete(id);
  }
  for (const q of [held, incoming]) {
    for (let i = q.length - 1; i >= 0; i--) if (gone.has(q[i].steamId64)) q.splice(i, 1);
  }
  layout();
  if (paused) renderPill();
}

// ---- drip ----

function enqueue(entries) {
  for (const e of entries) (paused ? held : incoming).push(e);
  if (paused) renderPill();
  else pump();
}

function pump() {
  if (dripTimer || paused || !incoming.length) return;
  try {
    if (incoming.length > MAX_DRIP) incoming.splice(0, incoming.length - MAX_DRIP).forEach(e => insert(e, false));
    insert(incoming.shift(), true);
    trim();
    layout();
  } catch (err) {
    console.error('feed: insert failed', err);
  }
  dripTimer = setTimeout(() => { dripTimer = null; pump(); }, dripDelay(incoming.length + 1));
}

// ---- catch / release ----
// States: live (paused = false) → paused (held collects arrivals, optional
// releaseTimer) → releasing (still paused, flushTimer pending while we scroll
// to the top) → live. Any user intent during releasing cancels it.

function atTop() { return list.scrollTop <= 2; }

function pause(ms) {
  paused = true;
  box.classList.add('paused');
  liveEl.textContent = t(lang, 'paused');
  clearTimeout(releaseTimer);
  clearTimeout(flushTimer);
  releaseTimer = null;
  flushTimer = null;
  ignoreScrollUntil = 0;
  try { (bar.getAnimations ? bar.getAnimations() : []).forEach(a => a.cancel()); } catch { /* old browser */ }
  if (ms) {
    releaseTimer = setTimeout(release, ms);
    if (!reduce) animate(bar, [{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: ms, easing: 'linear', fill: 'forwards' });
  }
  renderPill();
}

function release() {
  clearTimeout(releaseTimer);
  releaseTimer = null;
  if (flushTimer) return;
  if (list.scrollTop > 0 && !reduce) {
    ignoreScrollUntil = Date.now() + 800; // our own smooth scroll is not user intent
    try { list.scrollTo({ top: 0, behavior: 'smooth' }); } catch { list.scrollTop = 0; }
    flushTimer = setTimeout(goLive, RELEASE_SCROLL_MS);
  } else {
    list.scrollTop = 0;
    goLive();
  }
}

function goLive() {
  flushTimer = null;
  paused = false;
  box.classList.remove('paused');
  liveEl.textContent = t(lang, 'live');
  const backlog = held.splice(0);
  const loud = Math.max(0, backlog.length - BURST);
  backlog.slice(0, loud).forEach(e => insert(e, false));
  incoming.push(...backlog.slice(loud));
  trim();
  layout();
  pump();
}

function renderPill() {
  pillText.textContent = held.length
    ? t(lang, 'pillNew', { n: held.length })
    : t(lang, hover ? 'pillHover' : 'pill');
}

function onIntent() {
  lastIntent = Date.now();
  if (flushTimer) pause(hover ? HOVER_MAX_MS : IDLE_MS); // the reader grabbed it mid-release
}

['wheel', 'touchstart', 'pointerdown', 'keydown'].forEach(ev => {
  list.addEventListener(ev, onIntent, { passive: true });
});
list.addEventListener('scroll', () => {
  const now = Date.now();
  if (now < ignoreScrollUntil || now - lastIntent > 900) return; // not the user
  if (atTop() && !hover) release();
  else pause(hover ? HOVER_MAX_MS : IDLE_MS);
}, { passive: true });
list.addEventListener('touchend', () => {
  if (paused && atTop()) pause(LEAVE_MS);
  else if (!atTop()) pause(IDLE_MS);
}, { passive: true });
// Touch devices synthesise mouseenter without a reliable mouseleave, so hover
// pausing is only wired up where a real pointer can hover.
if (canHover) {
  list.addEventListener('mouseenter', () => { hover = true; pause(HOVER_MAX_MS); });
  list.addEventListener('mouseleave', () => {
    hover = false;
    if (paused && !flushTimer) pause(atTop() ? LEAVE_MS : IDLE_MS);
  });
}
pill.addEventListener('click', () => { hover = false; release(); });

// ---- search ----

function setQuery(q) {
  terms = splitTerms(q);
  rows.forEach(r => { if (!r._flap) paint(r); });
  layoutKey = '';
  layout();
}

let saved = new URLSearchParams(location.search).get('q');
if (saved === null) {
  try { saved = localStorage.getItem('feed_q') || ''; } catch { saved = ''; }
}
qInput.value = saved;
terms = splitTerms(saved);
qInput.addEventListener('input', () => {
  setQuery(qInput.value);
  try { localStorage.setItem('feed_q', qInput.value); } catch { /* storage disabled */ }
  const u = new URL(location.href);
  if (qInput.value.trim()) u.searchParams.set('q', qInput.value);
  else u.searchParams.delete('q');
  history.replaceState(null, '', u);
});
window.addEventListener('focus', () => { document.title = baseTitle; });

// ---- data ----

function onData(data, isSnapshot) {
  hourCount = data.hourCount;
  renderCount();
  const entries = data.entries || [];
  if (isSnapshot && loaded) removeIds(idsToRemove(latest, entries));
  const fresh = diffEntries(entries, latest);
  fresh.forEach(e => latest.set(e.steamId64, e));
  if (!loaded && isSnapshot) {
    fresh.forEach(e => insert(e, false));
    loaded = true;
    section.hidden = false;
    trim();
    layout();
    return;
  }
  enqueue(fresh);
}

async function poll() {
  if (streamUp) return;
  try {
    const res = await fetch('/api/recent.json');
    if (!res.ok) return;
    const data = await res.json();
    if (!streamUp) onData(data, true); // the stream came back meanwhile: its data wins
  } catch { /* offline; try again next interval */ }
}

function startPolling() {
  stopPolling();
  poll();
  pollTimer = setInterval(poll, POLL_MS + Math.round((Math.random() - 0.5) * 10000));
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function connect() {
  if (!('EventSource' in window)) { startPolling(); return; }
  es = new EventSource('/api/stream');
  es.addEventListener('snapshot', ev => onData(JSON.parse(ev.data), true));
  es.addEventListener('entries', ev => onData(JSON.parse(ev.data), false));
  // While the stream is down (reconnecting or refused) keep the list fresh by
  // polling; the next successful open stops it.
  es.onopen = () => { streamUp = true; stopPolling(); };
  es.onerror = () => {
    streamUp = false;
    if (!pollTimer) startPolling();
    if (es && es.readyState === EventSource.CLOSED) es = null;
  };
}

function disconnect() {
  if (es) { es.close(); es = null; }
  streamUp = false;
  stopPolling();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) disconnect();
  else connect();
});

setInterval(() => {
  if (!loaded || document.hidden) return;
  const now = Date.now();
  rows.forEach(r => {
    if (r.hidden) return;
    const text = ago(lang, r._e.lastTs, now);
    if (r._meta.textContent !== text) r._meta.textContent = text;
  });
}, 1000);
setInterval(() => { if (loaded && !paused && !document.hidden) { trim(); layout(); } }, 15000);

connect();
```

- [ ] **Step 2: Run** `npm test` — Expected: PASS (no test imports `feed.js`; `server.test.js` still serves it).

- [ ] **Step 3: Manual browser check**

Run a local server with a fake data generator so the feed has traffic without real Steam calls:

```bash
mkdir -p "$TMPDIR/sc-dev" && cat > "$TMPDIR/sc-dev/dev-feed.mjs" <<'EOF'
import { createServer } from '/ABSOLUTE/PATH/TO/REPO/server.js';
const HASH = 'fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb';
const NAMES = ['akamai', 'kvyze', 'Ｓｉｌｅｎｔ', 'Солнышко', '🌸 lilith', 'pos5 enjoyer', 'akamai_twink', '<b>not bold</b>'];
const fakeSteam = async url => {
  const ids = new URL(url).searchParams.get('steamids').split(',');
  return Response.json({ response: { players: ids.map(steamid => ({ steamid, personaname: NAMES[Number(steamid.slice(-2)) % NAMES.length], avatarhash: HASH, communityvisibilitystate: 3 })) } });
};
const app = createServer({ env: { STEAM_API_KEY: 'dev' }, dbPath: ':memory:', fetchImpl: fakeSteam });
app.server.listen(8787, '127.0.0.1');
let n = 0;
setInterval(() => { for (let i = 0; i < 4; i++) app.feed.recordHit({ steamId64: (76561197960300000n + BigInt(n++ % 40)).toString(), ipHash: String(n) }); }, 3000);
setInterval(() => app.feed.tick(), 5000);
console.log('http://127.0.0.1:8787/');
EOF
node --disable-warning=ExperimentalWarning "$TMPDIR/sc-dev/dev-feed.mjs"
```

(Replace `/ABSOLUTE/PATH/TO/REPO` with the repo path.) Open `http://127.0.0.1:8787/` and verify:
1. The feed section appears after the first snapshot; rows show avatar, nickname, `×N`, relative time, "Dotabuff →" pointing at `https://www.dotabuff.com/players/<id>`.
2. New rows flap in one at a time; `<b>not bold</b>` renders as literal text.
3. Hover pauses on pointer devices only (gold dot, pill "Paused while hovering", released after 30 s even if the cursor stays); on a phone a tap at the top does not stick a pause; scrolling down pauses with a countdown bar; after 8 s idle it scrolls to the top and drips held rows; scrolling back to the top resumes immediately; clicking the pill resumes.
4. Typing `akamai kvyze` filters and highlights; `?q=` updates; reload keeps the query; with the tab in the background a matching new row adds "★" to the title, cleared on focus.
5. Headers "Just now / Last 5 min / Last hour" stay sticky while scrolling.
6. DevTools → Rendering → emulate `prefers-reduced-motion: reduce`: rows appear without flapping. Scroll down while paused and wait for a 15 s refresh: the view must not jump. Grab the list with the wheel during the auto-release scroll: it must stay paused with the pill count intact.
7. DevTools → Network: switching to another tab closes the EventSource; returning reconnects.
8. `curl -s 'http://127.0.0.1:8787/profiles/76561197960300001' -H 'User-Agent: Mozilla/5.0' -H 'Accept: text/html' | grep teaser` shows the teaser link; in a browser, clicking the teaser on the redirect page lands on `/` and does **not** continue to Dotabuff.

- [ ] **Step 4: Commit**

```bash
git add src/client/feed.js
git commit -m "feat(home): live recently-checked feed with split-flap rows

The home page feed connects over SSE (polling fallback, paused while
the tab is hidden), drips new players in one at a time with a
split-flap nickname animation, groups rows into Just now / 5 min /
hour, and can be caught by hovering or scrolling, releasing itself
after 8 s idle. A nickname filter highlights matches and, when saved,
flashes matching newcomers and marks the tab title."
```

---

### Task 9: Container and deployment examples

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.example.yml`, `deploy/Caddyfile.example`, `.env.example`
- Modify: `.gitignore` (add `data/`, `.env` already present, `docker-compose.yml`)

- [ ] **Step 1: Write the files**

`Dockerfile`:

```dockerfile
FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DB_PATH=/data/steamcommunitx.db

WORKDIR /app
COPY package.json server.js ./
COPY src ./src

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
```

`.dockerignore`:

```
.git
.wrangler
.superpowers
.impeccable
node_modules
data
test
docs
.env
.dev.vars
*.md
```

`docker-compose.example.yml`:

```yaml
# Copy to docker-compose.yml (gitignored) and adjust. The port is bound to
# localhost only: put a reverse proxy (see deploy/Caddyfile.example) in front.
services:
  steamcommunitx:
    build: .
    image: steamcommunitx:latest
    restart: unless-stopped
    env_file: .env
    ports:
      - "127.0.0.1:8787:8787"
    volumes:
      - ./data:/data                 # SQLite; must be writable by uid 1000
      - ./config:/config:ro          # optional blocked-words / hidden-ids lists
    # Keep a traffic spike from starving other services on the same host.
    cpus: 1.0
    mem_limit: 256m
    pids_limit: 128
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
```

`deploy/Caddyfile.example`:

```caddy
# Example reverse proxy for the self-hosted server, fronted by Cloudflare
# (proxied DNS record, SSL/TLS mode "Full (strict)" for this hostname —
# "Flexible" causes an HTTPS redirect loop).
#
# The certificate is a Cloudflare Origin CA certificate (SSL/TLS → Origin
# Server). Requests that do not come from Cloudflare are refused, so the
# origin cannot be hit directly. Keep the IP list in sync with
# https://www.cloudflare.com/ips/.
example.com {
	tls /etc/caddy/origin-certs/example.com.pem /etc/caddy/origin-certs/example.com.key

	@notCloudflare not remote_ip 173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22 2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32
	respond @notCloudflare 403

	reverse_proxy 127.0.0.1:8787 {
		# Stream Server-Sent Events (/api/stream) without buffering.
		flush_interval -1
	}
}
```

`.env.example`:

```bash
# Copy to .env (gitignored) for docker compose or `npm start`.

# Steam Web API key(s): https://steamcommunity.com/dev/apikey
STEAM_API_KEY=
# STEAM_API_KEYS=second-key,third-key

# Optional analytics / interstitial banner — same formats as the Worker secrets.
# GA_ID=G-XXXXXXX
# MATOMO_URL=//m.example.com/
# MATOMO_SITE_ID=1
# BANNERS=[{"src":"https://example.com/embed/a","height":300}]

# Recent checks feed: on by default; set to 0 for Worker-identical behaviour.
FEED_ENABLED=1
# One word per line (case-insensitive) masked in nicknames.
# BLOCKED_WORDS_FILE=/config/blocked-words.txt
# One SteamID64 per line never shown in the feed (opt-out). Reload: docker kill -s HUP <container>
# HIDDEN_IDS_FILE=/config/hidden-ids.txt

# Set by the Dockerfile; override for `npm start`.
# HOST=127.0.0.1
# PORT=8787
# DB_PATH=./data/steamcommunitx.db
```

Append to `.gitignore`:

```
data/
docker-compose.yml
```

- [ ] **Step 2: Build and smoke-test the image**

```bash
docker build -t steamcommunitx:dev .
docker run -d --name sc-smoke -p 127.0.0.1:18787:8787 -e FEED_ENABLED=1 steamcommunitx:dev
sleep 3
curl -s http://127.0.0.1:18787/healthz
curl -s -o /dev/null -w '%{http_code}\n' -H 'User-Agent: Mozilla/5.0' -H 'Accept: text/html' http://127.0.0.1:18787/profiles/76561197960287930
curl -s http://127.0.0.1:18787/api/recent.json
docker inspect --format '{{.State.Health.Status}}' sc-smoke
docker rm -f sc-smoke
```

Expected: `{"ok":true,"feed":{"pending":0,…}}` (pending becomes 1 after the redirect), `200`, a JSON snapshot with `"entries":[]` (no Steam key → enrichment fails, entry stays queued), health `starting` or `healthy`.

- [ ] **Step 3: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.example.yml deploy/Caddyfile.example .env.example .gitignore
git commit -m "build: container image and self-hosting examples

Add a node:24-alpine image running as non-root with a SQLite volume and
a healthcheck, a compose example with localhost-only port and resource
limits, a Caddy example that only accepts Cloudflare traffic and
streams SSE unbuffered, and a documented .env.example."
```

---

### Task 10: Documentation and changelog

**Files:**
- Modify: `README.md`, `.dev.vars.example`
- Create: `CHANGELOG.md`

- [ ] **Step 1: Update `README.md`**

- Replace the first paragraph of **Overview** with:

```markdown
This service converts Steam Vanity URLs and SteamID-based profile URLs into Dotabuff player profile links. It runs either as a **Cloudflare Worker** (`worker.js`) or as a **self-hosted Node server** (`server.js`, Docker image provided). Both share one request handler (`src/core.js`). The self-hosted server additionally runs the optional **recent checks feed**.
```

- Add `- **Recent checks feed** (self-hosted only): live list of recently checked players on the home page, plus a teaser on the redirect page` to **Features**.
- Replace **Code Breakdown → Key Files** with:

```markdown
- **`src/core.js`**: request routing, Steam ID resolution and conversion, `handleRequest(request, env, ctx)` — Web-standard APIs only.
- **`src/pages.js`**: HTML for the home, redirect and error pages.
- **`worker.js`**: Cloudflare Workers adapter.
- **`server.js`**: Node adapter (SQLite instead of KV, in-process feed, `/healthz`).
- **`src/feed/`**: recent checks feed (storage, Steam enrichment, SSE).
- **`src/client/`**: browser feed UI and helpers shared with the server.
```

- Add two new sections before **Contributing**:

```markdown
## Self-hosting (Node / Docker)

Requires Node 24+ or Docker.

1. `cp .env.example .env` and set at least `STEAM_API_KEY`.
2. `cp docker-compose.example.yml docker-compose.yml`, then `mkdir -p data config && sudo chown 1000:1000 data`.
3. `docker compose up -d --build`. The server listens on `127.0.0.1:8787`; `GET /healthz` returns `{"ok":true,…}`.
4. Put a TLS reverse proxy in front — see `deploy/Caddyfile.example`. Recommended setup with Cloudflare:
   - DNS record **proxied** (orange cloud).
   - SSL/TLS mode **Full (strict)** for the hostname (a Configuration Rule can scope it to one hostname). *Flexible* causes a redirect loop.
   - A Cloudflare **Origin CA** certificate on the proxy, and only Cloudflare IP ranges allowed through.
5. Point an uptime monitor at `/healthz`.

Without Docker: `npm start` (reads the same variables from the environment).

### Switching between the Worker and the server

A Worker route on the zone takes precedence over the origin. To serve the site from the self-hosted server, remove the Worker route (Workers & Pages → the worker → Settings → Domains & Routes). **Rolling back is `wrangler deploy`**, which re-creates the route from `wrangler.toml` — note that any Worker deploy does this, so deploy the Worker only when you intend to switch back. The Worker runs without the feed; everything else is identical.

## Recent checks feed (optional, self-hosted only)

When the server runs with `FEED_ENABLED=1` (default), every real-browser redirect records a *check* of that profile (link-preview bots and crawlers are ignored). Every 30 seconds the queued SteamIDs are enriched with nickname and avatar via `ISteamUser/GetPlayerSummaries` (up to 100 per call, cached for 6 hours). The home page then shows a live list of players checked in the last hour, and the redirect page shows a one-line teaser.

Privacy and moderation:
- Only the **checked profile** is shown, never who checked it. IP addresses are never stored (rate limiting uses a daily-salted hash kept in memory).
- Private Steam profiles are never shown.
- Raw checks are kept for 24 hours, player names/avatars for 7 days after the last check.
- Nicknames are cleaned (control/bidi characters, excessive combining marks, length) and words listed in `BLOCKED_WORDS_FILE` are masked.
- **Opt-out:** add the SteamID64 to `HIDDEN_IDS_FILE` and send `SIGHUP` (`docker kill -s HUP <container>`). Ask for removal by opening an issue in this repository.

Endpoints: `GET /api/recent.json` (snapshot, cacheable for 10 s), `GET /api/stream` (Server-Sent Events), `GET /healthz`.
```

- In **Setup & Deployment → 1. Deploy to Cloudflare Workers**, add a sentence: `The Worker build bundles src/ automatically; the feed is not available on Workers.`

- [ ] **Step 2: Create `CHANGELOG.md`**

```markdown
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
  fallback; English, Russian and Ukrainian UI.
- Redirect-page teaser showing when the opened profile was last checked, or how
  many players were checked this hour. Clicking it cancels the redirect.
- Opt-out list (`HIDDEN_IDS_FILE`) and nickname word masking (`BLOCKED_WORDS_FILE`).

### Changed
- Request handling moved to `src/core.js` and `src/pages.js`; `worker.js` is now
  a thin adapter. Worker behaviour is unchanged.
- The redirect page's meta-refresh fallback now lives in `<noscript>`; with
  JavaScript the redirect is driven by the script timer only.
```

- [ ] **Step 3: Update `.dev.vars.example`** — append:

```bash
# The recent checks feed is not available on the Worker runtime; see
# .env.example and "Self-hosting" in the README for the Node server.
```

- [ ] **Step 4: Verify no private infrastructure leaked**

Run `git grep -nIiE '<pattern>'` with the deployment's private host and server names (kept outside the repo).
Expected: no output.

Run: `npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md .dev.vars.example
git commit -m "docs: self-hosting guide, recent checks feed and changelog

Document the two runtimes, Docker and reverse-proxy setup behind
Cloudflare, switching and rollback between Worker and server, and the
feed's privacy model and opt-out. Start a Keep a Changelog file."
```
