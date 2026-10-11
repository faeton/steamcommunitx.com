import { t, ago, avatarUrl } from './client/feed-shared.js';

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// One-line teaser on the redirect interstitial. Rendered server-side so it is
// visible on the first frame of a 1-second page.
export function renderTeaser(teaser, lang = 'en', now = Date.now()) {
  if (!teaser) return '';
  let text;
  let faces = '';
  if (teaser.seen) {
    const key = teaser.seen.count > 1 ? 'teaserSeenMany' : 'teaserSeenOnce';
    text = t(lang, key, { ago: ago(lang, teaser.seen.lastTs, now), count: teaser.seen.count });
  } else if (teaser.hourCount > 0) {
    text = t(lang, 'teaserHour', { n: teaser.hourCount });
    faces = (teaser.faces || []).map(avatarUrl).filter(Boolean).slice(0, 3)
      .map(src => `<img src="${src}" alt="" width="20" height="20">`).join('');
  } else {
    return '';
  }
  return `<a class="teaser" id="teaser" href="/">${faces ? `<span class="faces">${faces}</span>` : ''}<span>${escapeHtml(text)}</span></a>`;
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


const FEED_SECTION = `
    <section class="fd" id="feed-section" aria-label="Recently checked players" hidden>
      <div class="fd-head">
        <h2 data-i18n="feedTitle">Recently checked</h2>
      </div>
      <div class="fd-search">
        <input id="feed-q" type="search" autocomplete="off" spellcheck="false" aria-label="Filter by nickname">
        <span class="fd-hits" id="feed-hits" aria-live="polite"></span>
      </div>
      <div class="fd-box" id="feed">
        <div class="fd-top">
          <span class="fd-live"><i></i><span id="feed-live" data-i18n="live">Live</span></span>
          <span class="fd-count" id="feed-count"></span>
        </div>
        <button class="fd-pill" id="feed-pill" type="button"><span id="feed-pill-text"></span><span class="fd-bar" id="feed-bar"></span></button>
        <div class="fd-list" id="feed-list" tabindex="0" aria-label="Recently checked players"></div>
      </div>
    </section>`;

const FEED_CSS = `
    .fd { margin-bottom: 40px; }
    .fd-head h2 { margin: 0 0 12px; font-size: 1rem; color: var(--accent); letter-spacing: 0.04em; text-transform: uppercase; }
    .fd-search { display: flex; gap: 10px; margin-bottom: 12px; align-items: center; }
    .fd-search input {
      flex: 1; min-width: 0; font: inherit; font-size: 15px; color: var(--text); background: var(--surface);
      border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; outline: none;
    }
    .fd-search input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(102,192,244,0.18); }
    .fd-hits { color: var(--muted); font-size: 13px; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .fd-box { position: relative; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    .fd-top { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--border); font-size: 13px; color: var(--muted); }
    .fd-live { display: inline-flex; align-items: center; gap: 7px; color: var(--text); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; font-size: 12px; }
    .fd-live i { width: 8px; height: 8px; border-radius: 50%; background: #e5484d; }
    .fd-box.paused .fd-live i { background: var(--gold); }
    .fd-count { font-variant-numeric: tabular-nums; }
    .fd-list { height: 392px; overflow-y: auto; overscroll-behavior: contain; background: var(--bg); scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
    .fd-blk { position: sticky; top: 0; z-index: 1; padding: 6px 16px; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--muted); background: var(--bg-2); }
    .fd-list.fd-multi { display: grid; grid-template-columns: repeat(var(--cols, 1), minmax(0, 1fr)); align-items: start; }
    .fd-col { min-width: 0; }
    .fd-multi .fd-col + .fd-col { border-left: 1px solid var(--border); }
    .fd-row { height: 56px; display: flex; align-items: center; gap: 12px; padding: 0 16px; overflow: hidden; }
    .fd-multi .fd-row { gap: 10px; padding: 0 12px; }
    .fd-row + .fd-row { border-top: 1px solid rgba(42,56,72,0.55); }
    .fd-row:hover { background: rgba(102,192,244,0.05); }
    .fd-row[hidden] { display: none; }
    .fd-row.fd-pinned { animation: fd-flash 1.6s ease-out; }
    .fd-avw { position: relative; width: 36px; height: 36px; flex: none; }
    .fd-av { width: 36px; height: 36px; border-radius: 8px; display: block; background: var(--surface-2); object-fit: cover; }
    .fd-lock {
      position: absolute; right: -4px; bottom: -4px; width: 16px; height: 16px; border-radius: 50%;
      display: grid; place-items: center; background: var(--surface-2); border: 2px solid var(--bg); color: var(--muted);
    }
    .fd-lock svg { width: 8px; height: 8px; display: block; }
    .fd-who { flex: 1; min-width: 0; }
    .fd-nick { display: flex; align-items: center; min-width: 0; font-weight: 600; font-size: 15px; }
    .fd-name { min-width: 0; max-width: 18em; overflow: hidden; white-space: nowrap; unicode-bidi: isolate; }
    /* Long nicknames fade out instead of stretching the column or ending in "…". */
    .fd-name.fd-fade {
      -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
      mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
    }
    .fd-nick mark, .fd-flap.fd-hl { background: rgba(102,192,244,0.25); color: var(--text); border-radius: 3px; }
    .fd-meta { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .fd-x { font-size: 11px; font-weight: 700; color: var(--gold); background: rgba(245,196,81,0.12); border-radius: 6px; padding: 1px 6px; margin-left: 6px; flex: none; }
    /* Small "D" tile linking to Dotabuff: fits even three columns. */
    .fd-go {
      flex: none; width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center;
      background: rgba(102,192,244,0.1); border: 1px solid rgba(102,192,244,0.3); color: var(--accent);
      font-size: 13px; font-weight: 800; line-height: 1; text-decoration: none;
    }
    .fd-go:hover, .fd-go:focus-visible { background: var(--accent); border-color: var(--accent); color: var(--bg); text-decoration: none; }
    .fd-empty { padding: 24px 16px; color: var(--muted); text-align: center; font-size: 14px; }
    .fd-flap { display: inline-block; position: relative; white-space: pre; }
    .fd-flap.spin { clip-path: inset(0); } /* random glyphs stay inside their cell; unlike overflow, keeps the baseline */
    .fd-flap.spin .fd-g { visibility: hidden; }
    .fd-spin { position: absolute; left: 50%; top: 0; transform: translateX(-50%); color: var(--accent); }
    .fd-flip { animation: fd-flip .45s cubic-bezier(.3,1.4,.5,1); transform-origin: top; }
    @keyframes fd-flip { from { transform: rotateX(-90deg); } to { transform: rotateX(0); } }
    @keyframes fd-flash { from { background: rgba(245,196,81,0.2); } to { background: transparent; } }
    .fd-pill {
      position: absolute; left: 50%; top: 48px; transform: translate(-50%, -8px); opacity: 0; pointer-events: none; z-index: 3;
      background: var(--surface-2); border: 1px solid #3b5068; color: var(--text); border-radius: 999px;
      padding: 7px 14px 9px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap;
      box-shadow: 0 6px 20px rgba(0,0,0,0.4); transition: opacity .18s, transform .18s; overflow: hidden;
    }
    .fd-box.paused .fd-pill { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
    .fd-bar { position: absolute; left: 0; bottom: 0; height: 2px; width: 100%; background: var(--accent); transform-origin: left; }
    @media (prefers-reduced-motion: reduce) { .fd-flip, .fd-row.fd-pinned { animation: none; } .fd-pill { transition: none; } }
    @media (max-width: 480px) { .fd-list { height: 336px; } }`;

export function indexPage(hostname, analytics = '', opts = {}) {
  const feed = Boolean(opts.feed);
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
      --gold: #f5c451;
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
    }${feed ? FEED_CSS : ''}
  </style>
</head>
<body>
  <div class="wrap">
    <header class="hero">
      <span class="pill">Steam → Dotabuff</span>
      <h1>One-line redirect to <span class="accent">Dotabuff</span></h1>
      <p class="tagline">Swap <code style="color:var(--accent)">steamcommunity.com</code> for <code style="color:var(--accent)">${host}</code> in any Steam profile URL — get sent straight to the matching Dotabuff page.</p>
    </header>
${feed ? FEED_SECTION : ''}

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
${feed ? '  <script type="module" src="/assets/feed.js"></script>\n' : ''}</body>
</html>`;
}

export function errorPage(hostname, statusCode, title, message, analytics = '') {
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

// The interstitial banner is configured entirely through the BANNERS secret: a
// JSON array of { src, height, label? }, one entry picked at random per render.
// Nothing is embedded when the secret is absent, so no deployment's embed URLs
// live in this repo.
// Strict format guards, as with the analytics vars: these values land inside an
// HTML attribute and a JS string literal, so no quotes, backslashes or angle
// brackets may get through.
const BANNER_SRC_RE = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[A-Za-z0-9._~\-/]*$/;
const BANNER_LABEL_RE = /^[A-Za-z0-9 .,!?':()-]{1,120}$/;

// Show the banner at most once per hour per visitor.
const BANNER_DELAY_SECONDS = 5;      // wait while the banner is shown
const QUICK_REDIRECT_SECONDS = 1;    // wait when the banner is skipped
const BANNER_WINDOW_MS = 60 * 60 * 1000; // once-per-hour window

export function resolveBanners(env) {
  if (!env?.BANNERS) return [];
  let parsed;
  try {
    parsed = JSON.parse(env.BANNERS);
  } catch (e) {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // Entries failing the guards are dropped; an empty result means "no banner",
  // and the redirect page renders without an embed.
  return parsed.reduce((list, entry) => {
    const height = Number(entry?.height);
    if (!entry || typeof entry.src !== 'string' || !BANNER_SRC_RE.test(entry.src)
        || !Number.isFinite(height) || height <= 1 || height > 1000) {
      return list;
    }
    const banner = { src: entry.src, height: Math.round(height) };
    if (typeof entry.label === 'string' && BANNER_LABEL_RE.test(entry.label)) {
      banner.label = entry.label;
    }
    list.push(banner);
    return list;
  }, []);
}

export function redirectPage(destinationURL, hostname, analytics = '', banners = [], opts = {}) {
  const teaserHtml = renderTeaser(opts.teaser, opts.lang || 'en');
  const banner = banners.length ? banners[Math.floor(Math.random() * banners.length)] : null;
  const delaySeconds = banner ? BANNER_DELAY_SECONDS : QUICK_REDIRECT_SECONDS;
  const caption = banner && banner.label
    ? banner.label
    : "While you wait, here's your live ping to the <strong>Dota 2</strong> servers.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Redirecting to Dotabuff</title>
  ${analytics}
  <noscript><meta http-equiv="refresh" content="${delaySeconds};url=${destinationURL}"></noscript>
  <style>
    :root {
      --bg: #0f1620;
      --bg-2: #182230;
      --surface: #1c2530;
      --border: #2a3848;
      --text: #e6edf3;
      --muted: #8b9bac;
      --accent: #66c0f4;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background:
        radial-gradient(ellipse at top, rgba(102,192,244,0.08), transparent 60%),
        var(--bg);
      color: var(--text);
      line-height: 1.6;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      width: 100%;
      max-width: 600px;
      text-align: center;
    }
    .redirect-message { font-size: 1.4rem; font-weight: 600; margin: 0 0 6px; }
    .sub {
      color: var(--muted);
      font-size: 0.95rem;
      margin: 0 0 24px;
    }
    .sub strong { color: var(--accent); font-weight: 600; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .manual-link { margin-top: 20px; font-size: 0.9rem; color: var(--muted); }
    .teaser {
      display: inline-flex; align-items: center; gap: 10px;
      margin: 4px auto 18px; padding: 8px 16px; border-radius: 999px;
      background: rgba(102,192,244,0.1); border: 1px solid rgba(102,192,244,0.3);
      color: var(--text); font-size: 0.92rem; font-weight: 500;
      animation: teaser-in .35s ease-out both;
    }
    .teaser:hover { border-color: var(--accent); text-decoration: none; }
    .teaser .faces { display: inline-flex; }
    .teaser .faces img { width: 20px; height: 20px; border-radius: 6px; border: 2px solid var(--bg); margin-left: -6px; }
    .teaser .faces img:first-child { margin-left: 0; }
    html.show-banner .teaser { animation: none; }
    @keyframes teaser-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .teaser { animation: none; } }${banner ? `
    /* Banner is hidden until JS decides this visitor is due for it (once/hour). */
    .banner-wrap { display: none; }
    html.show-banner .banner-wrap { display: block; }
    .banner-embed {
      width: 600px;
      max-width: 100%;
      height: ${banner.height}px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--surface);
      display: block;
      margin: 0 auto;
    }
    .bar {
      height: 4px;
      width: 100%;
      max-width: 600px;
      margin: 20px auto 0;
      background: var(--bg-2);
      border-radius: 999px;
      overflow: hidden;
    }
    .bar > span {
      display: block;
      height: 100%;
      width: 0;
      background: var(--accent);
      animation: fill ${BANNER_DELAY_SECONDS}s linear forwards;
    }
    @keyframes fill { from { width: 0; } to { width: 100%; } }` : ''}
  </style>
  <script>
    (function() {
      var DEST = "${destinationURL}";
      var QUICK_MS = ${QUICK_REDIRECT_SECONDS * 1000};
      function go() { window.location.replace(DEST); }
      var timer = null;
      function later(ms) { timer = setTimeout(go, ms); }
      // The teaser links to the home page; clicking it must cancel the redirect.
      document.addEventListener("click", function(e) {
        if (e.target.closest && e.target.closest("#teaser")) clearTimeout(timer);
      });
${banner ? `      var KEY = "ping_shown_at";
      var WINDOW_MS = ${BANNER_WINDOW_MS};
      var BANNER_MS = ${BANNER_DELAY_SECONDS * 1000};
      // Read/write both localStorage and a cookie — the Dota in-game (CEF)
      // browser may have localStorage disabled but still keeps cookies.
      function readShown() {
        try { var v = parseInt(localStorage.getItem(KEY), 10); if (v) return v; } catch (e) {}
        var m = document.cookie.match(/(?:^|;\\s*)ping_shown=(\\d+)/);
        return m ? parseInt(m[1], 10) : 0;
      }
      function writeShown(t) {
        try { localStorage.setItem(KEY, String(t)); } catch (e) {}
        document.cookie = "ping_shown=" + t + ";path=/;max-age=" + (WINDOW_MS / 1000) + ";SameSite=Lax";
      }
      if (Date.now() - readShown() < WINDOW_MS) {
        // Banner already shown this hour — quick redirect, no iframe loaded.
        later(QUICK_MS);
        return;
      }
      writeShown(Date.now());
      document.documentElement.className += " show-banner";
      document.addEventListener("DOMContentLoaded", function() {
        var f = document.getElementById("banner");
        if (f) f.src = f.getAttribute("data-src");
      });
      later(BANNER_MS);` : `      later(QUICK_MS);`}
    })();
  </script>
</head>
<body>
  <div class="card">
    <p class="redirect-message">Taking you to the Dotabuff profile…</p>
    ${teaserHtml}${banner ? `
    <div class="banner-wrap">
      <p class="sub">${caption}</p>
      <iframe id="banner" class="banner-embed" data-src="${banner.src}" title="Live Dota 2 server ping" loading="eager" referrerpolicy="no-referrer"></iframe>
      <div class="bar"><span></span></div>
    </div>` : ''}
    <div class="manual-link">Not redirected? <a href="${destinationURL}">Click here</a>.</div>
  </div>
</body>
</html>`;
}
