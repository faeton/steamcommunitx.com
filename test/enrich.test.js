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

test('Enricher.tick: a player Steam omits keeps its last known data; a private turn applies', async () => {
  const store = new FeedStore(openDb(':memory:'), () => 100 * 3_600_000);
  for (const n of [1, 2]) {
    store.addCheck(id(n));
    store.completePending([id(n)], [{ steamid: id(n), name: 'was public', avatarHash: HASH, found: 1, private: 0, fetchedAt: 0 }]);
    store.addCheck(id(n));
  }
  const announced = [];
  const enricher = new Enricher({
    store,
    // id(1) omitted (glitch or deleted); id(2) went private.
    fetchSummaries: async ids => ids.filter(s => s === id(2)).map(s => summary(s, { communityvisibilitystate: 1 })),
    onEntries: ids => announced.push(...ids),
    blockedWords: () => [], clock: () => 100 * 3_600_000, log: quiet
  });
  await enricher.tick();
  assert.equal(store.getPlayer(id(1)).found, 1);
  assert.equal(store.getPlayer(id(1)).name, 'was public');
  assert.equal(store.getPlayer(id(2)).private, 1);
  assert.equal(store.pendingCount(), 0);
  assert.deepEqual(announced.sort(), [id(1), id(2)].sort());
});

test('Enricher.tick: an empty answer for several ids is treated as a Steam glitch', async () => {
  const store = new FeedStore(openDb(':memory:'), () => 1);
  store.addCheck(id(1));
  store.addCheck(id(2));
  const enricher = new Enricher({
    store, fetchSummaries: async () => [], onEntries() {}, blockedWords: () => [], clock: () => 1, log: quiet
  });
  const r = await enricher.tick();
  assert.match(r.error.message, /empty/);
  assert.equal(store.pendingCount(), 2);
  assert.equal(store.getPlayer(id(1)), null);
});

test('Enricher.tick: a single unknown id is stored as not found', async () => {
  const store = new FeedStore(openDb(':memory:'), () => 1);
  store.addCheck(id(1));
  const enricher = new Enricher({
    store, fetchSummaries: async () => [], onEntries() {}, blockedWords: () => [], clock: () => 1, log: quiet
  });
  await enricher.tick();
  assert.equal(store.pendingCount(), 0);
  assert.equal(store.getPlayer(id(1)).found, 0);
});

test('Enricher.tick: the latest players Steam returned ride along, so a batch of bogus ids settles', async () => {
  const store = new FeedStore(openDb(':memory:'), () => 1);
  store.completePending([], [
    { steamid: id(90), name: 'old', avatarHash: '', found: 1, private: 0, fetchedAt: 0 },
    { steamid: id(91), name: 'gone', avatarHash: '', found: 0, private: 0, fetchedAt: 1 },
    { steamid: id(92), name: 'new', avatarHash: '', found: 1, private: 0, fetchedAt: 1 },
    { steamid: id(93), name: 'older', avatarHash: '', found: 1, private: 0, fetchedAt: -1 }
  ]);
  for (let i = 1; i <= 10; i++) store.queueLookup(id(i));
  const asked = [];
  const enricher = new Enricher({
    store, fetchSummaries: async ids => { asked.push(ids); return ids.filter(s => s >= id(90)).map(s => summary(s)); },
    onEntries() {}, blockedWords: () => [], clock: () => 1, log: quiet
  });
  const r = await enricher.tick();
  assert.equal(r.processed, 10);
  assert.deepEqual(asked[0].slice(10).sort(), [id(90), id(92)].sort());
  assert.equal(store.pendingCount(), 0);
  assert.equal(store.getPlayer(id(1)).found, 0);
  assert.equal(store.getPlayer(id(92)).name, 'new'); // references are asked for, not rewritten
  assert.equal(enricher.nextDelay(), 30_000);
});

test('Enricher.tick: references that went silent too still mean a glitch', async () => {
  const store = new FeedStore(openDb(':memory:'), () => 1);
  store.completePending([], [{ steamid: id(90), name: 'ref', avatarHash: '', found: 1, private: 0, fetchedAt: 0 }]);
  store.queueLookup(id(1));
  const enricher = new Enricher({
    store, fetchSummaries: async () => [], onEntries() {}, blockedWords: () => [], clock: () => 1, log: quiet
  });
  assert.match((await enricher.tick()).error.message, /empty/);
  assert.equal(store.pendingCount(), 1);
});

test('Enricher.tick: cold start, bogus watchlist lookups alone settle; real checks go first and are not starved', async () => {
  const store = new FeedStore(openDb(':memory:'), () => 1);
  for (let i = 1; i <= 120; i++) store.queueLookup(id(i)); // more than one chunk of bogus lookups
  store.addCheck(id(500)); // queued last, but a real check
  const asked = [];
  const enricher = new Enricher({
    store, fetchSummaries: async ids => { asked.push(ids); return ids.filter(s => s === id(500)).map(s => summary(s)); },
    onEntries() {}, blockedWords: () => [], clock: () => 1, log: quiet
  });
  const r = await enricher.tick();
  assert.equal(r.processed, 121);
  assert.equal(asked[0][0], id(500));
  assert.equal(asked[1].at(-1), id(500)); // the found real player rides along as a reference
  assert.equal(store.getPlayer(id(500)).found, 1);
  assert.equal(store.getPlayer(id(120)).found, 0);
  assert.equal(store.pendingCount(), 0);
});

test('Enricher.tick: cold start, bogus checks stay queued but bogus lookups beside them settle', async () => {
  const store = new FeedStore(openDb(':memory:'), () => 1);
  store.queueLookup(id(1));
  store.addCheck(id(2));
  store.addCheck(id(3));
  const enricher = new Enricher({
    store, fetchSummaries: async () => [], onEntries() {}, blockedWords: () => [], clock: () => 1, log: quiet
  });
  const r = await enricher.tick();
  assert.match(r.error.message, /empty/);
  assert.equal(r.processed, 1);
  assert.equal(store.getPlayer(id(1)).found, 0);
  assert.deepEqual(store.takePending(10).sort(), [id(2), id(3)].sort());
});

test('Enricher.tick: a glitched chunk stays queued, later chunks commit and give it references next time', async () => {
  const store = new FeedStore(openDb(':memory:'), () => 1);
  for (let i = 1; i <= 98; i++) store.addCheck(id(i), 1); // first chunk: all nonexistent
  store.addCheck(id(500), 2);
  store.addCheck(id(501), 2);
  const enricher = new Enricher({
    store, fetchSummaries: async ids => ids.filter(s => s >= id(500)).map(s => summary(s)),
    onEntries() {}, blockedWords: () => [], clock: () => 1, log: quiet
  });
  const r1 = await enricher.tick();
  assert.match(r1.error.message, /empty/);
  assert.equal(r1.processed, 2);
  assert.equal(store.getPlayer(id(500)).found, 1);
  assert.equal(store.pendingCount(), 98);
  const r2 = await enricher.tick(); // now with references: the misses are real
  assert.equal(r2.error, undefined);
  assert.equal(store.pendingCount(), 0);
  assert.equal(store.getPlayer(id(1)).found, 0);
  assert.equal(enricher.nextDelay(), 30_000);
});

test('Enricher.tick: a thrown Steam error stops the tick but keeps chunks already answered', async () => {
  const store = new FeedStore(openDb(':memory:'), () => 1);
  for (let i = 1; i <= 150; i++) store.addCheck(id(i));
  let calls = 0;
  const enricher = new Enricher({
    store, fetchSummaries: async ids => { if (++calls > 1) throw new Error('Steam down'); return ids.map(s => summary(s)); },
    onEntries() {}, blockedWords: () => [], clock: () => 1, log: quiet
  });
  const r = await enricher.tick();
  assert.match(r.error.message, /Steam down/);
  assert.equal(r.processed, 98);
  assert.equal(store.pendingCount(), 52);
  assert.equal(calls, 2);
});

test('Enricher.tick: cold start, a chunk of only watchlist lookups is settled without references', async () => {
  const store = new FeedStore(openDb(':memory:'), () => 1);
  store.queueLookup(id(1));
  store.queueLookup(id(2));
  const enricher = new Enricher({
    store, fetchSummaries: async () => [], onEntries() {}, blockedWords: () => [], clock: () => 1, log: quiet
  });
  assert.equal((await enricher.tick()).processed, 2);
  assert.equal(store.getPlayer(id(1)).found, 0);
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
  assert.deepEqual(calls, [98, 54]); // an empty store has no references; then 2 found in the first chunk
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

test('createSteamSummaries: rejected responses have their bodies released', async () => {
  let cancelled = 0;
  const body = () => new ReadableStream({ cancel() { cancelled++; } });
  const fetchImpl = async url => url.includes('key=a')
    ? new Response(body(), { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } })
    : url.includes('key=b') ? new Response(body(), { status: 503 })
      : Response.json({ response: { players: [] } });
  const fetchSummaries = createSteamSummaries({ env: { STEAM_API_KEY: 'a', STEAM_API_KEYS: 'b,c' }, fetchImpl });
  await fetchSummaries([id(1)]);
  assert.equal(cancelled, 2);
});
