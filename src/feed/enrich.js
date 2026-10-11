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
        if (!res.ok) res.body?.cancel().catch(() => {}); // free the connection
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
    found: 1,
    // Name and avatar are public even for private profiles; the UI just marks them.
    private: summary.communityvisibilitystate === 3 ? 0 : 1,
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
    const wasFound = new Set(stale.filter(id => this.store.getPlayer(id)?.found));
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
            : { steamid: id, name: '—', avatarHash: '', found: 0, private: 0, fetchedAt: now });
        }
      }
    } catch (error) {
      this.failures += 1;
      this.log.error(`Feed enrichment failed (${ids.length} queued, attempt ${this.failures}):`, error.message);
      return { processed: 0, error };
    }
    this.failures = 0;
    this.store.completePending(ids, players);
    const removed = players.filter(p => !p.found && wasFound.has(p.steamid)).map(p => p.steamid);
    this.onEntries(ids, removed);
    return { processed: ids.length };
  }
}
