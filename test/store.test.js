import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, SqliteKV, FeedStore } from '../src/feed/store.js';
import { RateLimiter } from '../src/feed/ratelimit.js';

const A = '76561197960287930';
const B = '76561197960287931';
const C = '76561197960287932';

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
  store.addCheck(B, clock() - 1000);
  store.addCheck(C);
  assert.equal(store.pendingCount(), 3);
  assert.deepEqual(store.takePending(10), [B, A, C]);
  store.completePending([A, B, C], [
    { steamid: A, name: 'akamai', avatarHash: 'a'.repeat(40), found: 1, private: 0, fetchedAt: clock() },
    { steamid: B, name: 'locked', avatarHash: '', found: 1, private: 1, fetchedAt: clock() },
    { steamid: C, name: '—', avatarHash: '', found: 0, private: 0, fetchedAt: clock() }
  ]);
  assert.equal(store.pendingCount(), 0);
  const recent = store.recent(clock() - 3_600_000, 10);
  assert.deepEqual(recent, [
    { steamId64: A, name: 'akamai', avatarHash: 'a'.repeat(40), private: false, lastTs: clock(), count: 2 },
    { steamId64: B, name: 'locked', avatarHash: '', private: true, lastTs: clock() - 1000, count: 1 }
  ]);
  assert.equal(store.hourCount(clock() - 3_600_000), 3); // C was not returned by Steam: not counted
  assert.deepEqual(store.seen(A, clock() - 3_600_000), { lastTs: clock(), count: 2 });
  assert.equal(store.seen('76561197960287999', clock() - 3_600_000), null);
});

test('FeedStore: completePending rolls back as a unit on error', () => {
  const store = new FeedStore(openDb(':memory:'), clockAt(5));
  store.addCheck(A);
  assert.throws(() => store.completePending([A], [{ steamid: A, name: null, avatarHash: '', found: 1, private: 0, fetchedAt: 5 }]));
  assert.equal(store.pendingCount(), 1);
  assert.equal(store.getPlayer(A), null);
});

test('FeedStore: freshPlayerIds and purge', () => {
  const clock = clockAt(100 * 86_400_000);
  const store = new FeedStore(openDb(':memory:'), clock);
  store.addCheck(A, clock() - 2 * 86_400_000);
  store.completePending([A], [{ steamid: A, name: 'old', avatarHash: '', found: 1, private: 0, fetchedAt: clock() - 8 * 86_400_000 }]);
  store.addCheck(B);
  store.completePending([B], [{ steamid: B, name: 'new', avatarHash: '', found: 1, private: 0, fetchedAt: clock() }]);
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
