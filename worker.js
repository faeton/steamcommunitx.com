export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};

const base = "https://www.dotabuff.com/";

async function getId(vanityUrl, env) {
  const apiKey = env.STEAM_API_KEY;
  if (!apiKey) {
    throw new Error("STEAM_API_KEY is missing.");
  }

  const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${apiKey}&vanityurl=${vanityUrl}`;

  try {
    const response = await fetch(url, { headers: { "content-type": "application/json;charset=UTF-8" } });
    if (!response.ok) throw new Error(`Steam API error: ${response.statusText}`);

    const data = await response.json();
    return data?.response?.steamid || null;
  } catch (error) {
    console.error("Error fetching Steam ID:", error);
    return null;
  }
}

function convertToDota2Id(steamId) {
  if (/^\[U:1:\d+\]$/.test(steamId)) {
    return steamId.match(/\[U:1:(\d+)\]/)[1];
  }
  if (/^\d{17}$/.test(steamId)) {
    return (BigInt(steamId) - BigInt("76561197960265728")).toString();
  }
  return null;
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const { pathname, hostname } = url;

  if (pathname === '/') {
    return new Response(indexPage(hostname), { status: 200, headers: { 'Content-Type': 'text/html' } });
  }

  let [, linktype, linkid] = pathname.split('/');
  if (!linktype || !linkid) return Response.redirect(base, 301);

  if (linktype === 'id') {
    linkid = await getId(linkid, env);
    if (!linkid) return new Response(errorPage(hostname), { status: 404, headers: { 'Content-Type': 'text/html' } });
  }

  if (linktype === 'profiles') {
    linkid = convertToDota2Id(linkid);
  }

  if (!linkid) return new Response(errorPage(hostname), { status: 404, headers: { 'Content-Type': 'text/html' } });

  const destinationURL = `${base}players/${linkid}`;
  return new Response(redirectPage(destinationURL, hostname), { status: 200, headers: { 'Content-Type': 'text/html' } });
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
  return `<!DOCTYPE html>
<html>
<head>
  <title>Steam to Dotabuff Redirector</title>
  ${googleAnalyticsCode()}
  <style>
    body { font-family: Arial, sans-serif; margin: 40px auto; max-width: 700px; }
    h1 { color: #444; }
  </style>
</head>
<body>
  <h1>Steam to Dotabuff Redirector</h1>
  <p>Easily convert Steam Vanity URLs into Dotabuff player profiles.</p>
  <p>Use this service by changing your Steam profile link from <code>steamcommunity.com/id/user</code> to <code>${hostname}/id/user</code>,
     and you'll be redirected to the corresponding Dotabuff profile instantly.</p>
  <p>Developed by <a href="https://github.com/faeton">GitHub/faeton</a>.</p>
</body>
</html>`;
}

function errorPage(hostname) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Profile Not Found</title>
  ${googleAnalyticsCode()}
</head>
<body>
  <h1>Profile Not Found</h1>
  <p>We could not find a valid Steam ID for the provided URL.</p>
  <p><a href="/">Return to homepage</a></p>
</body>
</html>`;
}

function redirectPage(destinationURL, hostname) {
  return `<!DOCTYPE html>
<html>
<head>
  <title>Redirecting...</title>
  ${googleAnalyticsCode()}
  <script>
    window.onload = function() {
      window.location.href = "${destinationURL}";
    };
  </script>
</head>
<body>
  <p>Redirecting you to Dotabuff profile...</p>
  <p>If not redirected automatically, <a href="${destinationURL}">click here</a>.</p>
</body>
</html>`;
}
