// OpenNext's Cloudflare adapter (`npm run cf:build`). Prerendered pages (terms, privacy, robots.txt,
// sitemap.xml, the og:image) are served from the Worker's static assets: `populateCache local` in
// cf:build copies them there. Nothing here revalidates, so no KV or R2 cache is needed.
import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import staticAssetsIncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache';

export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
});
