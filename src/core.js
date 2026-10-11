import { analyticsSnippet, resolveBanners, indexPage, errorPage, redirectPage, escapeHtml } from './pages.js';
import { pickLang, parseCheckList, vanityName } from './client/feed-shared.js';

// Helper functions for API key management
export function getConfiguredApiKeys(env) {
  const primaryKey = env.STEAM_API_KEY;
  const multiKeys = env.STEAM_API_KEYS ? env.STEAM_API_KEYS.split(',') : [];
  const allKeys = primaryKey ? [primaryKey, ...multiKeys] : multiKeys;
  return [...new Set(allKeys.map(k => (k || '').trim()).filter(Boolean))];
}

export async function getAvailableApiKeys(env) {
  const keys = getConfiguredApiKeys(env);
  if (!env.API_KEY_STATUS || keys.length <= 1) return keys;
  const statuses = await Promise.all(keys.map(async k => {
    const [invalid, ratelimited] = await Promise.all([
      env.API_KEY_STATUS.get(`key:${k}:invalid`),
      env.API_KEY_STATUS.get(`key:${k}:ratelimited`)
    ]);
    return { key: k, healthy: !invalid && !ratelimited };
  }));
  const healthy = statuses.filter(s => s.healthy).map(s => s.key);
  return healthy.length ? healthy : keys;
}

function maskApiKey(key) {
  if (!key) return 'undefined';
  return key.substring(0, 4) + '...' + key.slice(-4);
}

export async function markProblemKey(env, key) {
  if (!env.API_KEY_STATUS) return;
  try {
    await env.API_KEY_STATUS.put(`key:${key}:invalid`, 'true', { expirationTtl: 24 * 60 * 60 });
    console.log(`Marked key ${maskApiKey(key)} as problematic for 24 hours`);
  } catch (e) {
    console.error("Error marking problem key:", e);
  }
}

export async function markRateLimitedKey(env, key, retryAfter) {
  if (!env.API_KEY_STATUS) return;
  try {
    // Retry-After may be an HTTP date; anything non-numeric means the default.
    const seconds = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 300;
    const expirationSecs = Math.min(seconds + 30, 3600);
    await env.API_KEY_STATUS.put(`key:${key}:ratelimited`, 'true', { expirationTtl: expirationSecs });
    console.log(`Marked key ${maskApiKey(key)} as rate-limited for ${expirationSecs} seconds`);
  } catch (e) {
    console.error("Error marking rate-limited key:", e);
  }
}

export async function markWorkingKey(env, key) {
  if (!env.API_KEY_STATUS) return;
  try {
    await env.API_KEY_STATUS.delete(`key:${key}:invalid`);
    await env.API_KEY_STATUS.delete(`key:${key}:ratelimited`);
    await env.API_KEY_STATUS.put(`key:${key}:lastSuccess`, Date.now().toString());
  } catch (e) {
    console.error("Error marking working key:", e);
  }
}

// Steam favicon data URI (16x16 pixel steam icon) in base64 format
const FAVICON_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAAOwQAADsEBuJFr7QAAABh0RVh0U29mdHdhcmUAcGFpbnQubmV0IDQuMS40E0BoxAAAAi5JREFUOE+Nk11IU2EYx895z5xp5XTPkRZEaLSQRKIvg2BdjOqqusygi4igDxKCIKjQ6iYJvCgqoC4yCJVVRLYuKgJjRhIjknTZrJbbdOtnTve8x/ectzMbSREd+PG+7/Oe33/P4YwAgJXq+7L00tLGO5IktXs8HsXv93N0JG7bNlKpFGKxmDE3N7e7vq16JuobYSa7jBv5hH9IpVlZWbGDwaBcLBZFOI0LBoOSYzX9jeUQe+V2u+njPYVCQaGDMFEUuWg0yjnneNI/OQgrrA8pn5+f53a7jVIbE8bIssznYuOdnP3rXsP1UMkXicOKshSLxar5lfwQnx6wSQghaHVzc9MhgZJ1aGB8jx40Pmj/8K1nQdO0DKiZXQIpODo6Wp0XoSFd13VmGAY1MNbW1g5Isy9qVsLSLZLUQdp40DLgQXu329vbTSG1ShBDT7+7rl7Wh+TJcbbf1+YNXzQO+WBgwPuhrVB8Xry9P9nU1LQjSIqibE+n00J++OFgw+ztdX6fnfvt7+rlJ8N8crI7YVlWlCRCnQoC4P11a54f8l4oG7Ihi2VjyftLIhfh0+3HzlfMqNVqxQlXBcoUaPgpfT3+4nxDLPyyOWLJXR+fHu8M66YRJIIcwv8EbFVeWhvXwmeDnVHpTnBKGy1ySwQZRRgpCb5Pd+5/o6jLR3lc4T7a1mWiD5IBl8sFWZYhCALVxiZMJdlsljGhJEHXC0X+mIqJ7Krt1P8LI6/EBYk0I1UAAAAASUVORK5CYII=";

const base = "https://www.dotabuff.com/";

async function getId(vanityUrl, env) {
  const normalizedVanity = vanityUrl.toLowerCase().trim();
  const cacheKey = `steamid:${normalizedVanity}`;
  try {
    if (env.STEAM_ID_CACHE) {
      const cachedId = await env.STEAM_ID_CACHE.get(cacheKey);
      if (cachedId) {
        console.log(`Cache hit for ${normalizedVanity}`);
        return cachedId;
      }
    }
  } catch (e) {
    console.error("Cache read error:", e);
  }
  const apiKeys = await getAvailableApiKeys(env);
  if (!apiKeys || apiKeys.length === 0) {
    throw { status: 503, message: "Steam API service unavailable - No API keys configured" };
  }
  const fetchWithRetry = async (retries = 2, backoff = 1000, keyIndex = 0) => {
    if (keyIndex >= apiKeys.length) {
      keyIndex = 0;
      backoff = backoff * 2;
    }
    const apiKey = apiKeys[keyIndex];
    const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${encodeURIComponent(apiKey)}&vanityurl=${encodeURIComponent(normalizedVanity)}`;
    console.log(`Trying API request with key index ${keyIndex}`);
    try {
      const response = await fetch(url, {
        headers: {
          "content-type": "application/json;charset=UTF-8",
          ...(retries < 2 && keyIndex === 0 ? { "Cache-Control": "no-cache" } : {})
        },
        cf: { cacheTtl: 3600 }
      });
      if (response.status === 401 || response.status === 403) {
        console.error(`API key ${maskApiKey(apiKey)} appears to be invalid (${response.status})`);
        await markProblemKey(env, apiKey);
        if (keyIndex + 1 < apiKeys.length) {
          console.log(`Trying next API key (index ${keyIndex + 1})`);
          return fetchWithRetry(retries, backoff, keyIndex + 1);
        }
      }
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '300');
        console.log(`Steam API rate limited with key ${maskApiKey(apiKey)}. Retry after ${retryAfter}s`);
        await markRateLimitedKey(env, apiKey, retryAfter);
        if (keyIndex + 1 < apiKeys.length) {
          console.log(`Switching to next API key (index ${keyIndex + 1})`);
          return fetchWithRetry(retries, backoff, keyIndex + 1);
        }
        if (retries > 0) {
          const waitTime = Math.min(5000, retryAfter * 1000);
          console.log(`Waiting ${waitTime}ms before retry. Retries left: ${retries}`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          return fetchWithRetry(retries - 1, backoff * 2, 0);
        }
        throw { status: 429, message: "All Steam API keys are rate limited", retryAfter };
      }
      if (!response.ok) {
        throw new Error(`Steam API error: ${response.statusText} (${response.status})`);
      }
      const data = await response.json();
      // 42 = "No match": a valid answer (unknown vanity name), not an API
      // failure, so no retries or key rotation.
      if (data?.response?.success === 42) {
        console.log(`No Steam ID found for vanity URL: ${normalizedVanity}`);
        return null;
      }
      if (data?.response?.success !== 1) {
        console.log(`API returned unsuccessful response: ${JSON.stringify(data.response)}`);
        throw new Error(`Steam API returned unsuccessful response: ${data?.response?.message || 'Unknown error'}`);
      }
      const steamId = data?.response?.steamid;
      if (!steamId) {
        console.log(`No Steam ID found for vanity URL: ${normalizedVanity}`);
        return null;
      }
      if (env.STEAM_ID_CACHE) {
        try {
          const oneMonthInSeconds = 30 * 24 * 60 * 60;
          await env.STEAM_ID_CACHE.put(cacheKey, steamId, { expirationTtl: oneMonthInSeconds });
          console.log(`Cached ${normalizedVanity} -> ${steamId} for 30 days`);
        } catch (e) {
          console.error("Cache write error:", e);
        }
      }
      await markWorkingKey(env, apiKey);
      return steamId;
    } catch (error) {
      if (error.status) throw error;
      console.error(`Error with API key ${maskApiKey(apiKey)}:`, error.message);
      if (keyIndex + 1 < apiKeys.length) {
        console.log(`Trying next API key (index ${keyIndex + 1}) after error`);
        return fetchWithRetry(retries, backoff, keyIndex + 1);
      }
      if (retries > 0) {
        console.log(`General error, retrying. Retries left: ${retries}`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        return fetchWithRetry(retries - 1, backoff * 2, 0);
      }
      throw { status: 500, message: "Failed to fetch Steam ID after multiple attempts" };
    }
  };
  try {
    const steamId = await fetchWithRetry();
    env.STEAM_HEALTH?.ok('vanity');
    return steamId;
  } catch (error) {
    env.STEAM_HEALTH?.fail('vanity', error);
    throw error;
  }
}

export function convertToDota2Id(steamId) {
  const cleanId = steamId.trim();
  if (/^\[U:1:\d+\]$/.test(cleanId)) {
    const match = cleanId.match(/\[U:1:(\d+)\]/);
    if (match && match[1]) return match[1];
  }
  if (/^\d{17}$/.test(cleanId)) {
    try {
      return (BigInt(cleanId) - BigInt("76561197960265728")).toString();
    } catch (e) {
      console.error(`Error converting SteamID64: ${cleanId}`, e);
      return null;
    }
  }
  const rawSteamId3Match = cleanId.match(/^U:1:(\d+)$/i);
  if (rawSteamId3Match && rawSteamId3Match[1]) return rawSteamId3Match[1];
  console.error(`Failed to convert Steam ID: ${steamId} (cleaned: ${cleanId})`);
  return null;
}

const STEAM64_BASE = 76561197960265728n;

export function accountIdToSteamId64(accountId) {
  const s = String(accountId ?? '').trim();
  if (!/^\d{1,10}$/.test(s)) return null;
  return (BigInt(s) + STEAM64_BASE).toString();
}

// Any supported profile ID form (SteamID64, [U:1:x], U:1:x) → SteamID64.
export function toSteamId64(value) {
  const s = String(value ?? '').trim();
  if (/^\d{17}$/.test(s)) return s;
  const m = s.match(/^\[?U:1:(\d+)\]?$/i);
  return m ? accountIdToSteamId64(m[1]) : null;
}

// Link-preview bots and crawlers fetch profile URLs too; only real page views
// should show up in the recent-checks feed.
const BOT_UA_RE = /bot|crawl|spider|preview|discord|telegram|whatsapp|slack|facebookexternalhit|twitterbot|skype|embed/i;

export function isRealBrowser(request) {
  if (request.method !== 'GET') return false;
  if (!(request.headers.get('accept') || '').includes('text/html')) return false;
  const ua = request.headers.get('user-agent') || '';
  return ua.length > 0 && !BOT_UA_RE.test(ua);
}

// Rate-limit key for the feed. The salt is random, in memory only, and rotates
// daily, so the hash cannot be reversed or linked across days. IPs are never
// stored.
let saltDay = '';
let salt = '';
export async function ipHash(ip, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  if (day !== saltDay) {
    saltDay = day;
    salt = crypto.randomUUID();
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}|${ip || ''}`));
  return Array.from(new Uint8Array(digest).slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
}

// Pure router: classifies a request pathname.
// Returns one of:
//   { kind: 'favicon' }
//   { kind: 'home' }
//   { kind: 'missing-id', linktype }       — /id or /profiles without an ID
//   { kind: 'unknown', linktype, linkid }  — anything that is not a profile path
//   { kind: 'id' | 'profiles', value }     — recognized route, value is decoded
export function parseRoute(pathname) {
  if (pathname === '/favicon.ico') return { kind: 'favicon' };
  if (pathname === '/') return { kind: 'home' };
  // Steam profile URLs often carry a subpath (/inventory, /games, /friends,
  // /screenshots, ...). Only the first segment after the linktype is the
  // vanity/ID — ignore anything after it so those URLs still resolve.
  // Empty segments (//) are skipped and the link type is case-insensitive.
  const segments = pathname.split('/').filter(Boolean);
  if (!segments.length) return { kind: 'home' };
  const linktype = segments[0].toLowerCase() === 'id' || segments[0].toLowerCase() === 'profiles'
    ? segments[0].toLowerCase() : segments[0];
  const rawId = segments[1];
  // Only /id/… and /profiles/… are Steam profile paths; anything else is a 404
  // rather than a blind redirect to Dotabuff.
  if (linktype !== 'id' && linktype !== 'profiles') {
    return { kind: 'unknown', linktype, linkid: rawId };
  }
  if (!rawId) return { kind: 'missing-id', linktype };
  let value;
  try {
    value = decodeURIComponent(rawId);
  } catch {
    value = rawId;
  }
  return { kind: linktype, value };
}

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
}

// Watchlist "+ ID" box: a vanity name (or /id/<name> URL) → Dota id. One
// Steam call per add, never on render; successful names are cached by getId.
async function resolveVanity(request, env) {
  const name = vanityName(new URL(request.url).searchParams.get('v'));
  if (!name) return jsonResponse({ error: 'not a vanity name' }, 400);
  if (!env.FEED.allowResolve(request.headers.get('cf-connecting-ip') || '')) {
    return jsonResponse({ error: 'too many requests' }, 429, { 'Retry-After': '60' });
  }
  let steamId64;
  try {
    steamId64 = await getId(name, env);
  } catch (e) {
    return jsonResponse({ error: 'steam unavailable' }, 502);
  }
  const dotaId = steamId64 ? convertToDota2Id(steamId64) : null;
  return dotaId ? jsonResponse({ dotaId: String(dotaId) }) : jsonResponse({ error: 'no match' }, 404);
}

export async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const { pathname, hostname } = url;
  if (env.FEED && pathname === '/api/resolve.json') return resolveVanity(request, env);
  if (env.FEED && pathname.startsWith('/api/')) return env.FEED.handle(request);
  const route = parseRoute(pathname);
  if (route.kind === 'favicon') return handleFavicon();
  const analytics = analyticsSnippet(env);
  const lang = pickLang(request.headers.get('accept-language'));
  if (route.kind === 'home') {
    let snapshot = null;
    if (env.FEED) {
      try { snapshot = env.FEED.snapshot(); } catch (e) { console.error("Feed snapshot failed:", e); }
    }
    // Watchlist: the body depends only on the URL (no cookies), so the page
    // stays safe to revalidate like any other.
    const watchList = env.FEED ? parseCheckList(url.searchParams.getAll('check')) : [];
    let watch = null;
    if (watchList.length) {
      try { watch = env.FEED.watch(watchList, request.headers.get('cf-connecting-ip') || ''); } catch (e) { console.error("Feed watch failed:", e); }
    }
    return new Response(indexPage(hostname, analytics, { feed: Boolean(env.FEED), lang, snapshot, watchList, watch }), {
      status: 200,
      // With the feed the page loads /assets modules that change on deploy, so
      // browsers revalidate instead of pairing an old page with new scripts.
      headers: {
        'Content-Type': 'text/html',
        'Cache-Control': env.FEED ? 'no-cache' : 'max-age=3600',
        // A shared ?check link must not leak its ids to the sites we link to.
        'Referrer-Policy': 'strict-origin-when-cross-origin'
      }
    });
  }
  if (route.kind === 'missing-id') {
    // A cut-off link: explain the formats instead of dumping the visitor on
    // Dotabuff's front page.
    const host = escapeHtml(hostname);
    return new Response(
      errorPage(hostname, 404, "Profile ID missing",
        `This link stops at <code>/${route.linktype}</code> without a player. Add a vanity name or a Steam ID:` +
        `<ul class="formats"><li><code>${host}/id/username</code></li>` +
        `<li><code>${host}/profiles/76561198123456789</code></li>` +
        `<li><code>${host}/profiles/[U:1:123456789]</code></li></ul>` +
        `<p>Or open any Steam profile and replace <code>steamcommunity.com</code> with <code>${host}</code> in the address bar.</p>`,
        analytics),
      { status: 404, headers: { 'Content-Type': 'text/html' } }
    );
  }
  if (route.kind === 'unknown') {
    return new Response(
      errorPage(hostname, 404, "Not Found", "Only /id/{vanity} and /profiles/{steamID} are supported.", analytics),
      { status: 404, headers: { 'Content-Type': 'text/html' } }
    );
  }
  try {
    let linkid;
    let steamId64 = null;
    if (route.kind === 'id') {
      steamId64 = await getId(route.value, env);
      linkid = steamId64 ? convertToDota2Id(steamId64) : null;
    } else {
      linkid = convertToDota2Id(route.value);
      steamId64 = linkid ? toSteamId64(route.value) : null;
    }
    if (!linkid) {
      return new Response(
        errorPage(hostname, 404, "Profile Not Found", "We could not resolve a valid Steam ID for the provided URL.", analytics),
        { status: 404, headers: { 'Content-Type': 'text/html' } }
      );
    }
    const destinationURL = `${base}players/${linkid}`;
    let teaser = null;
    if (env.FEED) {
      // Teaser first: it must reflect earlier visits, not the one being served.
      try { teaser = env.FEED.teaser(linkid); } catch (e) { console.error("Feed teaser failed:", e); }
      if (steamId64 && isRealBrowser(request)) {
        try {
          env.FEED.recordHit({ steamId64, ipHash: await ipHash(request.headers.get('cf-connecting-ip')) });
        } catch (e) {
          console.error("Feed recordHit failed:", e);
        }
      }
    }
    return new Response(
      redirectPage(destinationURL, hostname, analytics, resolveBanners(env), { teaser, lang }),
      { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': env.FEED ? 'no-store' : 'max-age=300' } }
    );
  } catch (error) {
    console.error("Request handling error:", error);
    if (error.status === 429) {
      return new Response(
        errorPage(hostname, 429, "Rate Limit Exceeded", `We're receiving too many requests. Please try again in ${error.retryAfter || 60} seconds.`, analytics),
        { status: 429, headers: { 'Content-Type': 'text/html', 'Retry-After': String(error.retryAfter || 60) } }
      );
    }
    return new Response(
      errorPage(hostname, error.status || 500, error.message || "Server Error", "Something went wrong processing your request. Please try again later.", analytics),
      { status: error.status || 500, headers: { 'Content-Type': 'text/html' } }
    );
  }
}

function handleFavicon() {
  const binaryString = atob(FAVICON_BASE64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Response(bytes, {
    status: 200,
    headers: { 'Content-Type': 'image/x-icon', 'Cache-Control': 'public, max-age=86400' }
  });
}
