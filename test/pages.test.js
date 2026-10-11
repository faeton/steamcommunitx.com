import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTeaser, escapeHtml, renderFeedSection } from '../src/pages.js';

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
