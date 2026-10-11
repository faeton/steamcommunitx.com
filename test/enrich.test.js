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

test('toPlayerRow: sanitises, validates avatar, flags private profiles', () => {
  const row = toPlayerRow({ steamid: id(1), personaname: 'x‮y badword', avatarhash: 'nope', communityvisibilitystate: 1 }, ['badword'], 42);
  assert.deepEqual(row, { steamid: id(1), name: 'xy •••••••', avatarHash: '', found: 1, private: 1, fetchedAt: 42 });
  assert.equal(toPlayerRow(summary(id(2)), [], 42).private, 0);
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

test('Enricher.tick: reports players Steam stopped returning, not ones that turned private', async () => {
  const store = new FeedStore(openDb(':memory:'), () => 100 * 3_600_000);
  for (const n of [1, 2]) {
    store.addCheck(id(n));
    store.completePending([id(n)], [{ steamid: id(n), name: 'was public', avatarHash: HASH, found: 1, private: 0, fetchedAt: 0 }]);
    store.addCheck(id(n));
  }
  const seen = [];
  const enricher = new Enricher({
    store,
    // id(1) vanished from Steam; id(2) went private.
    fetchSummaries: async ids => ids.filter(s => s === id(2)).map(s => summary(s, { communityvisibilitystate: 1 })),
    onEntries: (ids, removed) => seen.push(removed),
    blockedWords: () => [], clock: () => 100 * 3_600_000, log: quiet
  });
  await enricher.tick();
  assert.deepEqual(seen, [[id(1)]]);
  assert.equal(store.getPlayer(id(2)).private, 1);
});

test('createSteamSummaries: no keys is an error', async () => {
  await assert.rejects(createSteamSummaries({ env: {}, fetchImpl: async () => Response.json({}) })([id(1)]), /no Steam API keys/);
});

test('Enricher.tick: chunks of 100, private kept, missing dropped, pending cleared', async () => {
  const store = new FeedStore(openDb(':memory:'), () => 1_000_000);
  for (let i = 1; i <= 150; i++) store.addCheck(id(i));
  const calls = [];
  const announced = [];
  const enricher = new Enricher({
    store,
    fetchSummaries: async ids => {
      calls.push(ids.length);
      return ids.filter(s => s !== id(8)).map(s => summary(s, s === id(7) ? { communityvisibilitystate: 1 } : {}));
    },
    onEntries: ids => announced.push(...ids),
    blockedWords: () => [],
    clock: () => 1_000_000,
    log: quiet
  });
  const result = await enricher.tick();
  assert.deepEqual(calls, [100, 50]);
  assert.equal(result.processed, 150);
  assert.equal(store.pendingCount(), 0);
  assert.equal(store.getPlayer(id(7)).private, 1);
  assert.equal(store.getPlayer(id(8)).found, 0);
  const recent = store.recent(0, 500);
  assert.equal(recent.length, 149);
  assert.equal(recent.find(e => e.steamId64 === id(7)).private, true);
  assert.equal(announced.length, 150);
});

test('Enricher.tick: fresh players skip Steam but are still announced', async () => {
  const store = new FeedStore(openDb(':memory:'), () => 2_000_000);
  store.addCheck(id(1));
  store.completePending([id(1)], [{ steamid: id(1), name: 'cached', avatarHash: HASH, found: 1, private: 0, fetchedAt: 1_999_000 }]);
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
