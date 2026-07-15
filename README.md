# ⚔️ isbetter.ai

**Compare AI models. Side by side.**

Give every model the same prompt and compare the answer, the generated code, a live preview, speed, tokens and cost — all streaming in real time, right in your browser.

**Live at [isbetter.ai](https://isbetter.ai)**

## Features

- **Side-by-side battles** — run one prompt against up to 6 models at once and watch every answer stream in.
- **Three views per result** — the raw **output**, the extracted **code**, and a sandboxed **live preview** of what the model built.
- **Blind mode** — hide and shuffle model identities so you judge the output, not the logo. Reveal whenever you're ready.
- **Battle metrics** — total time, time to first token, generation speed, tokens and estimated cost, with a timeline chart and per-metric winners.
- **Shareable battles** — publish a battle and send a link so anyone can review the results.
- **Local history** — every battle is saved in your browser so you can revisit or re-run it later.
- **Bring your own keys** — API keys are stored in `localStorage` and sent only to their provider. They never touch our servers.

## Supported providers

| Provider | Notes |
| --- | --- |
| OpenRouter | Hundreds of models from every major lab through one key |
| OpenAI | GPT models |
| Anthropic | Claude models |
| Google Gemini | Gemini models |
| xAI | Grok models |
| DeepSeek | DeepSeek chat and reasoner models |
| Mistral AI | Mistral models |
| Groq | Ultra-fast open-model inference |
| Cerebras | Ultra-fast open-model inference |
| Local | Any OpenAI-compatible server (Ollama, LM Studio, llama.cpp, …) |

Models served through an inference provider (OpenRouter, Groq, Cerebras, local) also show the badge of the lab that created the model.

## Tech stack

- [Astro](https://astro.build) with server routes on [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Tailwind CSS 4](https://tailwindcss.com) for styling
- [Cloudflare D1](https://developers.cloudflare.com/d1/) for shared battles
- [Vitest](https://vitest.dev) for unit tests
- Streaming responses over SSE with a per-provider registry (`src/scripts/providers/`)

## Getting started

Requirements: **Node.js ≥ 22.12** and [pnpm](https://pnpm.io).

```sh
git clone https://github.com/midudev/ai-battle.git
cd ai-battle
pnpm install
pnpm dev
```

Open `http://localhost:4321`, press <kbd>K</kbd> to add at least one provider API key, pick your contenders and run a battle.

### Commands

| Command | Action |
| --- | --- |
| `pnpm dev` | Start the local dev server at `localhost:4321` |
| `pnpm build` | Build the production site to `./dist/` |
| `pnpm preview` | Preview the production build locally |
| `pnpm test` | Run the unit test suite (Vitest) |
| `pnpm check` | Type-check the project (`astro check`) |

### Shared battles (Cloudflare D1)

Shared battle links are stored in a D1 database bound as `BATTLES_DB` (see `wrangler.jsonc`). To set up your own:

```sh
npx wrangler d1 create ai-battle-results
npx wrangler d1 migrations apply ai-battle-results
```

The API surface is small: `POST /api/battles` stores a battle and returns its id, `GET /api/battles/:id` fetches it for the `/battle` review page.

## Project structure

```text
/
├── migrations/            # D1 schema migrations
├── public/                # Static assets (favicon, fonts)
├── src/
│   ├── components/        # Astro components (header, footer, toolbar, icons)
│   ├── layouts/           # Base HTML layout and meta tags
│   ├── pages/
│   │   ├── index.astro    # The arena
│   │   ├── battle/        # Shared battle review page
│   │   └── api/battles/   # Shared battles API (Cloudflare D1)
│   ├── scripts/
│   │   ├── app.ts         # Arena logic
│   │   ├── battle.ts      # Battle review logic
│   │   ├── lib.ts         # Shared rendering and metric helpers
│   │   ├── model-icons.ts # Model brand icon registry
│   │   └── providers/     # Provider registry + SSE streaming
│   └── styles/            # Global styles (Tailwind 4)
└── wrangler.jsonc         # Cloudflare Workers + D1 config
```

## Privacy

Everything sensitive stays client-side: API keys, prompts and battle history live in your browser's `localStorage`. The only data that ever reaches the server is a battle you explicitly choose to share.

## Contributing

Issues and pull requests are welcome! Please use the [issue templates](.github/ISSUE_TEMPLATE) to report bugs or request features, and keep commits following the [Conventional Commits](https://www.conventionalcommits.org) style.

---

Built with 💚 by [midudev](https://midu.dev) · [Keep isbetter.ai free — sponsor the project](https://github.com/sponsors/midudev)
