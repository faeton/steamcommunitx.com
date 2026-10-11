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

test('parseRoute: /id and /profiles without an ID are a missing-id page', () => {
  assert.deepEqual(parseRoute('/id'), { kind: 'missing-id', linktype: 'id' });
  assert.deepEqual(parseRoute('/id/'), { kind: 'missing-id', linktype: 'id' });
  assert.deepEqual(parseRoute('/profiles'), { kind: 'missing-id', linktype: 'profiles' });
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

test('home with feed: rows are pre-rendered from the feed snapshot', async () => {
  const feed = { ...fakeFeed(), snapshot: () => ({ hourCount: 1, generatedAt: Date.now(), entries: [
    { steamId64: '76561197960287930', dotaId: '22202', name: 'prerendered', avatarHash: '', private: false, lastTs: Date.now(), count: 1 }
  ] }) };
  const html = await (await handleRequest(new Request('https://example.com/'), { FEED: feed }, ctx)).text();
  assert.match(html, /prerendered/);
  assert.match(html, /id="feed-data"/);
});

test('home with feed: a throwing snapshot still renders the page', async () => {
  const feed = { ...fakeFeed(), snapshot() { throw new Error('db gone'); } };
  const res = await handleRequest(new Request('https://example.com/'), { FEED: feed }, ctx);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /id="feed-section"/);
});

test('parseRoute: a single unknown segment is a 404, not a redirect to Dotabuff', () => {
  assert.deepEqual(parseRoute('/nope'), { kind: 'unknown', linktype: 'nope', linkid: undefined });
  assert.deepEqual(parseRoute('/robots.txt'), { kind: 'unknown', linktype: 'robots.txt', linkid: undefined });
  assert.deepEqual(parseRoute('/id'), { kind: 'missing-id', linktype: 'id' });
});

test('handleRequest: /nope renders the 404 page', async () => {
  const res = await handleRequest(new Request('https://example.com/nope'), {}, ctx);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /Not Found/);
});

test('handleRequest: /profiles without an ID explains the URL formats instead of redirecting', async () => {
  const res = await handleRequest(new Request('https://example.com/profiles/'), { GA_ID: 'G-TEST1' }, ctx);
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.match(html, /Profile ID missing/);
  assert.match(html, /<code>\/profiles<\/code>/);
  assert.match(html, /example\.com\/id\/username/);
  assert.match(html, /example\.com\/profiles\/76561198123456789/);
  assert.match(html, /G-TEST1/);
});

test('vanity: Steam "No match" (success 42) is a 404, reported as a healthy Steam call', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async () => Response.json({ response: { success: 42, message: 'No match' } });
  try {
    const health = { ok: kind => seen.push(['ok', kind]), fail: kind => seen.push(['fail', kind]) };
    const res = await handleRequest(new Request('https://example.com/id/nobody-has-this-name', { headers: BROWSER }),
      { STEAM_API_KEY: 'k', STEAM_HEALTH: health }, ctx);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /Profile Not Found/);
    assert.deepEqual(seen, [['ok', 'vanity']]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('vanity: a Steam failure is reported to STEAM_HEALTH', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async () => new Response('', { status: 403 });
  try {
    const health = { ok: kind => seen.push(['ok', kind]), fail: kind => seen.push(['fail', kind]) };
    const res = await handleRequest(new Request('https://example.com/id/someone', { headers: BROWSER }),
      { STEAM_API_KEY: 'k', STEAM_HEALTH: health }, ctx);
    assert.ok(res.status >= 400);
    assert.deepEqual(seen.at(-1), ['fail', 'vanity']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('parseRoute: case-insensitive link type, empty segments skipped, slashes-only is home', () => {
  assert.deepEqual(parseRoute('/ID/Nick'), { kind: 'id', value: 'Nick' });
  assert.deepEqual(parseRoute('/Profiles/76561197960287930'), { kind: 'profiles', value: '76561197960287930' });
  assert.deepEqual(parseRoute('/id//nick'), { kind: 'id', value: 'nick' });
  assert.deepEqual(parseRoute('///'), { kind: 'home' });
});

test('429 page: a non-numeric Retry-After from Steam becomes 60 s, never NaN', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } });
  try {
    const res = await handleRequest(new Request('https://example.com/id/someone', { headers: BROWSER }), { STEAM_API_KEY: 'k' }, ctx);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '60');
    assert.match(await res.text(), /try again in 60 seconds/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('home ?check: parsed list pre-rendered with status from feed.watch (keyed by IP)', async () => {
  const calls = [];
  const feed = { ...fakeFeed(), watch(ids, ip) {
    calls.push([ids, ip]);
    return { generatedAt: Date.now(), items: ids.map(id => ({ dotaId: id, steamId64: '76561197960287930', lastTs: null, count: 0, name: `n${id}`, avatarHash: null, private: false })) };
  } };
  const req = new Request('https://example.com/?check=22202,junk&check=76561197960287931', { headers: { 'cf-connecting-ip': '1.2.3.4' } });
  const res = await handleRequest(req, { FEED: feed }, ctx);
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  const html = await res.text();
  assert.deepEqual(calls, [[['22202', '22203'], '1.2.3.4']]);
  assert.match(html, /n22202/);
  assert.match(html, /noindex/);
});

test('home ?check: a throwing or over-budget watch still renders ids and the feed', async () => {
  const boom = { ...fakeFeed(), watch() { throw new Error('db gone'); } };
  const html = await (await handleRequest(new Request('https://example.com/?check=42'), { FEED: boom }, ctx)).text();
  assert.match(html, /data-id="42"/);
  assert.match(html, /id="feed-section"/);
  const limited = { ...fakeFeed(), watch: () => null };
  assert.match(await (await handleRequest(new Request('https://example.com/?check=42'), { FEED: limited }, ctx)).text(), /"watch":null/);
  const none = { ...fakeFeed(), watch() { throw new Error('must not be called'); } };
  assert.match(await (await handleRequest(new Request('https://example.com/'), { FEED: none }, ctx)).text(), /"list":\[\]/);
});

test('/api/resolve.json: vanity name → Dota id, 404 on no match, 400 on junk, 429 over budget', async () => {
  const realFetch = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async url => {
    const name = new URL(url).searchParams.get('vanityurl');
    asked.push(name);
    return Response.json({ response: name === 'faeton' ? { success: 1, steamid: '76561198123456789' } : { success: 42, message: 'No match' } });
  };
  let budget = 3;
  const feed = { ...fakeFeed(), allowResolve: ip => { assert.equal(ip, '1.2.3.4'); return budget-- > 0; } };
  const env = { STEAM_API_KEY: 'k', FEED: feed };
  const req = q => new Request(`https://example.com/api/resolve.json?v=${encodeURIComponent(q)}`, { headers: { 'cf-connecting-ip': '1.2.3.4' } });
  try {
    const ok = await handleRequest(req('https://steamcommunitx.com/id/faeton/'), env, ctx);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await ok.json(), { dotaId: '163191061' });
    assert.equal((await handleRequest(req('nobody_here'), env, ctx)).status, 404);
    const junk = await handleRequest(req('<script>'), env, ctx);
    assert.equal(junk.status, 400);
    assert.equal((await handleRequest(req('faeton'), env, ctx)).status, 200);
    assert.equal((await handleRequest(req('faeton'), env, ctx)).status, 429);
    assert.deepEqual(asked, ['faeton', 'nobody_here', 'faeton']); // junk never reaches Steam
    assert.equal((await handleRequest(req('faeton'), { STEAM_API_KEY: 'k' }, ctx)).status, 404); // no feed, no endpoint
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('/api/resolve.json: concurrent lookups of one name share a Steam call; misses are cached', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    await new Promise(r => setTimeout(r, 20));
    const name = new URL(url).searchParams.get('vanityurl');
    return Response.json({ response: name === 'sharedname' ? { success: 1, steamid: '76561198123456789' } : { success: 42 } });
  };
  const env = { STEAM_API_KEY: 'k', FEED: { ...fakeFeed(), allowResolve: () => true } };
  const req = q => new Request(`https://example.com/api/resolve.json?v=${q}`);
  try {
    const [a, b] = await Promise.all([handleRequest(req('sharedname'), env, ctx), handleRequest(req('SharedName'), env, ctx)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(calls, 1);
    assert.equal((await handleRequest(req('missname'), env, ctx)).status, 404);
    assert.equal((await handleRequest(req('missname'), env, ctx)).status, 404);
    assert.equal(calls, 2); // the second miss came from the cache
  } finally {
    globalThis.fetch = realFetch;
  }
});
