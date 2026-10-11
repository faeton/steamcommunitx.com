// Node entry point: serves the same handleRequest as the Cloudflare Worker,
// with SQLite standing in for Workers KV and the recent-checks feed running
// in-process (env.FEED). Configuration comes from environment variables; see
// .env.example and the "Self-hosting" section of the README.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleRequest } from './src/core.js';
import { openDb, SqliteKV } from './src/feed/store.js';
import { createFeed } from './src/feed/index.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ASSETS = {
  '/assets/feed.js': resolve(ROOT, 'src/client/feed.js'),
  '/assets/feed-shared.js': resolve(ROOT, 'src/client/feed-shared.js')
};

function toWebRequest(req, url) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach(v => headers.append(name, v));
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(url.href, { method: req.method, headers });
}

function waitDrain(res) {
  if (res.destroyed || res.writableEnded) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

async function writeWebResponse(response, req, res) {
  const headers = {};
  response.headers.forEach((value, name) => { headers[name] = value; });
  res.writeHead(response.status, headers);
  if (req.method === 'HEAD' || !response.body) {
    response.body?.cancel().catch(() => {}); // never leave a body (e.g. an SSE stream) unread
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on('error', () => {}); // a client abort must never become an unhandled error
  res.on('close', () => { reader.cancel().catch(() => {}); });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Respect socket backpressure; a stalled SSE client then fills its own
      // bounded queue in SseHub and gets dropped.
      if (!res.write(value)) await waitDrain(res);
      if (res.destroyed) break;
    }
  } catch {
    // client went away or the stream was cancelled
  }
  if (!res.destroyed && !res.writableEnded) res.end();
}

async function serveAsset(path, res) {
  try {
    const body = await readFile(ASSETS[path]);
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function createServer({ env = process.env, dbPath = env.DB_PATH || './data/steamcommunitx.db', fetchImpl = fetch, log = console } = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = openDb(dbPath);
  const runtimeEnv = {
    ...env,
    STEAM_ID_CACHE: new SqliteKV(db, 'steamid'),
    API_KEY_STATUS: new SqliteKV(db, 'keystatus')
  };
  const feed = env.FEED_ENABLED === '0'
    ? null
    : createFeed({ db, env: runtimeEnv, fetchImpl, log, blockedWordsFile: env.BLOCKED_WORDS_FILE });
  if (feed) runtimeEnv.FEED = feed;

  const inflight = new Set();
  const ctx = {
    waitUntil(promise) {
      const p = Promise.resolve(promise).catch(e => log.error('waitUntil task failed:', e));
      inflight.add(p);
      p.finally(() => inflight.delete(p));
    }
  };

  async function handle(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true, feed: feed ? feed.health() : null });
      }
      if (url.pathname.startsWith('/assets/')) {
        if (feed && Object.hasOwn(ASSETS, url.pathname)) return await serveAsset(url.pathname, res);
        res.writeHead(404).end();
        return;
      }
      const response = await handleRequest(toWebRequest(req, url), runtimeEnv, ctx);
      await writeWebResponse(response, req, res);
    } catch (e) {
      log.error('Unhandled request error:', e);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
    }
  }

  const active = new Set();
  const server = http.createServer((req, res) => {
    const p = handle(req, res).catch(e => log.error('Request failed after response started:', e));
    active.add(p);
    p.finally(() => active.delete(p));
  });

  // Order matters: stop the feed (ends SSE streams, waits for a running tick),
  // stop accepting connections, let in-flight requests finish (5 s cap), then
  // drop what is left and only then close SQLite.
  async function close() {
    await feed?.stop();
    const closed = new Promise(r => server.close(() => r()));
    server.closeIdleConnections?.();
    await Promise.race([
      Promise.allSettled([...active]),
      new Promise(r => setTimeout(r, 5000).unref())
    ]);
    server.closeAllConnections?.();
    await closed;
    await Promise.allSettled([...active]); // handlers woken by the forced close
    await Promise.allSettled([...inflight]);
    db.close();
  }

  return { server, feed, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const app = createServer();
  app.feed?.start();
  app.server.listen(port, host, () => console.log(`steamcommunitx listening on http://${host}:${port}`));
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGHUP', () => app.feed?.reloadLists());
}
