// @ts-check
import { defineConfig, passthroughImageService } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://isbetter.ai',
  adapter: cloudflare({
    imageService: 'passthrough',
    // Serve public/_headers during `astro dev` too (CDN-friendly SITE_CSP).
    experimental: { headersAndRedirectsDevModeSupport: true },
  }),
  // No astro:assets transforms — skip sharp entirely.
  image: {
    service: passthroughImageService(),
  },
  // CSP: SITE_CSP via middleware + public/_headers. In-app previews load
  // /preview-frame over HTTP with its own PREVIEW_CSP (no parent inheritance).
  // Keep SITE_CSP a superset of demo sources for any remaining srcdoc/blob tabs.
  vite: {
    plugins: [tailwindcss()]
  }
});
