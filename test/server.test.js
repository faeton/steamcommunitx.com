import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server.js';

const HASH = 'fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb';
const quiet = { error() {}, warn() {}, log() {} };
const BROWSER = { 'user-agent': 'Mozilla/5.0 Chrome/120', accept: 'text/html' };

const steamOk = async url => {
  const ids = new URL(url).searchParams.get('steamids').split(',');
  return Response.json({ response: { players: ids.map(steamid => ({ steamid, personaname: 'tester', avatarhash: HASH, communityvisibilitystate: 3 })) } });
};
const steamDown = async () => { throw new Error('network down'); };

async function boot(env, fetchImpl = steamOk) {
  const app = createServer({ env, dbPath: ':memory:', fetchImpl, log: quiet });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, base };
}

test('server with feed: home, redirect + hit, recent.json, assets, healthz', async () => {
  const app = await boot({ STEAM_API_KEY: 'k' });
  try {
    const home = await fetch(`${app.base}/`);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /id="feed-section"/);

    const redirect = await fetch(`${app.base}/profiles/76561197960287930`, { headers: BROWSER, redirect: 'manual' });
    assert.equal(redirect.status, 200);
    assert.equal(redirect.headers.get('cache-control'), 'no-store');
    await redirect.text();

    await app.feed.tick();
    const recent = await (await fetch(`${app.base}/api/recent.json`)).json();
    assert.deepEqual(recent.entries.map(e => [e.dotaId, e.name]), [['22202', 'tester']]);

    const js = await fetch(`${app.base}/assets/feed.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /text\/javascript/);
    await js.text();
    assert.equal((await fetch(`${app.base}/assets/nope.js`)).status, 404);

    const health = await (await fetch(`${app.base}/healthz`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.feed.pending, 0);

    const headStream = await fetch(`${app.base}/api/stream`, { method: 'HEAD' });
    assert.equal(headStream.status, 200);
    assert.equal(app.feed.health().clients, 0);

    const head = await fetch(`${app.base}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally {
    await app.close();
  }
});

test('server with Steam down: /profiles redirects still work, hit stays queued', async () => {
  const app = await boot({ STEAM_API_KEY: 'k' }, steamDown);
  try {
    const res = await fetch(`${app.base}/profiles/76561197960287930`, { headers: BROWSER });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /dotabuff\.com\/players\/22202/);
    await app.feed.tick();
    assert.equal(app.feed.health().pending, 1);
  } finally {
    await app.close();
  }
});

test('server with FEED_ENABLED=0: behaves like the Worker', async () => {
  const app = await boot({ FEED_ENABLED: '0' });
  try {
    assert.equal(app.feed, null);
    assert.doesNotMatch(await (await fetch(`${app.base}/`)).text(), /feed-section/);
    assert.equal((await fetch(`${app.base}/api/recent.json`)).status, 404);
    assert.equal((await fetch(`${app.base}/assets/feed.js`)).status, 404);
    const redirect = await fetch(`${app.base}/profiles/76561197960287930`, { headers: BROWSER });
    assert.equal(redirect.headers.get('cache-control'), 'max-age=300');
    await redirect.text();
    const health = await (await fetch(`${app.base}/healthz`)).json();
    assert.deepEqual(health, { ok: true, feed: null });
  } finally {
    await app.close();
  }
});

test('server: SSE stream delivers a snapshot and closes cleanly on shutdown', async () => {
  const app = await boot({ STEAM_API_KEY: 'k' });
  const res = await fetch(`${app.base}/api/stream`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /event: snapshot/);
  await app.close();
  const end = await reader.read().catch(() => ({ done: true }));
  assert.equal(end.done, true);
});

import { EventEmitter } from 'node:events';
import { writeWebResponse } from '../server.js';

function fakeRes({ drains = false } = {}) {
  const res = new EventEmitter();
  Object.assign(res, {
    destroyed: false, writableEnded: false, chunks: 0,
    writeHead() {},
    write() { this.chunks++; return drains; },
    end() { this.writableEnded = true; },
    destroy() { this.destroyed = true; this.emit('close'); }
  });
  return res;
}

test('writeWebResponse: a socket that never drains is destroyed after the timeout', async () => {
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(8)); } });
  const res = fakeRes();
  await writeWebResponse(new Response(body), { method: 'GET' }, res, { drainTimeoutMs: 20 });
  assert.equal(res.destroyed, true);
});

test('writeWebResponse: a body stream that errors destroys the socket instead of ending it cleanly', async () => {
  const body = new ReadableStream({ start(c) { c.error(new Error('SSE client lagging')); } });
  const res = fakeRes({ drains: true });
  await writeWebResponse(new Response(body), { method: 'GET' }, res);
  assert.equal(res.destroyed, true);
  assert.equal(res.writableEnded, false);
});

test('server: close() is bounded even when a request is stuck on Steam', async () => {
  const realFetch = globalThis.fetch;
  let stuck;
  const reached = new Promise(r => { stuck = r; });
  globalThis.fetch = (url, opts) => String(url).includes('ResolveVanityURL')
    ? (stuck(), new Promise(() => {}))
    : realFetch(url, opts);
  const app = createServer({ env: { STEAM_API_KEY: 'k' }, dbPath: ':memory:', fetchImpl: steamOk, log: quiet, shutdownMs: 100 });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  try {
    realFetch(`http://127.0.0.1:${app.server.address().port}/id/somebody`, { headers: BROWSER }).catch(() => {});
    await reached;
    const started = Date.now();
    await app.close();
    assert.ok(Date.now() - started < 2000, `close took ${Date.now() - started} ms`);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('server: close() is idempotent (a second signal does not close SQLite twice)', async () => {
  const app = await boot({ STEAM_API_KEY: 'k' });
  await Promise.all([app.close(), app.close()]);
  await app.close();
});
