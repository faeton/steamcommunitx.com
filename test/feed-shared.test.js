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
  assert.equal(t('uk', 'privateProfile'), 'Приватний профіль Steam');
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
