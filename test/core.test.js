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
