import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  avatarUrl, pickLang, t, ago, splitTerms, matchesTerms, highlightRanges,
  timeBlock, dripDelay, isNewer, diffEntries, idsToRemove, isStale, insertIndex,
  tempoPerMin, nextColumns, maxColumnsFor, pickColumn, metaLine, matchesEntry
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
  assert.equal(t('ru', 'openOn', { site: 'STRATZ' }), 'Открыть на STRATZ');
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

test('isStale: payloads generated before the newest one applied are ignored', () => {
  assert.equal(isStale({ generatedAt: 100 }, 200), true);
  assert.equal(isStale({ generatedAt: 200 }, 200), false);
  assert.equal(isStale({ generatedAt: 300 }, 200), false);
  assert.equal(isStale({}, 200), false); // no generation: cannot tell, accept
});

test('insertIndex: newest first, a late older entry lands below newer rows', () => {
  assert.equal(insertIndex([500, 400, 100], 450), 1);
  assert.equal(insertIndex([500, 400, 100], 600), 0);
  assert.equal(insertIndex([500, 400, 100], 50), 3);
  assert.equal(insertIndex([500, 400], 400), 1); // ties go above: newest arrival on top
  assert.equal(insertIndex([], 1), 0);
});

test('tempoPerMin: arrivals in the last 2 minutes, per minute', () => {
  const now = 1_000_000;
  const times = [now - 130_000, now - 100_000, now - 50_000, now - 10_000, now - 1000];
  assert.equal(tempoPerMin(times, now), 2); // 4 in 2 min
  assert.equal(tempoPerMin([], now), 0);
});

test('nextColumns: up at 20 / 45 per min, down below 12 / 30 (hysteresis), capped', () => {
  assert.equal(nextColumns(1, 19, 3), 1);
  assert.equal(nextColumns(1, 20, 3), 2);
  assert.equal(nextColumns(1, 50, 3), 3);
  assert.equal(nextColumns(2, 44, 3), 2);
  assert.equal(nextColumns(2, 45, 3), 3);
  assert.equal(nextColumns(3, 31, 3), 3);
  assert.equal(nextColumns(3, 29, 3), 2);
  assert.equal(nextColumns(3, 5, 3), 1);
  assert.equal(nextColumns(2, 13, 3), 2);
  assert.equal(nextColumns(2, 11, 3), 1);
  assert.equal(nextColumns(1, 80, 2), 2);
  assert.equal(nextColumns(3, 80, 1), 1);
});

test('maxColumnsFor: by list width', () => {
  assert.equal(maxColumnsFor(380), 1);
  assert.equal(maxColumnsFor(600), 2);
  assert.equal(maxColumnsFor(720), 3);
});

test('pickColumn: the column that changed longest ago, lowest index on ties', () => {
  assert.equal(pickColumn([300, 100, 200]), 1);
  assert.equal(pickColumn([0, 0, 0]), 0);
  assert.equal(pickColumn([5]), 0);
});

test('metaLine: Dota ID before the relative time', () => {
  const now = 1_000_000;
  assert.equal(metaLine('en', { dotaId: '123123123', lastTs: now - 5000 }, now), 'id 123123123 · 5s ago');
  assert.equal(metaLine('ru', { dotaId: '22202', lastTs: now - 240_000 }, now), 'id 22202 · 4 мин назад');
});

test('matchesEntry: nickname words or Dota / Steam IDs (4+ digits, any form)', () => {
  const e = { name: 'kvyze', dotaId: '163191061', steamId64: '76561198123456789' };
  assert.equal(matchesEntry(e, splitTerms('163191061')), true);
  assert.equal(matchesEntry(e, splitTerms('9106')), true);
  assert.equal(matchesEntry(e, splitTerms('[U:1:163191061]')), true);
  assert.equal(matchesEntry(e, splitTerms('steamcommunity.com/profiles/76561198123456789')), true);
  assert.equal(matchesEntry(e, splitTerms('akamai 163191061')), true);
  assert.equal(matchesEntry(e, splitTerms('kvy')), true);
  assert.equal(matchesEntry(e, splitTerms('999999')), false);
  assert.equal(matchesEntry(e, splitTerms('7')), false); // too short to mean an id, not in the name
  assert.equal(matchesEntry(e, []), true);
});
