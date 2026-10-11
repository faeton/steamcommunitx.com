import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTeaser, escapeHtml } from '../src/pages.js';

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
