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
const C = '76561197960287932'; // dota 22204
const D = '76561197960287933'; // dota 22205
const quiet = { error() {}, warn() {}, log() {} };

function steam(overrides = {}) {
  return async url => {
    const ids = new URL(url).searchParams.get('steamids').split(',');
    // An override of null leaves the player out, like a deleted account.
    return Response.json({ response: { players: ids.filter(steamid => overrides[steamid] !== null).map(steamid => ({
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
  assert.equal(body.hourCount, 2); // A twice + B: two players
  const a = body.entries.find(e => e.steamId64 === A);
  assert.deepEqual(a, { steamId64: A, dotaId: '22202', name: '<script>x</script>', avatarHash: HASH, private: false, lastTs: a.lastTs, count: 2 });
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

test('private profiles are listed and flagged; accounts Steam did not return never leak', async () => {
  const { feed } = makeFeed({ overrides: { [C]: { communityvisibilitystate: 1 }, [D]: null } });
  const stream = await feed.handle(new Request('https://example.com/api/stream'));
  const reader = stream.body.getReader();
  await readEvent(reader); // snapshot
  for (const id of [A, C, D]) feed.recordHit({ steamId64: id, ipHash: id });
  await feed.tick();
  const event = await readEvent(reader);
  assert.match(event, /^event: entries\n/);
  assert.match(event, /"generatedAt":\d+/);
  assert.match(event, new RegExp(A));
  assert.match(event, new RegExp(`${C}[^}]*"private":true`));
  assert.doesNotMatch(event, new RegExp(D));
  const body = await (await feed.handle(new Request('https://example.com/api/recent.json'))).json();
  assert.deepEqual(body.entries.map(e => [e.steamId64, e.private]).sort(), [[A, false], [C, true]]);
  assert.equal(body.hourCount, 2);
  assert.equal(feed.teaser('22204').seen.count, 1);
  assert.equal(feed.teaser('22205').seen, null);
  await reader.cancel();
});

test('reloadLists: re-reads blocked words for names fetched afterwards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-words-'));
  const wordsFile = join(dir, 'words.txt');
  writeFileSync(wordsFile, '');
  const { feed } = makeFeed({ extra: { blockedWordsFile: wordsFile } });
  writeFileSync(wordsFile, 'name\n');
  feed.reloadLists();
  feed.recordHit({ steamId64: A, ipHash: '1' });
  await feed.tick();
  const body = await (await feed.handle(new Request('https://example.com/api/recent.json'))).json();
  assert.equal(body.entries[0].name, '••••-30');
});

test('handle: HEAD on the stream opens no client; other methods get 405', async () => {
  const { feed } = makeFeed();
  const head = await feed.handle(new Request('https://example.com/api/stream', { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(feed.health().clients, 0);
  const post = await feed.handle(new Request('https://example.com/api/recent.json', { method: 'POST' }));
  assert.equal(post.status, 405);
});

test('hourCount counts listed players only; nothing is served after stop', async () => {
  const { feed } = makeFeed({ overrides: { [D]: null } });
  feed.recordHit({ steamId64: A, ipHash: '1' });
  feed.recordHit({ steamId64: D, ipHash: '2' });
  feed.recordHit({ steamId64: D, ipHash: '3' });
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

test('SseHub: an evicted lagging client loses its buffered frames (stream errors)', async () => {
  const hub = new SseHub();
  const res = hub.connect({});
  for (let i = 0; i < 100; i++) hub.broadcast('entries', { i });
  assert.equal(hub.size, 0);
  await assert.rejects(res.body.getReader().read(), /lagging/);
});

test('recordHit: accepts the whole 32-bit account range, rejects ids outside it', () => {
  const { feed } = makeFeed();
  assert.equal(feed.recordHit({ steamId64: '76561200000000000', ipHash: 'a' }), true);
  assert.equal(feed.recordHit({ steamId64: '76561202255233023', ipHash: 'b' }), true); // account id 2^32 - 1
  assert.equal(feed.recordHit({ steamId64: '76561202255233024', ipHash: 'c' }), false);
  assert.equal(feed.recordHit({ steamId64: '76561197960265727', ipHash: 'd' }), false);
});
