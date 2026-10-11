import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTeaser, escapeHtml, renderFeedSection, renderWatchBlock, errorPage, indexPage } from '../src/pages.js';

const HASH = 'fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb';
const NOW = 1_800_000_000_000;

test('renderTeaser: nothing without data or when the hour is empty', () => {
  assert.equal(renderTeaser(null, 'en', NOW), '');
  assert.equal(renderTeaser({ hourCount: 0, seen: null, faces: [] }, 'en', NOW), '');
});

test('renderTeaser: personal "seen" line wins over the hour counter', () => {
  const once = renderTeaser({ hourCount: 9, seen: { lastTs: NOW - 240_000, count: 1 }, faces: [HASH] }, 'en', NOW);
  assert.match(once, /This player was checked 4 min ago — see who else →/);
  assert.doesNotMatch(once, /<img/);
  const many = renderTeaser({ hourCount: 9, seen: { lastTs: NOW - 240_000, count: 3 }, faces: [] }, 'en', NOW);
  assert.match(many, /· ×3 — see who else/);
});

test('renderTeaser: hour line with up to 3 validated avatars', () => {
  const html = renderTeaser({ hourCount: 132, seen: null, faces: [HASH, 'bad"><script>', HASH, HASH, HASH] }, 'en', NOW);
  assert.match(html, /132 players checked this hour/);
  assert.equal((html.match(/<img /g) || []).length, 3);
  assert.doesNotMatch(html, /script/);
  assert.match(html, /^<a class="teaser" id="teaser" href="\/">/);
});

test('escapeHtml: escapes the five HTML specials', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});

test('renderFeedSection: server-rendered rows, escaped names, visible on first paint', () => {
  const snapshot = { hourCount: 7, generatedAt: NOW, entries: [
    { steamId64: '76561197960287930', dotaId: '22202', name: '<script>x</script>', avatarHash: HASH, private: true, lastTs: NOW - 5000, count: 3 },
    { steamId64: '76561197960287931', dotaId: '22203', name: 'akamai', avatarHash: 'bad"', private: false, lastTs: NOW - 400_000, count: 1 }
  ] };
  const html = renderFeedSection(snapshot, 'en', NOW);
  assert.doesNotMatch(html, /<section[^>]*hidden/);
  assert.match(html, /7 checked this hour/);
  assert.equal((html.match(/class="fd-row"/g) || []).length, 2);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.match(html, /<span class="fd-x">×3<\/span>/);
  assert.match(html, /id 22202 · 5s ago/);
  assert.match(html, /href="https:\/\/www\.dotabuff\.com\/players\/22202"/);
  assert.match(html, /<a class="fd-go fd-go-o" href="https:\/\/www\.opendota\.com\/players\/22202" title="Open on OpenDota"[^>]*>O<\/a>/);
  assert.match(html, /<a class="fd-go fd-go-s" href="https:\/\/stratz\.com\/players\/22202" title="Open on STRATZ"[^>]*>S<\/a>/);
  assert.match(html, /<a class="fd-go fd-go-d" href="https:\/\/www\.dotabuff\.com\/players\/22202" title="Open on Dotabuff"[^>]*>D<\/a>/);
  assert.match(html, /<a class="fd-name" href="https:\/\/steamcommunity\.com\/profiles\/76561197960287930" title="&lt;script&gt;x&lt;\/script&gt;">/);
  assert.equal((html.match(/class="fd-lock"/g) || []).length, 1);
  assert.match(html, /<div class="fd-blk">Just now<\/div>/);
  assert.match(html, /<div class="fd-blk">Last hour<\/div>/);
  assert.equal((html.match(/<img /g) || []).length, 2); // invalid hash -> no src, still a placeholder img
  assert.doesNotMatch(html, /src="[^"]*bad/);
  // Embedded data cannot close the script element.
  const json = html.match(/<script type="application\/json" id="feed-data">([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(json, /<\/script/i);
  assert.equal(JSON.parse(json).entries[0].name, '<script>x</script>');
});

test('renderFeedSection: empty hour shows the empty state, no data means hidden until the stream', () => {
  assert.match(renderFeedSection({ hourCount: 0, generatedAt: NOW, entries: [] }, 'ru', NOW), /За последний час никого не проверяли/);
  assert.match(renderFeedSection(null, 'en', NOW), /<section[^>]*hidden/);
});

test('errorPage: the title is text, never markup', () => {
  const html = errorPage('example.com', 500, '<img src=x onerror=alert(1)>', 'msg');
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('renderWatchBlock: rows in list order, escaped names, statuses, safe data island', () => {
  const evil = '</script><img src=x onerror=alert(1)>';
  const watch = { generatedAt: NOW, items: [
    { dotaId: '22203', steamId64: '76561197960287931', lastTs: null, count: 0, name: null, avatarHash: null, private: false },
    { dotaId: '22202', steamId64: '76561197960287930', lastTs: NOW - 2 * 3600_000, count: 3, name: evil, avatarHash: HASH, private: true }
  ] };
  const html = renderWatchBlock(['22203', '22202'], watch, 'en', NOW);
  assert.doesNotMatch(html, /<section[^>]*hidden/);
  const rows = html.match(/class="wt-row[^"]*" data-id="\d+"/g);
  assert.deepEqual(rows.map(r => r.match(/data-id="(\d+)"/)[1]), ['22203', '22202']);
  assert.match(html, /id 22203 · no checks recorded in 24 h/);
  assert.match(html, /id 22202 · checked 2 h ago/);
  assert.match(html, /<span class="fd-x">×3<\/span>/);
  assert.match(html, />22203<\/a>/); // unknown player: the id stands in for the name
  assert.doesNotMatch(html, /<img src=x/);
  assert.equal((html.match(/class="fd-lock"/g) || []).length, 1);
  assert.match(html, /href="https:\/\/www\.dotabuff\.com\/players\/22202"/);
  const json = html.match(/<script type="application\/json" id="check-data">([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(json, /<\//);
  const data = JSON.parse(json);
  assert.deepEqual(data.list, ['22203', '22202']);
  assert.equal(data.watch.items[1].name, evil);
});

test('renderWatchBlock: empty list shows the intro; a missing status still lists the ids', () => {
  const empty = renderWatchBlock([], null, 'ru', NOW);
  assert.match(empty, /class="wt wt-empty"/);
  assert.match(empty, /Следи за своей командой/);
  assert.match(empty, /"list":\[\]/);
  const pending = renderWatchBlock(['42'], null, 'en', NOW);
  assert.match(pending, /data-id="42"/);
  assert.match(pending, /id 42<\/div>/);
  assert.match(pending, /"watch":null/);
});

test('indexPage: watch block and noindex only with a check list', () => {
  const withList = indexPage('example.com', '', { feed: true, lang: 'en', snapshot: null, watchList: ['42'], watch: null });
  assert.match(withList, /id="watch"/);
  assert.match(withList, /<meta name="robots" content="noindex">/);
  const bare = indexPage('example.com', '', { feed: true, lang: 'en', snapshot: null });
  assert.match(bare, /id="watch"/);
  assert.doesNotMatch(bare, /noindex/);
  assert.doesNotMatch(indexPage('example.com', '', {}), /id="watch"/);
});
