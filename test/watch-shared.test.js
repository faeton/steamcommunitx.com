import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCheckList, accountToSteamId64, MAX_WATCH, watchNews } from '../src/client/feed-shared.js';

test('parseCheckList: account ids, SteamID64 and SteamID3 become canonical account ids', () => {
  assert.deepEqual(parseCheckList('163191061,123456789'), ['163191061', '123456789']);
  assert.deepEqual(parseCheckList('76561198123456789'), ['163191061']);
  assert.deepEqual(parseCheckList('[U:1:42] U:1:43'), ['42', '43']);
});

test('parseCheckList: profile and player URLs', () => {
  assert.deepEqual(parseCheckList(
    'https://steamcommunity.com/profiles/76561198123456789/ https://www.dotabuff.com/players/42 ' +
    'https://stratz.com/players/76561197960265771'
  ), ['163191061', '42', '43']);
  assert.deepEqual(parseCheckList(encodeURIComponent('https://www.opendota.com/players/7')), ['7']);
});

test('parseCheckList: separators, leading zeros and duplicates of the same player', () => {
  assert.deepEqual(parseCheckList('1+2;3 \n4,,5'), ['1', '2', '3', '4', '5']);
  assert.deepEqual(parseCheckList('0042,42,76561197960265770'), ['42']);
});

test('parseCheckList: out of range, junk and malformed escapes are dropped', () => {
  assert.deepEqual(parseCheckList('0,4294967296,76561197960265728,abc,%zz,12345678901,<script>'), []);
  assert.deepEqual(parseCheckList('4294967295'), ['4294967295']);
  assert.deepEqual(parseCheckList(''), []);
  assert.deepEqual(parseCheckList(null), []);
  assert.deepEqual(parseCheckList(['1', '2,3']), ['1', '2', '3']);
});

test('parseCheckList: keeps the first MAX_WATCH ids and caps raw length', () => {
  const ids = Array.from({ length: 15 }, (_, i) => String(i + 1));
  assert.equal(MAX_WATCH, 10);
  assert.deepEqual(parseCheckList(ids.join(',')), ids.slice(0, 10));
  assert.deepEqual(parseCheckList(' '.repeat(1100) + '7'), []);
});

test('accountToSteamId64: exact BigInt conversion', () => {
  assert.equal(accountToSteamId64('163191061'), '76561198123456789');
  assert.equal(accountToSteamId64('4294967295'), '76561202255233023');
});

test('watchNews: ids whose count or lastTs grew since the baseline; new ids only set a baseline', () => {
  const base = new Map([['1', { count: 1, lastTs: 100 }], ['2', { count: 0, lastTs: null }]]);
  const items = [
    { dotaId: '1', count: 2, lastTs: 200 },
    { dotaId: '2', count: 0, lastTs: null },
    { dotaId: '3', count: 5, lastTs: 300 }
  ];
  assert.deepEqual(watchNews(base, items), ['1']);
  assert.deepEqual(watchNews(base, [{ dotaId: '2', count: 1, lastTs: 50 }]), ['2']);
  // A purge can lower the 24 h count; only a newer lastTs is news then.
  assert.deepEqual(watchNews(new Map([['1', { count: 3, lastTs: 100 }]]), [{ dotaId: '1', count: 2, lastTs: 100 }]), []);
});

test('ago: hours past the first hour (the watchlist spans 24 h)', async () => {
  const { ago } = await import('../src/client/feed-shared.js');
  assert.equal(ago('en', 0, 59 * 60_000), '59 min ago');
  assert.equal(ago('en', 0, 3 * 3600_000 + 10 * 60_000), '3 h ago');
  assert.equal(ago('ru', 0, 2 * 3600_000), '2 ч назад');
});

test('watchMeta: id plus last check, or none recorded', async () => {
  const { watchMeta } = await import('../src/client/feed-shared.js');
  assert.equal(watchMeta('en', { dotaId: '42', lastTs: 0 }, 120_000), 'id 42 · checked 2 min ago');
  assert.equal(watchMeta('en', { dotaId: '42', lastTs: null }, 0), 'id 42 · no checks recorded in 24 h');
});

test('titleText: watch counter first, then the feed star, then the page title', async () => {
  const { titleText } = await import('../src/client/feed-shared.js');
  assert.equal(titleText('Site', 0, false), 'Site');
  assert.equal(titleText('Site', 0, true), '★ Site');
  assert.equal(titleText('Site', 3, true), '(3) ★ Site');
});

test('watchNews: a higher count with the same lastTs is news too', () => {
  assert.deepEqual(watchNews(new Map([['1', { count: 1, lastTs: 100 }]]), [{ dotaId: '1', count: 2, lastTs: 100 }]), ['1']);
});

test('parseCheckList: SteamID3 inside a profile URL', () => {
  assert.deepEqual(parseCheckList('https://steamcommunity.com/profiles/[U:1:42]/'), ['42']);
  assert.deepEqual(parseCheckList(encodeURIComponent('https://steamcommunitx.com/profiles/[U:1:43]')), ['43']);
});

test('vanityName: /id/ URLs (ours or Steam\'s) and bare names; never ids or junk', async () => {
  const { vanityName } = await import('../src/client/feed-shared.js');
  assert.equal(vanityName('https://steamcommunitx.com/id/faeton/'), 'faeton');
  assert.equal(vanityName('https://steamcommunity.com/id/Some_Name-1'), 'Some_Name-1');
  assert.equal(vanityName('steamcommunity.com/id/faeton?l=en'), 'faeton');
  assert.equal(vanityName('faeton'), 'faeton');
  assert.equal(vanityName('123456'), null);
  assert.equal(vanityName('https://www.dotabuff.com/players/42'), null);
  assert.equal(vanityName('<script>'), null);
  assert.equal(vanityName('a'), null);
  assert.equal(vanityName('x'.repeat(33)), null);
});
