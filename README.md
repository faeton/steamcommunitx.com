# Steam to Dotabuff Redirector

## Overview
This Cloudflare Worker-based service allows users to convert Steam Vanity URLs and SteamID-based profile URLs into Dotabuff player profile links. It automatically handles Steam Vanity URLs by resolving them through the Steam API and processes SteamID64 and Steam3 formats locally without API calls.

## Features
- **Supports Steam Vanity URLs** (e.g., `steamcommunity.com/id/gabelogannewell` → API resolution required)
- **Handles SteamID-based URLs locally** (e.g., `steamcommunity.com/profiles/76561197960287930` → converted without API)
- **Automatic Redirects** to Dotabuff player profiles
- **Google Analytics Integration** (ensuring tracking before redirection)
- **Cloudflare Workers Optimization**
- **Secure API Key Handling** using Cloudflare Worker Secrets

## How It Works
1. **Vanity URLs**: If a user enters a Steam Vanity URL (`/id/{username}`), the service queries the Steam API to resolve the corresponding SteamID64.
2. **SteamID64 URLs**: If a user enters a `/profiles/{SteamID64}`, the system locally converts it to a Dota 2 Player ID.
3. **Steam3 IDs**: If the URL contains a Steam3 ID format (e.g., `[U:1:22202]`), it is converted directly without API usage.
4. **Google Analytics**: The redirect page ensures Google Analytics tracking before sending the user to Dotabuff.

## URL Usage
- **Vanity Name URL:** `https://steamcommunitx.com/id/{username}` (Requires API resolution)
- **SteamID64 URL:** `https://steamcommunitx.com/profiles/{steamID64}` (Converted locally)
- **Steam3 ID URL:** `https://steamcommunitx.com/profiles/[U:1:{dotaID}]` (Converted locally)

All formats redirect to Dotabuff:
```
https://www.dotabuff.com/players/{dotaID}
```

## Setup & Deployment
### 1. Deploy to Cloudflare Workers
- Clone the repository and navigate to the project folder.
- Deploy the worker using Cloudflare’s dashboard or Wrangler CLI.

### 2. Set Up API Key as a Secret
- Go to Cloudflare Dashboard → Workers & Pages → Select Your Worker
- Navigate to **Settings** → **Variables and Secrets**
- Add a **Secret**:
  - **Name:** `STEAM_API_KEY`
  - **Value:** *Your Steam API Key*

### 3. Bind Custom Domain (Optional)
To use a custom domain like `steamcommunitx.com`, configure Cloudflare DNS settings and map the domain to the worker.

## Code Breakdown
### Key Files:
- **`index.js`**: The main Cloudflare Worker script that handles requests, processes Steam IDs, and redirects.
- **`README.md`**: This documentation.

### Optimized Redirect Logic
- Uses `window.onload` to ensure all tracking scripts load before redirecting.
- Redirects both SteamID-based URLs and Vanity URLs to Dotabuff.
- Implements proper error handling for missing API keys and invalid Steam IDs.

## Contributing
Feel free to submit pull requests for improvements, bug fixes, or additional features.

## License
MIT License.

