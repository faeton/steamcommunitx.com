import { getAvailableApiKeys, markProblemKey, markRateLimitedKey } from '../core.js';
import { AVATAR_HASH_RE } from '../client/feed-shared.js';
import { sanitizeName } from './sanitize.js';

const SUMMARIES_URL = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/';
// Every batch also asks for the players Steam returned most recently. Nobody at
// all coming back is then a glitch; anyone else missing really is gone, so a
// batch of bogus ids is settled instead of staying queued.
const REFERENCES = 2;
const CHUNK = 100 - REFERENCES; // Steam takes 100 ids per call
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

  // One batch: up to 500 queued ids, Steam calls of 100. Real checks and
  // watchlist lookups go in separate calls. Each call that succeeds is
  // committed; a failed one stays queued for the next (backed-off) tick.
  async tick() {
    const ids = this.store.takePending(MAX_PER_TICK);
    if (!ids.length) return { processed: 0 };
    const now = this.clock();
    const fresh = this.store.freshPlayerIds(ids, FRESH_MS);
    const stale = ids.filter(id => !fresh.has(id));
    const lookupOnly = this.store.lookupOnlyIds(stale);
    const chunks = [];
    for (const group of [stale.filter(id => !lookupOnly.has(id)), stale.filter(id => lookupOnly.has(id))]) {
      for (let i = 0; i < group.length; i += CHUNK) chunks.push(group.slice(i, i + CHUNK));
    }
    const done = [...fresh];
    const players = [];
    let error = null;
    for (const chunk of chunks) {
      // References: players found earlier in this tick, else the latest stored.
      const found = players.filter(p => p.found).map(p => p.steamid).slice(-REFERENCES);
      const refs = found.length ? found : this.store.foundIds(REFERENCES);
      const asked = [...new Set([...chunk, ...refs])];
      let got;
      try {
        got = await this.fetchSummaries(asked);
      } catch (e) {
        error = e; // Steam unreachable or refusing: stop asking this tick
        break;
      }
      // Nobody at all out of several ids is a Steam glitch, not a batch of
      // deleted accounts: keep the chunk queued and go on, so a later chunk
      // can bring references for the retry. Without references (cold start)
      // a chunk of watchlist lookups cannot tell, so it is settled as not
      // found; the watchlist asks again in a few hours.
      if (!got.length && asked.length > 1 && (refs.length || !lookupOnly.has(chunk[0]))) {
        error = new Error('Steam returned an empty player list');
        continue;
      }
      const byId = new Map(got.map(p => [String(p.steamid), p]));
      for (const id of chunk) {
        const summary = byId.get(id);
        if (summary) players.push(toPlayerRow(summary, this.blockedWords(), now));
        // An omitted player we already know keeps its last data (Steam
        // omissions are usually transient); an unknown one is not shown.
        else if (!this.store.getPlayer(id)?.found) {
          players.push({ steamid: id, name: '—', avatarHash: '', found: 0, private: 0, fetchedAt: now });
        }
      }
      done.push(...chunk);
    }
    if (done.length) {
      this.store.completePending(done, players);
      this.onEntries(done);
    }
    if (error) {
      this.failures += 1;
      this.log.error(`Feed enrichment failed (${ids.length - done.length} of ${ids.length} still queued, attempt ${this.failures}):`, error.message);
      return { processed: done.length, error };
    }
    this.failures = 0;
    return { processed: done.length };
  }
}
