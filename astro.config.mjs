// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

import tailwindcss from '@tailwindcss/vite';

const inferenceApiOrigins = [
  'https://openrouter.ai',
  'https://api.openai.com',
  'https://api.anthropic.com',
  'https://generativelanguage.googleapis.com',
  'https://api.x.ai',
  'https://api.deepseek.com',
  'https://api.mistral.ai',
  'https://api.groq.com',
  'https://api.cerebras.ai',
  'http://localhost:*',
  'http://127.0.0.1:*',
];

// https://astro.build/config
export default defineConfig({
  site: 'https://isbetter.ai',
  adapter: cloudflare(),
  security: {
    csp: {
      algorithm: 'SHA-512',
      // Delivered via <meta>. Keep frame-ancestors (and other header-only
      // directives) in public/_headers — browsers ignore them in meta CSP.
      directives: [
        "default-src 'self'",
        "base-uri 'none'",
        `connect-src 'self' ${inferenceApiOrigins.join(' ')}`,
        "font-src 'self' data:",
        "form-action 'self'",
        "frame-src 'self' blob:",
        "img-src 'self' data: blob:",
        "manifest-src 'self'",
        "media-src 'self' data: blob:",
        "object-src 'none'",
        "worker-src 'none'",
      ],
      // Runtime style="" / element.style (badges, charts) cannot be hashed.
      // Scope unsafe-inline to attributes only; <style> tags stay hashed.
      styleDirective: {
        resources: [{ resource: "'unsafe-inline'", kind: 'attribute' }],
      },
    },
  },
  vite: {
    plugins: [tailwindcss()]
  }
});