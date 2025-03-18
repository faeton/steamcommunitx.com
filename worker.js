// Helper functions for API key management
function getAvailableApiKeys(env) {
  // First try to get from primary key
  const primaryKey = env.STEAM_API_KEY;
  
  // Then check for multi-key configuration
  const multiKeys = env.STEAM_API_KEYS ? env.STEAM_API_KEYS.split(',') : [];
  
  // Combine all available keys, with primary key first
  const allKeys = primaryKey ? [primaryKey, ...multiKeys] : multiKeys;
  
  // Remove duplicates if any
  return [...new Set(allKeys)].filter(key => key && key.trim() !== '');
}

// Helper to mask API key for logging (show only first 4 chars)
function maskApiKey(key) {
  if (!key) return 'undefined';
  return key.substring(0, 4) + '...' + key.slice(-4);
}

// Mark a key as problematic (invalid/unauthorized)
async function markProblemKey(env, key) {
  if (!env.API_KEY_STATUS) return;
  
  try {
    // Store for 24 hours
    await env.API_KEY_STATUS.put(`key:${key}:invalid`, 'true', { expirationTtl: 24 * 60 * 60 });
    console.log(`Marked key ${maskApiKey(key)} as problematic for 24 hours`);
  } catch (e) {
    console.error("Error marking problem key:", e);
  }
}

// Mark a key as rate-limited temporarily
async function markRateLimitedKey(env, key, retryAfter) {
  if (!env.API_KEY_STATUS) return;
  
  try {
    // Store for the retry period plus a small buffer
    const expirationSecs = Math.min(retryAfter + 30, 3600); // Max 1 hour
    await env.API_KEY_STATUS.put(`key:${key}:ratelimited`, 'true', { expirationTtl: expirationSecs });
    console.log(`Marked key ${maskApiKey(key)} as rate-limited for ${expirationSecs} seconds`);
  } catch (e) {
    console.error("Error marking rate-limited key:", e);
  }
}

// Mark a key as working
async function markWorkingKey(env, key) {
  if (!env.API_KEY_STATUS) return;
  
  try {
    // Remove any problem markers
    await env.API_KEY_STATUS.delete(`key:${key}:invalid`);
    await env.API_KEY_STATUS.delete(`key:${key}:ratelimited`);
    
    // Update last successful usage timestamp
    await env.API_KEY_STATUS.put(`key:${key}:lastSuccess`, Date.now().toString());
  } catch (e) {
    console.error("Error marking working key:", e);
  }
}// Steam favicon data URI (16x16 pixel steam icon) in base64 format
const FAVICON_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAAOwQAADsEBuJFr7QAAABh0RVh0U29mdHdhcmUAcGFpbnQubmV0IDQuMS40E0BoxAAAAi5JREFUOE+Nk11IU2EYx895z5xp5XTPkRZEaLSQRKIvg2BdjOqqusygi4igDxKCIKjQ6iYJvCgqoC4yCJVVRLYuKgJjRhIjknTZrJbbdOtnTve8x/ectzMbSREd+PG+7/Oe33/P4YwAgJXq+7L00tLGO5IktXs8HsXv93N0JG7bNlKpFGKxmDE3N7e7vq16JuobYSa7jBv5hH9IpVlZWbGDwaBcLBZFOI0LBoOSYzX9jeUQe+V2u+njPYVCQaGDMFEUuWg0yjnneNI/OQgrrA8pn5+f53a7jVIbE8bIssznYuOdnP3rXsP1UMkXicOKshSLxar5lfwQnx6wSQghaHVzc9MhgZJ1aGB8jx40Pmj/8K1nQdO0DKiZXQIpODo6Wp0XoSFd13VmGAY1MNbW1g5Isy9qVsLSLZLUQdp40DLgQXu329vbTSG1ShBDT7+7rl7Wh+TJcbbf1+YNXzQO+WBgwPuhrVB8Xry9P9nU1LQjSIqibE+n00J++OFgw+ztdX6fnfvt7+rlJ8N8crI7YVlWlCRCnQoC4P11a54f8l4oG7Ihi2VjyftLIhfh0+3HzlfMqNVqxQlXBcoUaPgpfT3+4nxDLPyyOWLJXR+fHu8M66YRJIIcwv8EbFVeWhvXwmeDnVHpTnBKGy1ySwQZRRgpCb5Pd+5/o6jLR3lc4T7a1mWiD5IBl8sFWZYhCALVxiZMJdlsljGhJEHXC0X+mIqJ7Krt1P8LI6/EBYk0I1UAAAAASUVORK5CYII=";

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};

const base = "https://www.dotabuff.com/";

// Multi-tiered rate limiting implementation with retry logic
async function checkRateLimit(env, ip, resource = 'steam_api') {
  // Skip rate limiting if KV is not available
  if (!env.RATE_LIMITS) return { limited: false };
  
  const now = Date.now();
  
  // Define multiple rate limit windows (adhering to Steam's undocumented limits)
  const windows = [
    { name: 'minute', size: 60 * 1000, maxRequests: 30 },  // 30 per minute (our own limit)
    { name: '5min', size: 5 * 60 * 1000, maxRequests: 180 }  // 180 per 5 minutes (~200 as mentioned)
  ];
  
  // Check all windows
  const results = await Promise.all(windows.map(async window => {
    const key = `ratelimit:${resource}:${ip}:${window.name}`;
    
    try {
      // Get current rate limit data
      let data = await env.RATE_LIMITS.get(key, { type: 'json' });
      
      if (!data) {
        data = { 
          count: 0, 
          reset: now + window.size,
          timestamps: [] // Store timestamps for rolling window if needed
        };
      }
      
      // Clean up old timestamps (keep only those within the window)
      if (data.timestamps) {
        data.timestamps = data.timestamps.filter(ts => (now - ts) < window.size);
      }
      
      // Reset if window expired
      if (now > data.reset) {
        data = { 
          count: 0, 
          reset: now + window.size,
          timestamps: []
        };
      }
      
      // Add current timestamp
      if (data.timestamps) {
        data.timestamps.push(now);
      }
      
      // Increment count
      data.count += 1;
      
      // Check if rate limited
      const limited = data.count > window.maxRequests;
      
      // Update KV storage - add a buffer to the expiration to ensure we don't lose data
      await env.RATE_LIMITS.put(key, JSON.stringify(data), { 
        expirationTtl: Math.ceil(window.size / 1000) * 2
      });
      
      return {
        windowName: window.name,
        limited,
        count: data.count,
        remaining: Math.max(0, window.maxRequests - data.count),
        reset: data.reset,
        retryAfter: Math.ceil((data.reset - now) / 1000)
      };
    } catch (error) {
      console.error(`Rate limit error for ${window.name}:`, error);
      return { windowName: window.name, limited: false }; // Fail open if KV has issues
    }
  }));
  
  // Find the most restrictive window that's limited
  const limitedWindow = results.find(r => r.limited);
  
  if (limitedWindow) {
    return {
      limited: true,
      windowName: limitedWindow.windowName,
      remaining: 0,
      reset: limitedWindow.reset,
      retryAfter: limitedWindow.retryAfter,
      // For debugging
      allWindows: results
    };
  }
  
  // Return the window with the least remaining capacity
  const mostRestrictive = results.reduce((prev, curr) => 
    (curr.remaining < prev.remaining) ? curr : prev
  );
  
  return {
    limited: false,
    windowName: mostRestrictive.windowName,
    remaining: mostRestrictive.remaining,
    reset: mostRestrictive.reset,
    retryAfter: 0,
    // For debugging
    allWindows: results
  };
}

async function getId(vanityUrl, env, clientIP) {
  // Try to get from cache first to avoid any API calls if possible
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
  
  // Check if we have API keys available
  const apiKeys = getAvailableApiKeys(env);
  if (!apiKeys || apiKeys.length === 0) {
    throw { status: 503, message: "Steam API service unavailable - No API keys configured" };
  }

  // Check our own rate limits
  const rateLimitCheck = await checkRateLimit(env, clientIP);
  if (rateLimitCheck.limited) {
    console.log(`Rate limited in ${rateLimitCheck.windowName} window. Retry after ${rateLimitCheck.retryAfter}s`);
    throw {
      status: 429,
      message: "Too Many Requests",
      retryAfter: rateLimitCheck.retryAfter,
      windowName: rateLimitCheck.windowName
    };
  }
  
  // Function to handle API request with retries and key rotation
  const fetchWithRetry = async (retries = 2, backoff = 1000, keyIndex = 0) => {
    if (keyIndex >= apiKeys.length) {
      // We've tried all keys, reset to first key but with increased backoff
      keyIndex = 0;
      backoff = backoff * 2;
    }
    
    const apiKey = apiKeys[keyIndex];
    const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${apiKey}&vanityurl=${normalizedVanity}`;
    
    console.log(`Trying API request with key index ${keyIndex}`);
    
    try {
      const response = await fetch(url, { 
        headers: { 
          "content-type": "application/json;charset=UTF-8",
          // Add a unique cache-buster if we're retrying with same key
          ...(retries < 2 && keyIndex === 0 ? {"Cache-Control": "no-cache"} : {})
        },
        cf: { cacheTtl: 3600 }
      });
      
      // Check for API key validity issues
      if (response.status === 401 || response.status === 403) {
        console.error(`API key ${maskApiKey(apiKey)} appears to be invalid (${response.status})`);
        // Mark this key as problematic
        await markProblemKey(env, apiKey);
        
        // Try next key if we have one
        if (keyIndex + 1 < apiKeys.length) {
          console.log(`Trying next API key (index ${keyIndex + 1})`);
          return fetchWithRetry(retries, backoff, keyIndex + 1);
        }
      }
      
      // Handle rate limiting
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '300');
        console.log(`Steam API rate limited with key ${maskApiKey(apiKey)}. Retry after ${retryAfter}s`);
        
        // Mark this key as rate-limited temporarily
        await markRateLimitedKey(env, apiKey, retryAfter);
        
        // Try next key if we have one
        if (keyIndex + 1 < apiKeys.length) {
          console.log(`Switching to next API key (index ${keyIndex + 1})`);
          return fetchWithRetry(retries, backoff, keyIndex + 1);
        }
        
        // No more keys, we need to wait or give up
        if (retries > 0) {
          const waitTime = Math.min(5000, retryAfter * 1000); // Wait max 5 seconds
          if (waitTime <= 5000) {
            console.log(`Waiting ${waitTime}ms before retry. Retries left: ${retries}`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return fetchWithRetry(retries - 1, backoff * 2, 0); // Start from first key again
          }
        }
        
        throw {
          status: 429,
          message: "All Steam API keys are rate limited",
          retryAfter: retryAfter
        };
      }
      
      // Other errors
      if (!response.ok) {
        throw new Error(`Steam API error: ${response.statusText} (${response.status})`);
      }

      const data = await response.json();
      
      // Check for success response
      if (data?.response?.success !== 1) {
        console.log(`API returned unsuccessful response: ${JSON.stringify(data.response)}`);
        throw new Error(`Steam API returned unsuccessful response: ${data?.response?.message || 'Unknown error'}`);
      }
      
      const steamId = data?.response?.steamid;
      
      if (!steamId) {
        console.log(`No Steam ID found for vanity URL: ${normalizedVanity}`);
        return null;
      }
      
      // Save to cache if we got a valid response
      if (env.STEAM_ID_CACHE) {
        try {
          // Cache for 30 days (1 month)
          const oneMonthInSeconds = 30 * 24 * 60 * 60;
          await env.STEAM_ID_CACHE.put(cacheKey, steamId, { expirationTtl: oneMonthInSeconds });
          console.log(`Cached ${normalizedVanity} -> ${steamId} for 30 days`);
        } catch (e) {
          console.error("Cache write error:", e);
        }
      }
      
      // This was a successful call, mark the key as working
      await markWorkingKey(env, apiKey);
      
      return steamId;
    } catch (error) {
      // If it's already our custom error object, just rethrow it
      if (error.status) throw error;
      
      console.error(`Error with API key ${maskApiKey(apiKey)}:`, error.message);
      
      // Try next key if available
      if (keyIndex + 1 < apiKeys.length) {
        console.log(`Trying next API key (index ${keyIndex + 1}) after error`);
        return fetchWithRetry(retries, backoff, keyIndex + 1);
      }
      
      // For other errors, retry if we have retries left
      if (retries > 0) {
        console.log(`General error, retrying. Retries left: ${retries}`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        return fetchWithRetry(retries - 1, backoff * 2, 0); // Start from first key again
      }
      
      // If no retries left, wrap in a 500 error
      throw { status: 500, message: "Failed to fetch Steam ID after multiple attempts" };
    }
  };
  
  // Start the fetch process with retries
  return fetchWithRetry();
}

function convertToDota2Id(steamId) {
  // Clean the input first - remove any trailing slashes or whitespace
  const cleanId = steamId.trim();
  
  // Handle SteamID3 format [U:1:XXXXX]
  if (/^\[U:1:\d+\]$/.test(cleanId)) {
    const match = cleanId.match(/\[U:1:(\d+)\]/);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  // Handle SteamID64 format (17 digits)
  if (/^\d{17}$/.test(cleanId)) {
    try {
      return (BigInt(cleanId) - BigInt("76561197960265728")).toString();
    } catch (e) {
      console.error(`Error converting SteamID64: ${cleanId}`, e);
      return null;
    }
  }
  
  // Handle raw SteamID3 format without brackets (e.g., U:1:XXXXX)
  const rawSteamId3Match = cleanId.match(/^U:1:(\d+)$/i);
  if (rawSteamId3Match && rawSteamId3Match[1]) {
    return rawSteamId3Match[1];
  }
  
  // Log failure for debugging
  console.error(`Failed to convert Steam ID: ${steamId} (cleaned: ${cleanId})`);
  return null;
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const { pathname, hostname } = url;
  
  // Handle favicon.ico requests
  if (pathname === '/favicon.ico') {
    return handleFavicon();
  }
  
  // Get client IP for rate limiting
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

  if (pathname === '/') {
    return new Response(indexPage(hostname), { 
      status: 200, 
      headers: { 'Content-Type': 'text/html', 'Cache-Control': 'max-age=3600' } 
    });
  }

  // Improved path parsing - strip trailing slashes and split
  const cleanPath = pathname.replace(/\/+$/, '');
  let [, linktype, ...rest] = cleanPath.split('/');
  let linkid = rest.join('/'); // Join back any parts that might contain slashes (like for Steam ID3 format)
  
  if (!linktype || !linkid) {
    return Response.redirect(base, 301);
  }

  try {
    // Handle the case where the URL could have encoded brackets
    linkid = decodeURIComponent(linkid);
    
    if (linktype === 'id') {
      linkid = await getId(linkid, env, clientIP);
      if (!linkid) {
        return new Response(
          errorPage(hostname, 404, "Profile Not Found", "We could not find a valid Steam ID for the provided URL."), 
          { status: 404, headers: { 'Content-Type': 'text/html' } }
        );
      }
    }

    if (linktype === 'profiles') {
      linkid = convertToDota2Id(linkid);
      if (!linkid) {
        console.error(`Failed to convert Steam ID: ${rest.join('/')}`);
      }
    }

    if (!linkid) {
      return new Response(
        errorPage(hostname, 404, "Profile Not Found", "Invalid or unsupported Steam ID format."), 
        { status: 404, headers: { 'Content-Type': 'text/html' } }
      );
    }

    const destinationURL = `${base}players/${linkid}`;
    return new Response(
      redirectPage(destinationURL, hostname), 
      { 
        status: 200, 
        headers: { 
          'Content-Type': 'text/html',
          'Cache-Control': 'max-age=300' // Cache redirects for 5 minutes
        } 
      }
    );
  } catch (error) {
    console.error("Request handling error:", error);
    
    // Handle specific error types
    if (error.status === 429) {
      return new Response(
        errorPage(
          hostname, 
          429, 
          "Rate Limit Exceeded", 
          `We're receiving too many requests. Please try again in ${error.retryAfter || 60} seconds.`
        ), 
        { 
          status: 429, 
          headers: { 
            'Content-Type': 'text/html',
            'Retry-After': String(error.retryAfter || 60)
          } 
        }
      );
    }
    
    // Default error handling
    return new Response(
      errorPage(
        hostname, 
        error.status || 500, 
        error.message || "Server Error", 
        "Something went wrong processing your request. Please try again later."
      ), 
      { 
        status: error.status || 500, 
        headers: { 'Content-Type': 'text/html' } 
      }
    );
  }
}

// Handle favicon.ico requests
function handleFavicon() {
  // Convert base64 to binary
  const binaryString = atob(FAVICON_BASE64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  // Return the favicon with appropriate headers
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'image/x-icon',
      'Cache-Control': 'public, max-age=86400' // Cache for 24 hours
    }
  });
}

// Common CSS to be reused across pages
function getCommonStyles() {
  return `
    body { 
      font-family: Arial, sans-serif; 
      margin: 40px auto; 
      max-width: 700px; 
      line-height: 1.6;
      background-color: #171a21;
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

function googleAnalyticsCode() {
  return `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-5ZTR404EG7"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-5ZTR404EG7');
</script>`;
}

function indexPage(hostname) {
  const host = hostname.split('/')[0];
  
  return `<!DOCTYPE html>
<html>
<head>
  <title>Steam to Dotabuff Redirector</title>
  ${googleAnalyticsCode()}
  <style>
    ${getCommonStyles()}
    .info { 
      background: #2a3f5f; 
      padding: 15px; 
      border-radius: 5px; 
      margin: 20px 0;
    }
    .url-example {
      font-family: monospace;
      background: #32496d;
      padding: 4px 8px;
      border-radius: 3px;
      display: inline-block;
    }
    .change-to {
      text-align: center;
      font-size: 14px;
      margin: 10px 0;
      color: #8f98a0;
      font-weight: bold;
    }
  </style>
</head>
<body>
  <h1>Steam to Dotabuff Redirector</h1>
  <p>Easily convert Steam profile URLs into Dotabuff player profiles with a simple URL change.</p>
  
  <div class="info">
    <p><strong>How to use:</strong></p>
    <div>
      <span class="url-example">steamcommunity.com/id/username</span>
      <div class="change-to">CHANGE TO:</div>
      <span class="url-example">${host}/id/username</span>
    </div>
    <br>
    <p><strong>Also works with Steam ID formats:</strong></p>
    <div>
      <span class="url-example">steamcommunity.com/profiles/76561198123456789</span>
      <div class="change-to">CHANGE TO:</div>
      <span class="url-example">${host}/profiles/76561198123456789</span>
    </div>
    <br>
    <p><strong>And SteamID3 format:</strong></p>
    <div>
      <span class="url-example">steamcommunity.com/profiles/[U:1:123456789]</span>
      <div class="change-to">CHANGE TO:</div>
      <span class="url-example">${host}/profiles/[U:1:123456789]</span>
    </div>
  </div>
  
  <p>Developed by <a href="https://github.com/faeton" target="_blank">GitHub/faeton</a></p>
</body>
</html>`;
}



function errorPage(hostname, statusCode, title, message) {
  // Auto-refresh for rate limiting errors
  const autoRefresh = statusCode === 429 
    ? `<meta http-equiv="refresh" content="${Math.min(30, parseInt(message.match(/(\d+) seconds/) || [0, 30])[1])};url=${new URL(hostname).origin + '/id/' + hostname.split('/').pop()}">`
    : '';
  
  return `<!DOCTYPE html>
<html>
<head>
  <title>${title} - Steam to Dotabuff</title>
  ${googleAnalyticsCode()}
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
    
    /* Only show countdown for rate limit errors */
    ${statusCode === 429 ? `.countdown { 
      display: inline-block;
      padding: 5px 15px;
      background: #32496d;
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
    
    /* Force dark background with !important */
    body {
      text-align: center;
      background-color: #171a21 !important;
      color: #c6d4df !important;
    }
    h1 { color: #e74c3c !important; }
  </style>
  ${statusCode === 429 ? `<script>
    // Countdown timer for rate limited requests
    window.onload = function() {
      const match = "${message}".match(/(\\d+) seconds/);
      if (!match) return;
      
      let seconds = parseInt(match[1]);
      const countdownEl = document.getElementById('countdown');
      const refreshMsg = document.getElementById('auto-refresh');
      
      if (!countdownEl) return;
      
      const timer = setInterval(function() {
        seconds--;
        countdownEl.textContent = seconds;
        
        if (seconds <= 0) {
          clearInterval(timer);
          refreshMsg.textContent = "Refreshing now...";
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
    Retrying in <span id="countdown" class="countdown">${parseInt(message.match(/(\d+) seconds/) || [0, 30])[1]}</span> seconds
  </div>
  <div id="auto-refresh" class="auto-refresh">Page will refresh automatically</div>
  ` : ''}
  
  <div class="back-link"><a href="/">Return to homepage</a></div>
</body>
</html>`;
}

function redirectPage(destinationURL, hostname) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Redirecting to Dotabuff</title>
  ${googleAnalyticsCode()}
  <meta http-equiv="refresh" content="1;url=${destinationURL}">
  <style>
    body { font-family: Arial, sans-serif; margin: 40px auto; max-width: 700px; text-align: center; line-height: 1.6; }
    .redirect-message { margin: 20px 0; }
    .manual-link { margin-top: 15px; }
    .manual-link a { color: #1976d2; text-decoration: none; }
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
