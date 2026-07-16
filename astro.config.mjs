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
  // srcdoc/blob preview iframes inherit the parent policy; hashed script/style
  // sources would block the demos' required inline JS/CSS. Preview documents
  // still enforce their own stricter PREVIEW_CSP (no network, etc.).
  vite: {
    plugins: [tailwindcss()]
  }
});
