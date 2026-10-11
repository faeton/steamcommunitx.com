import { convertToDota2Id, accountIdToSteamId64 } from '../core.js';
import { HOUR_MS, parseCheckList, accountToSteamId64 } from '../client/feed-shared.js';
import { loadWords } from './sanitize.js';
import { FeedStore } from './store.js';
import { RateLimiter } from './ratelimit.js';
import { createSteamSummaries, Enricher } from './enrich.js';
import { SseHub } from './sse.js';

const STEAM64_BASE = 76561197960265728n;

// Individual-account SteamID64: base + a 32-bit account id.
function isSteamId64(value) {
  const s = String(value);
  if (!/^\d{17}$/.test(s)) return false;
  const account = BigInt(s) - STEAM64_BASE;
  return account >= 0n && account < 2n ** 32n;
}
const RECENT_LIMIT = 200;
const MAX_PENDING = 5000; // beyond this, hits are dropped until Steam catches up
const FIRST_TICK_MS = 30_000;
const DAY_MS = 24 * HOUR_MS;
const WATCH_PER_MIN = 60; // per IP, shared by /api/check.json and the home pre-render

// Report each GetPlayerSummaries outcome to the Steam health monitor.
function reporting(fetchSummaries, health) {
  if (!health) return fetchSummaries;
  return async ids => {
    try {
      const players = await fetchSummaries(ids);
      health.ok('summaries');
      return players;
    } catch (error) {
      health.fail('summaries', error);
      throw error;
    }
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  });
}

export function createFeed({
  db, env, fetchImpl = fetch, clock = Date.now, log = console,
  blockedWordsFile, maxClients = 2000, health = null
}) {
  const store = new FeedStore(db, clock);
  const perIp = new RateLimiter(20, 60_000, clock);
  const perPlayer = new RateLimiter(6, 60_000, clock);
  const perWatcher = new RateLimiter(WATCH_PER_MIN, 60_000, clock);
  const perResolver = new RateLimiter(10, 60_000, clock); // vanity lookups from the watchlist box
  const hub = new SseHub({ maxClients });
  let blocked = loadWords(blockedWordsFile, log);
  let lastTickAt = null;
  let timer = null;
  let purgeTimer = null;
  let running = false;

  function recentEntries(limit = RECENT_LIMIT) {
    return store.recent(clock() - HOUR_MS, limit).map(e => ({
      steamId64: e.steamId64, dotaId: convertToDota2Id(e.steamId64), name: e.name,
      avatarHash: e.avatarHash, private: e.private, lastTs: e.lastTs, count: e.count
    }));
  }

  function hourCount() {
    return store.hourCount(clock() - HOUR_MS);
  }

  function snapshot() {
    return { hourCount: hourCount(), generatedAt: clock(), entries: recentEntries() };
  }

  // Watchlist status for canonical Dota ids (parseCheckList output). Read-only:
  // never queues a Steam lookup. null when this IP is over its budget.
  function watch(dotaIds, ipKey) {
    if (!perWatcher.allow(ipKey || '-')) return null;
    const ids = dotaIds.map(accountToSteamId64);
    const items = store.checkStatus(ids, clock() - DAY_MS).map((s, i) => ({ dotaId: dotaIds[i], ...s }));
    return { generatedAt: clock(), items };
  }

  const enricher = new Enricher({
    store,
    fetchSummaries: reporting(createSteamSummaries({ env, fetchImpl }), health),
    blockedWords: () => blocked,
    clock,
    log,
    onEntries(ids) {
      const wanted = new Set(ids);
      const entries = recentEntries().filter(e => wanted.has(e.steamId64));
      if (entries.length) hub.broadcast('entries', { hourCount: hourCount(), generatedAt: clock(), entries });
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
      if (stopped || !isSteamId64(steamId64)) return false;
      if (store.pendingCount() >= MAX_PENDING) return false;
      if (!perIp.allow(ipHash || '-') || !perPlayer.allow(steamId64)) return false;
      store.addCheck(steamId64, clock());
      return true;
    },

    teaser(dotaId) {
      const now = clock();
      const steamId64 = accountIdToSteamId64(dotaId);
      let seen = null;
      // Only already-enriched players: the visitor's own, just-recorded hit
      // is never echoed back.
      if (steamId64 && store.getPlayer(steamId64)?.found) {
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
      if (pathname === '/api/check.json') {
        const { searchParams } = new URL(request.url);
        const data = watch(parseCheckList(searchParams.getAll('ids')), request.headers.get('cf-connecting-ip') || '');
        if (!data) return json({ error: 'too many requests' }, 429, { 'Retry-After': '60', 'Cache-Control': 'no-store' });
        return json(data, 200, { 'Cache-Control': 'no-store' });
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
      // Applies to names fetched from now on; stored names refresh within 6 h.
      blocked = loadWords(blockedWordsFile, log);
    },

    tick,

    watch,

    allowResolve(ipKey) {
      return perResolver.allow(ipKey || '-');
    },

    // Same payload as /api/recent.json; the home page pre-renders from it.
    snapshot,

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
