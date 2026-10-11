// Cloudflare Workers entry point. All request handling lives in src/core.js so
// the same code can also run under Node (see server.js). The recent-checks
// feed is a Node-only module, so on Workers env.FEED is undefined and the
// feature stays off.
import { handleRequest } from './src/core.js';

export { convertToDota2Id, getConfiguredApiKeys, parseRoute } from './src/core.js';
export { analyticsSnippet, resolveBanners } from './src/pages.js';

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  }
};
