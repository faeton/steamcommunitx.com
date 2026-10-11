import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertToDota2Id, getConfiguredApiKeys, parseRoute } from '../src/core.js';
import { analyticsSnippet, resolveBanners } from '../src/pages.js';
import worker from '../worker.js';

test('convertToDota2Id: SteamID64 → Dota account ID', () => {
  assert.equal(convertToDota2Id('76561197960287930'), '22202');
  assert.equal(convertToDota2Id('76561197960265728'), '0');
  assert.equal(convertToDota2Id('76561198123456789'), '163191061');
});

test('convertToDota2Id: SteamID3 bracketed form', () => {
  assert.equal(convertToDota2Id('[U:1:22202]'), '22202');
  assert.equal(convertToDota2Id('[U:1:163191061]'), '163191061');
});

test('convertToDota2Id: SteamID3 raw form, case-insensitive', () => {
  assert.equal(convertToDota2Id('U:1:22202'), '22202');
  assert.equal(convertToDota2Id('u:1:22202'), '22202');
});

test('convertToDota2Id: trims whitespace', () => {
  assert.equal(convertToDota2Id('  76561197960287930  '), '22202');
  assert.equal(convertToDota2Id('\t[U:1:22202]\n'), '22202');
});

test('convertToDota2Id: invalid inputs return null', () => {
  assert.equal(convertToDota2Id('not-an-id'), null);
  assert.equal(convertToDota2Id('123'), null);
  assert.equal(convertToDota2Id('[U:0:22202]'), null);
  assert.equal(convertToDota2Id(''), null);
});

test('getConfiguredApiKeys: single primary key', () => {
  assert.deepEqual(getConfiguredApiKeys({ STEAM_API_KEY: 'AAA' }), ['AAA']);
});

test('getConfiguredApiKeys: trims and dedupes comma-separated keys', () => {
  const env = { STEAM_API_KEY: 'AAA', STEAM_API_KEYS: ' BBB , CCC ,AAA' };
  assert.deepEqual(getConfiguredApiKeys(env), ['AAA', 'BBB', 'CCC']);
});

test('getConfiguredApiKeys: drops empty entries', () => {
  const env = { STEAM_API_KEYS: 'AAA,,BBB, ' };
  assert.deepEqual(getConfiguredApiKeys(env), ['AAA', 'BBB']);
});

test('getConfiguredApiKeys: missing config returns empty list', () => {
  assert.deepEqual(getConfiguredApiKeys({}), []);
});

test('parseRoute: home and favicon', () => {
  assert.deepEqual(parseRoute('/'), { kind: 'home' });
  assert.deepEqual(parseRoute('/favicon.ico'), { kind: 'favicon' });
});

test('parseRoute: id route decodes value', () => {
  assert.deepEqual(parseRoute('/id/gabelogannewell'), { kind: 'id', value: 'gabelogannewell' });
  assert.deepEqual(parseRoute('/id/hello%20world'), { kind: 'id', value: 'hello world' });
});

test('parseRoute: profiles route preserves SteamID3 brackets', () => {
  assert.deepEqual(parseRoute('/profiles/76561198123456789'), { kind: 'profiles', value: '76561198123456789' });
  assert.deepEqual(parseRoute('/profiles/%5BU:1:22202%5D'), { kind: 'profiles', value: '[U:1:22202]' });
});

test('parseRoute: trailing slashes are normalized', () => {
  assert.deepEqual(parseRoute('/id/foo/'), { kind: 'id', value: 'foo' });
  assert.deepEqual(parseRoute('/id/foo///'), { kind: 'id', value: 'foo' });
});

test('parseRoute: trailing subpath after the ID is ignored', () => {
  assert.deepEqual(parseRoute('/profiles/76561198989843422/inventory/'), { kind: 'profiles', value: '76561198989843422' });
  assert.deepEqual(parseRoute('/profiles/76561198123456789/games'), { kind: 'profiles', value: '76561198123456789' });
  assert.deepEqual(parseRoute('/id/gabelogannewell/friends'), { kind: 'id', value: 'gabelogannewell' });
  assert.deepEqual(parseRoute('/profiles/%5BU:1:22202%5D/screenshots'), { kind: 'profiles', value: '[U:1:22202]' });
});

test('parseRoute: empty linkid redirects to base', () => {
  assert.deepEqual(parseRoute('/id'), { kind: 'redirect-base' });
  assert.deepEqual(parseRoute('/id/'), { kind: 'redirect-base' });
  assert.deepEqual(parseRoute('/profiles'), { kind: 'redirect-base' });
});

test('parseRoute: unknown linktype falls into unknown bucket', () => {
  assert.deepEqual(parseRoute('/foo/123'), { kind: 'unknown', linktype: 'foo', linkid: '123' });
  assert.deepEqual(parseRoute('/players/22202'), { kind: 'unknown', linktype: 'players', linkid: '22202' });
});

test('parseRoute: malformed encoding falls back to raw value', () => {
  assert.deepEqual(parseRoute('/id/%E0%A4%A'), { kind: 'id', value: '%E0%A4%A' });
});

test('analyticsSnippet: empty when nothing configured', () => {
  assert.equal(analyticsSnippet({}), '');
  assert.equal(analyticsSnippet(undefined), '');
});

test('analyticsSnippet: GA only when GA_ID set', () => {
  const out = analyticsSnippet({ GA_ID: 'G-ABC123' });
  assert.match(out, /googletagmanager\.com\/gtag\/js\?id=G-ABC123/);
  assert.match(out, /gtag\('config', 'G-ABC123'\)/);
  assert.doesNotMatch(out, /matomo/i);
});

test('analyticsSnippet: Matomo only when both URL and SITE_ID set', () => {
  const out = analyticsSnippet({ MATOMO_URL: '//m.example.com/', MATOMO_SITE_ID: '7' });
  assert.match(out, /var u='\/\/m\.example\.com\/'/);
  assert.match(out, /setSiteId', '7'/);
  assert.doesNotMatch(out, /googletagmanager/);
});

test('analyticsSnippet: both providers concatenated', () => {
  const out = analyticsSnippet({
    GA_ID: 'G-ABC',
    MATOMO_URL: '//m.example.com/',
    MATOMO_SITE_ID: '1'
  });
  assert.match(out, /googletagmanager/);
  assert.match(out, /matomo\.js/);
});

test('analyticsSnippet: rejects malformed values to prevent JS injection', () => {
  assert.equal(analyticsSnippet({ GA_ID: "G-ABC');alert(1);//" }), '');
  assert.equal(analyticsSnippet({ MATOMO_URL: "javascript:alert(1)//", MATOMO_SITE_ID: '1' }), '');
  assert.equal(analyticsSnippet({ MATOMO_URL: '//m.example.com/', MATOMO_SITE_ID: '1; alert(1)' }), '');
  assert.equal(analyticsSnippet({ MATOMO_URL: '//m.example.com', MATOMO_SITE_ID: '1' }), ''); // missing trailing /
});

test('analyticsSnippet: Matomo requires both URL and SITE_ID', () => {
  assert.equal(analyticsSnippet({ MATOMO_URL: '//m.example.com/' }), '');
  assert.equal(analyticsSnippet({ MATOMO_SITE_ID: '1' }), '');
});

test('resolveBanners: no banner when unset', () => {
  assert.deepEqual(resolveBanners({}), []);
  assert.deepEqual(resolveBanners(undefined), []);
  assert.deepEqual(resolveBanners({ BANNERS: '' }), []);
  assert.deepEqual(resolveBanners({ BANNERS: '[]' }), []);
});

test('resolveBanners: parses a configured list', () => {
  const out = resolveBanners({
    BANNERS: '[{"src":"https://example.com/embed/a","height":300},' +
             '{"src":"https://example.com/embed/b","height":"320","label":"Custom caption"}]'
  });
  assert.deepEqual(out, [
    { src: 'https://example.com/embed/a', height: 300 },
    { src: 'https://example.com/embed/b', height: 320, label: 'Custom caption' }
  ]);
});

test('resolveBanners: malformed JSON or non-array yields no banner', () => {
  assert.deepEqual(resolveBanners({ BANNERS: 'not json' }), []);
  assert.deepEqual(resolveBanners({ BANNERS: '{"src":"https://example.com/a"}' }), []);
  assert.deepEqual(resolveBanners({ BANNERS: '"https://example.com/a"' }), []);
});

test('resolveBanners: drops entries that fail the format guards', () => {
  const out = resolveBanners({
    BANNERS: JSON.stringify([
      { src: 'javascript:alert(1)//', height: 300 },
      { src: 'http://example.com/embed/a', height: 300 },
      { src: 'https://example.com/a";alert(1)//', height: 300 },
      { src: 'https://example.com/a<script>', height: 300 },
      { src: 'https://example.com/a', height: 5000 },
      { src: 'https://example.com/a', height: 'tall' },
      { src: 'https://example.com/a' },
      { height: 300 },
      null
    ])
  });
  assert.deepEqual(out, []);
});

test('resolveBanners: keeps valid entries alongside rejected ones', () => {
  const out = resolveBanners({
    BANNERS: JSON.stringify([
      { src: 'javascript:alert(1)//', height: 300 },
      { src: 'https://example.com/embed/ok', height: 300 }
    ])
  });
  assert.deepEqual(out, [{ src: 'https://example.com/embed/ok', height: 300 }]);
});

test('resolveBanners: drops a label containing markup but keeps the banner', () => {
  const out = resolveBanners({
    BANNERS: JSON.stringify([
      { src: 'https://example.com/embed/a', height: 300, label: '<img src=x onerror=alert(1)>' }
    ])
  });
  assert.deepEqual(out, [{ src: 'https://example.com/embed/a', height: 300 }]);
});

test('worker adapter: serves the home page through handleRequest', async () => {
  const res = await worker.fetch(new Request('https://example.com/'), {}, { waitUntil() {} });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /One-line redirect to/);
});

import { handleRequest, toSteamId64, accountIdToSteamId64, isRealBrowser, ipHash } from '../src/core.js';

const BROWSER = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  accept: 'text/html,application/xhtml+xml',
  'cf-connecting-ip': '203.0.113.7'
};
const ctx = { waitUntil() {} };

function fakeFeed(teaser = { hourCount: 5, seen: null, faces: [] }) {
  const calls = [];
  return {
    calls,
    recordHit(hit) { calls.push(['recordHit', hit]); return true; },
    teaser(dotaId) { calls.push(['teaser', dotaId]); return teaser; },
    async handle(request) { calls.push(['handle', new URL(request.url).pathname]); return new Response('api'); }
  };
}

test('toSteamId64 / accountIdToSteamId64: all ID forms', () => {
  assert.equal(toSteamId64('76561197960287930'), '76561197960287930');
  assert.equal(toSteamId64('[U:1:22202]'), '76561197960287930');
  assert.equal(toSteamId64('U:1:22202'), '76561197960287930');
  assert.equal(toSteamId64('garbage'), null);
  assert.equal(accountIdToSteamId64('22202'), '76561197960287930');
  assert.equal(accountIdToSteamId64('12345678901'), null);
});

test('isRealBrowser: filters bots, previews and non-HTML requests', () => {
  const mk = (h, method = 'GET') => new Request('https://example.com/profiles/1', { method, headers: h });
  assert.equal(isRealBrowser(mk(BROWSER)), true);
  assert.equal(isRealBrowser(mk({ ...BROWSER, 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0)' })), false);
  assert.equal(isRealBrowser(mk({ ...BROWSER, 'user-agent': 'TelegramBot (like TwitterBot)' })), false);
  assert.equal(isRealBrowser(mk({ ...BROWSER, accept: 'application/json' })), false);
  assert.equal(isRealBrowser(mk({ ...BROWSER, 'user-agent': '' })), false);
  assert.equal(isRealBrowser(mk(BROWSER, 'HEAD')), false);
});

test('ipHash: stable within a day, short hex', async () => {
  const a = await ipHash('203.0.113.7', Date.UTC(2026, 9, 10, 12));
  const b = await ipHash('203.0.113.7', Date.UTC(2026, 9, 10, 18));
  const c = await ipHash('198.51.100.1', Date.UTC(2026, 9, 10, 18));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('redirect with feed: teaser computed BEFORE the hit, hit recorded, no-store', async () => {
  const feed = fakeFeed();
  const res = await handleRequest(new Request('https://example.com/profiles/[U:1:22202]', { headers: BROWSER }), { FEED: feed }, ctx);
  assert.deepEqual(feed.calls.map(c => c[0]), ['teaser', 'recordHit']);
  assert.equal(feed.calls[0][1], '22202');
  assert.equal(feed.calls[1][1].steamId64, '76561197960287930');
  assert.match(feed.calls[1][1].ipHash, /^[0-9a-f]{16}$/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = await res.text();
  assert.match(html, /5 players checked this hour/);
  assert.match(html, /<noscript><meta http-equiv="refresh"/);
});

test('redirect with feed: bots get the page but are not recorded', async () => {
  const feed = fakeFeed();
  const res = await handleRequest(new Request('https://example.com/profiles/76561197960287930', {
    headers: { ...BROWSER, 'user-agent': 'facebookexternalhit/1.1' }
  }), { FEED: feed }, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(feed.calls.map(c => c[0]), ['teaser']);
});

test('redirect with feed: a throwing feed never breaks the redirect', async () => {
  const feed = { recordHit() { throw new Error('boom'); }, teaser() { throw new Error('boom'); }, handle() {} };
  const res = await handleRequest(new Request('https://example.com/profiles/76561197960287930', { headers: BROWSER }), { FEED: feed }, ctx);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /dotabuff\.com\/players\/22202/);
});

test('redirect without feed: unchanged caching, no teaser, meta refresh in noscript', async () => {
  const res = await handleRequest(new Request('https://example.com/profiles/76561197960287930', { headers: BROWSER }), {}, ctx);
  assert.equal(res.headers.get('cache-control'), 'max-age=300');
  const html = await res.text();
  assert.doesNotMatch(html, /id="teaser"/);
  assert.match(html, /<noscript><meta http-equiv="refresh" content="1;url=https:\/\/www\.dotabuff\.com\/players\/22202"><\/noscript>/);
});

test('teaser language follows Accept-Language', async () => {
  const res = await handleRequest(new Request('https://example.com/profiles/76561197960287930', {
    headers: { ...BROWSER, 'accept-language': 'ru-RU,ru;q=0.9' }
  }), { FEED: fakeFeed() }, ctx);
  assert.match(await res.text(), /Проверок за час: 5/);
});

test('/api/* goes to the feed when present, 404 page otherwise', async () => {
  const feed = fakeFeed();
  const withFeed = await handleRequest(new Request('https://example.com/api/recent.json'), { FEED: feed }, ctx);
  assert.equal(await withFeed.text(), 'api');
  assert.deepEqual(feed.calls[0], ['handle', '/api/recent.json']);
  const without = await handleRequest(new Request('https://example.com/api/recent.json'), {}, ctx);
  assert.equal(without.status, 404);
});

test('home page renders the feed section only with a feed', async () => {
  const withFeed = await (await handleRequest(new Request('https://example.com/'), { FEED: fakeFeed() }, ctx)).text();
  assert.match(withFeed, /id="feed-section"/);
  assert.match(withFeed, /<script type="module" src="\/assets\/feed\.js"><\/script>/);
  const without = await (await handleRequest(new Request('https://example.com/'), {}, ctx)).text();
  assert.doesNotMatch(without, /feed-section/);
});

import { markRateLimitedKey } from '../src/core.js';

test('markRateLimitedKey: a non-numeric Retry-After falls back to 300 s instead of NaN', async () => {
  const puts = [];
  const kv = { async put(key, value, opts) { puts.push([key, opts.expirationTtl]); } };
  await markRateLimitedKey({ API_KEY_STATUS: kv }, 'k', NaN);
  await markRateLimitedKey({ API_KEY_STATUS: kv }, 'k', 60);
  assert.deepEqual(puts, [['key:k:ratelimited', 330], ['key:k:ratelimited', 90]]);
});

test('home cache: revalidated with a feed (HTML and /assets must match), long-lived without', async () => {
  const withFeed = await handleRequest(new Request('https://example.com/'), { FEED: fakeFeed() }, ctx);
  assert.equal(withFeed.headers.get('cache-control'), 'no-cache');
  const without = await handleRequest(new Request('https://example.com/'), {}, ctx);
  assert.equal(without.headers.get('cache-control'), 'max-age=3600');
});
