// @ts-check
import { defineConfig, passthroughImageService } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://isbetter.ai',
  adapter: cloudflare({ imageService: 'passthrough' }),
  // No astro:assets transforms — skip sharp entirely.
  image: {
    service: passthroughImageService(),
  },
  // CSP is delivered via public/_headers (HTTP), not Astro's meta CSP.
  // srcdoc/blob preview iframes inherit + intersect the parent policy, so the
  // header CSP must allow demo CDN/inline sources; hashed script/style would
  // block them. Preview documents still add PREVIEW_CSP (forms/frames locked).
  vite: {
    plugins: [tailwindcss()]
  }
});
