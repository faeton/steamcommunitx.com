// Helper functions for API key management
export function getConfiguredApiKeys(env) {
  const primaryKey = env.STEAM_API_KEY;
  const multiKeys = env.STEAM_API_KEYS ? env.STEAM_API_KEYS.split(',') : [];
  const allKeys = primaryKey ? [primaryKey, ...multiKeys] : multiKeys;
  return [...new Set(allKeys.map(k => (k || '').trim()).filter(Boolean))];
}

async function getAvailableApiKeys(env) {
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

async function markProblemKey(env, key) {
  if (!env.API_KEY_STATUS) return;
  try {
    await env.API_KEY_STATUS.put(`key:${key}:invalid`, 'true', { expirationTtl: 24 * 60 * 60 });
    console.log(`Marked key ${maskApiKey(key)} as problematic for 24 hours`);
  } catch (e) {
    console.error("Error marking problem key:", e);
  }
}

async function markRateLimitedKey(env, key, retryAfter) {
  if (!env.API_KEY_STATUS) return;
  try {
    const expirationSecs = Math.min(retryAfter + 30, 3600);
    await env.API_KEY_STATUS.put(`key:${key}:ratelimited`, 'true', { expirationTtl: expirationSecs });
    console.log(`Marked key ${maskApiKey(key)} as rate-limited for ${expirationSecs} seconds`);
  } catch (e) {
    console.error("Error marking rate-limited key:", e);
  }
}

async function markWorkingKey(env, key) {
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

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};

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
  return fetchWithRetry();
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

// Pure router: classifies a request pathname.
// Returns one of:
//   { kind: 'favicon' }
//   { kind: 'home' }
//   { kind: 'redirect-base' }              — empty linktype/linkid
//   { kind: 'unknown', linktype, linkid }  — linktype not in whitelist
//   { kind: 'id' | 'profiles', value }     — recognized route, value is decoded
export function parseRoute(pathname) {
  if (pathname === '/favicon.ico') return { kind: 'favicon' };
  if (pathname === '/') return { kind: 'home' };
  const cleanPath = pathname.replace(/\/+$/, '');
  const [, linktype, ...rest] = cleanPath.split('/');
  const rawId = rest.join('/');
  if (!linktype || !rawId) return { kind: 'redirect-base' };
  if (linktype !== 'id' && linktype !== 'profiles') {
    return { kind: 'unknown', linktype, linkid: rawId };
  }
  let value;
  try {
    value = decodeURIComponent(rawId);
  } catch {
    value = rawId;
  }
  return { kind: linktype, value };
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const { pathname, hostname } = url;
  const route = parseRoute(pathname);
  if (route.kind === 'favicon') return handleFavicon();
  const analytics = analyticsSnippet(env);
  if (route.kind === 'home') {
    return new Response(indexPage(hostname, analytics), {
      status: 200,
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'max-age=3600' }
    });
  }
  if (route.kind === 'redirect-base') {
    return Response.redirect(base, 301);
  }
  if (route.kind === 'unknown') {
    return new Response(
      errorPage(hostname, 404, "Not Found", "Only /id/{vanity} and /profiles/{steamID} are supported.", analytics),
      { status: 404, headers: { 'Content-Type': 'text/html' } }
    );
  }
  try {
    let linkid;
    if (route.kind === 'id') {
      const steamId64 = await getId(route.value, env);
      linkid = steamId64 ? convertToDota2Id(steamId64) : null;
    } else {
      linkid = convertToDota2Id(route.value);
    }
    if (!linkid) {
      return new Response(
        errorPage(hostname, 404, "Profile Not Found", "We could not resolve a valid Steam ID for the provided URL.", analytics),
        { status: 404, headers: { 'Content-Type': 'text/html' } }
      );
    }
    const destinationURL = `${base}players/${linkid}`;
    return new Response(
      redirectPage(destinationURL, hostname, analytics),
      { status: 200, headers: { 'Content-Type': 'text/html', 'Cache-Control': 'max-age=300' } }
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

function getCommonStyles() {
  return `
    body { 
      font-family: Arial, sans-serif; 
      margin: 40px auto; 
      max-width: 700px; 
      line-height: 1.6;
      background-color: rgb(28, 36, 45);
      color: #c6d4df;
    }
    h1 { 
      color: #66c0f4;
    }
    a { 
      color: #66c0f4;
      text-decoration: none;
    }
    a:hover { 
      text-decoration: underline;
    }
  `;
}

// Strict format guards so env values can't break out of JS string literals.
const GA_ID_RE = /^[A-Za-z0-9_-]+$/;
const MATOMO_URL_RE = /^(https?:)?\/\/[A-Za-z0-9.\-/]+\/$/;
const MATOMO_SITE_ID_RE = /^\d+$/;

export function analyticsSnippet(env) {
  const parts = [];

  if (env?.GA_ID && GA_ID_RE.test(env.GA_ID)) {
    parts.push(`<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=${env.GA_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${env.GA_ID}');
</script>`);
  }

  if (env?.MATOMO_URL && env?.MATOMO_SITE_ID
      && MATOMO_URL_RE.test(env.MATOMO_URL)
      && MATOMO_SITE_ID_RE.test(env.MATOMO_SITE_ID)) {
    parts.push(`<!-- Matomo -->
<script>
  var _paq = window._paq = window._paq || [];
  _paq.push(['trackPageView']);
  _paq.push(['enableLinkTracking']);
  (function() {
    var u='${env.MATOMO_URL}';
    _paq.push(['setTrackerUrl', u+'matomo.php']);
    _paq.push(['setSiteId', '${env.MATOMO_SITE_ID}']);
    var d=document, g=d.createElement('script'), s=d.getElementsByTagName('script')[0];
    g.async=true; g.src=u+'matomo.js'; s.parentNode.insertBefore(g,s);
  })();
</script>
<!-- End Matomo Code -->`);
  }

  return parts.join('\n');
}

const REPO_URL = "https://github.com/faeton/steamcommunitx.com";

function indexPage(hostname, analytics = '') {
  const host = hostname.split('/')[0];
  const examples = [
    { from: 'steamcommunity.com/id/username',                  to: `${host}/id/username`,                  label: 'Vanity URL' },
    { from: 'steamcommunity.com/profiles/76561198123456789',   to: `${host}/profiles/76561198123456789`,   label: 'SteamID64' },
    { from: 'steamcommunity.com/profiles/[U:1:123456789]',     to: `${host}/profiles/[U:1:123456789]`,     label: 'SteamID3' }
  ];
  const exampleCards = examples.map(e => `
        <article class="ex">
          <div class="ex-label">${e.label}</div>
          <div class="ex-row">
            <code class="ex-from">${e.from}</code>
            <svg class="ex-arrow" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M4 11h12.17l-5.59-5.59L12 4l8 8-8 8-1.41-1.41L16.17 13H4z"/></svg>
            <code class="ex-to">${e.to}</code>
          </div>
        </article>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Steam → Dotabuff Redirector</title>
  <meta name="description" content="Drop-in replacement for steamcommunity.com that redirects any Steam profile URL straight to the matching Dotabuff player page.">
  ${analytics}
  <style>
    :root {
      --bg: #0f1620;
      --bg-2: #182230;
      --surface: #1c2530;
      --surface-2: #232f3e;
      --border: #2a3848;
      --text: #e6edf3;
      --muted: #8b9bac;
      --accent: #66c0f4;
      --accent-2: #4aa3d9;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background:
        radial-gradient(ellipse at top, rgba(102,192,244,0.08), transparent 60%),
        radial-gradient(ellipse at bottom right, rgba(102,192,244,0.05), transparent 50%),
        var(--bg);
      color: var(--text);
      line-height: 1.6;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    .wrap { max-width: 760px; margin: 0 auto; padding: 64px 20px 48px; }
    header.hero { text-align: center; margin-bottom: 56px; }
    .pill {
      display: inline-block;
      padding: 4px 12px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
      background: rgba(102,192,244,0.1);
      border: 1px solid rgba(102,192,244,0.25);
      border-radius: 999px;
      margin-bottom: 20px;
    }
    h1 {
      font-size: clamp(2rem, 5vw, 3rem);
      line-height: 1.15;
      margin: 0 0 16px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text);
    }
    h1 .accent { color: var(--accent); }
    .tagline { font-size: 1.1rem; color: var(--muted); max-width: 520px; margin: 0 auto; }

    section.examples { display: grid; gap: 12px; margin-bottom: 40px; }
    .ex {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 20px;
      transition: border-color 0.15s ease, transform 0.15s ease;
    }
    .ex:hover { border-color: var(--accent-2); }
    .ex-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 10px;
    }
    .ex-row {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .ex code {
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      font-size: 0.9rem;
      padding: 6px 10px;
      border-radius: 6px;
      word-break: break-all;
      flex: 1 1 240px;
    }
    .ex-from { background: var(--bg-2); color: var(--muted); }
    .ex-to   { background: rgba(102,192,244,0.12); color: var(--accent); border: 1px solid rgba(102,192,244,0.25); }
    .ex-arrow { color: var(--muted); flex-shrink: 0; }

    .how {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px 24px;
      margin-bottom: 40px;
    }
    .how h2 { margin: 0 0 8px; font-size: 1rem; color: var(--accent); letter-spacing: 0.04em; text-transform: uppercase; }
    .how p { margin: 0; color: var(--muted); font-size: 0.95rem; }
    .how strong { color: var(--text); font-weight: 600; }

    footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
      padding-top: 24px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 0.875rem;
    }
    footer a {
      color: var(--muted);
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: color 0.15s ease;
    }
    footer a:hover { color: var(--accent); }
    .gh-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-weight: 500;
      transition: border-color 0.15s ease, transform 0.15s ease;
    }
    .gh-badge:hover { border-color: var(--accent); color: var(--accent); transform: translateY(-1px); }

    @media (max-width: 480px) {
      .wrap { padding: 40px 16px 32px; }
      header.hero { margin-bottom: 36px; }
      .ex-row { gap: 8px; }
      .ex-arrow { transform: rotate(90deg); margin: 4px auto; }
      footer { justify-content: center; text-align: center; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="hero">
      <span class="pill">Steam → Dotabuff</span>
      <h1>One-line redirect to <span class="accent">Dotabuff</span></h1>
      <p class="tagline">Swap <code style="color:var(--accent)">steamcommunity.com</code> for <code style="color:var(--accent)">${host}</code> in any Steam profile URL — get sent straight to the matching Dotabuff page.</p>
    </header>

    <section class="examples" aria-label="URL conversion examples">${exampleCards}
    </section>

    <section class="how">
      <h2>How it works</h2>
      <p>Vanity URLs are resolved through the Steam Web API and cached. SteamID64 and SteamID3 formats are converted locally — no API call needed.</p>
    </section>

    <footer>
      <span>MIT licensed · Cloudflare Worker</span>
      <a class="gh-badge" href="${REPO_URL}" target="_blank" rel="noopener">
        <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
        View on GitHub
      </a>
    </footer>
  </div>
</body>
</html>`;
}

function errorPage(hostname, statusCode, title, message, analytics = '') {
  const retrySecondsMatch = message.match(/(\d+) seconds/);
  const retrySeconds = retrySecondsMatch ? parseInt(retrySecondsMatch[1], 10) : 30;
  const autoRefresh = statusCode === 429
    ? `<meta http-equiv="refresh" content="${Math.min(30, retrySeconds)}">`
    : '';
  return `<!DOCTYPE html>
<html>
<head>
  <title>${title} - Steam to Dotabuff</title>
  ${analytics}
  ${autoRefresh}
  <style>
    ${getCommonStyles()}
    .error-code { color: #8f98a0; font-size: 0.9em; }
    .message { margin: 20px 0; }
    .back-link { margin-top: 30px; }
    .retry-timer { 
      font-weight: bold; 
      margin-top: 20px;
      font-size: 1.2em;
    }
    ${statusCode === 429 ? `.countdown { 
      display: inline-block;
      padding: 5px 15px;
      background: rgb(28,36,45);
      border-radius: 4px;
      font-weight: bold;
      color: #e74c3c;
    }
    @keyframes pulse {
      0% { opacity: 1; }
      50% { opacity: 0.5; }
      100% { opacity: 1; }
    }
    .auto-refresh {
      margin-top: 15px;
      color: #66c0f4;
      animation: pulse 2s infinite;
    }` : ''}
    body {
      text-align: center;
      background-color: rgb(28,36,45) !important;
      color: #c6d4df !important;
    }
    h1 { color: #e74c3c !important; }
  </style>
  ${statusCode === 429 ? `<script>
    window.onload = function() {
      let seconds = ${retrySeconds};
      const countdownEl = document.getElementById('countdown');
      const refreshMsg = document.getElementById('auto-refresh');
      if (!countdownEl) return;
      const timer = setInterval(function() {
        seconds--;
        countdownEl.textContent = seconds;
        if (seconds <= 0) {
          clearInterval(timer);
          if (refreshMsg) refreshMsg.textContent = "Refreshing now...";
        }
      }, 1000);
    };
  </script>` : ''}
</head>
<body>
  <h1>${title}</h1>
  <div class="error-code">Error ${statusCode}</div>
  <div class="message">${message}</div>
  ${statusCode === 429 ? `
  <div class="retry-timer">
    Retrying in <span id="countdown" class="countdown">${retrySeconds}</span> seconds
  </div>
  <div id="auto-refresh" class="auto-refresh">Page will refresh automatically</div>
  ` : ''}
  <div class="back-link"><a href="/">Return to homepage</a></div>
</body>
</html>`;
}

function redirectPage(destinationURL, hostname, analytics = '') {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Redirecting to Dotabuff</title>
  ${analytics}
  <meta http-equiv="refresh" content="1;url=${destinationURL}">
  <style>
    body { 
      font-family: Arial, sans-serif;
      margin: 40px auto;
      max-width: 700px;
      text-align: center;
      line-height: 1.6;
      background-color: rgb(28,36,45); /* New RGB background */
      color: #c6d4df;
    }
    .redirect-message { margin: 20px 0; font-size: 1.3em; }
    .manual-link { margin-top: 15px; }
    .manual-link a { color: #66c0f4; text-decoration: none; }
    .manual-link a:hover { text-decoration: underline; }
    .loader { 
      border: 5px solid #f3f3f3;
      border-top: 5px solid #3498db;
      border-radius: 50%;
      width: 40px;
      height: 40px;
      animation: spin 1s linear infinite;
      margin: 20px auto;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    a {
      color: #66c0f4;
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
  </style>
  <script>
    window.onload = function() {
      setTimeout(function() {
        window.location.href = "${destinationURL}";
      }, 1000);
    };
  </script>
</head>
<body>
  <div class="redirect-message">Redirecting you to Dotabuff profile...</div>
  <div class="loader"></div>
  <div class="manual-link">If not redirected automatically, <a href="${destinationURL}">click here</a>.</div>
</body>
</html>`;
}
