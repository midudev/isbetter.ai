import { beforeEach, describe, expect, it } from "vitest";
import {
  extractAnswer,
  extractCode,
  hasIncompleteCodeFence,
  HISTORY_KEY,
  downsampleMetricSamples,
  doneContentHTML,
  estOutputTokens,
  estTokens,
  hardenPreviewDocument,
  loadHistory,
  hardenedPreviewWrapperHTML,
  PREVIEW_ALLOW,
  PREVIEW_CSP,
  PREVIEW_FRAME_PATH,
  PREVIEW_SANDBOX,
  renderBattleInsights,
  renderMetricsTimeline,
  saveHistory,
  statsRowHTML,
  type Battle,
  type MetricSample,
} from "./lib";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage(),
    configurable: true,
  });
});

describe("token estimation", () => {
  it("counts thinking and answer text toward output tokens", () => {
    const reasoning = "a".repeat(40);
    const content = "b".repeat(40);
    expect(estOutputTokens(reasoning, content)).toBe(estTokens(reasoning + content));
    expect(estOutputTokens(reasoning, content)).toBeGreaterThan(estTokens(content));
  });

  it("treats thinking-only streams as non-zero output", () => {
    expect(estOutputTokens("thinking hard about the answer", "")).toBeGreaterThan(0);
    expect(estOutputTokens("", "")).toBe(0);
  });
});

describe("result extraction", () => {
  const response = `A concise explanation.\n\n\`\`\`html\n<!doctype html><p>Hello</p>\n\`\`\``;

  it("extracts a renderable HTML document", () => {
    expect(extractCode(response)).toContain("<!doctype html>");
  });

  it("keeps output readable by removing fenced source", () => {
    expect(extractAnswer(response)).toBe("A concise explanation.");
  });

  it("separates explanation from an HTML block truncated before its closing fence", () => {
    const truncated =
      "My approach uses accessible markup.\n\n```html\n<!doctype html><html><body>partial";
    expect(extractAnswer(truncated)).toBe("My approach uses accessible markup.");
    expect(extractCode(truncated)).toBe("<!doctype html><html><body>partial");
    expect(hasIncompleteCodeFence(truncated)).toBe(true);
    expect(hasIncompleteCodeFence(response)).toBe(false);
  });

  it("strips unfenced HTML documents from the prose output", () => {
    const mixed =
      "I built a responsive pricing page.\n\n<!doctype html><html><body><h1>Pricing</h1></body></html>";
    expect(extractAnswer(mixed)).toBe("I built a responsive pricing page.");
    expect(extractCode(mixed)).toContain("<!doctype html>");
  });

  it("offers a code tab affordance in the finished output view", () => {
    const html = doneContentHTML(
      {
        id: "gpt",
        key: "openai::gpt",
        raw: "A short summary.\n\n```html\n<!doctype html><html><body>hi</body></html>\n```",
        code: "<!doctype html><html><body>hi</body></html>",
        codeHtml: "",
      },
      "output",
    );
    expect(html).toContain("A short summary.");
    expect(html).not.toContain("<!doctype html>");
    expect(html).toContain('data-action="view-code"');
    expect(html).toContain("View code");
  });
});

describe("preview hardening", () => {
  it("keeps the sandbox opaque so previews cannot read parent localStorage", () => {
    // API keys are ab:key:* in the parent origin. allow-same-origin would
    // collapse that isolation.
    expect(PREVIEW_SANDBOX).toBe("allow-scripts");
    expect(PREVIEW_SANDBOX.split(/\s+/)).toEqual(["allow-scripts"]);
    expect(PREVIEW_SANDBOX).not.toContain("allow-same-origin");
  });

  it("shims localStorage before demo scripts so sandboxed previews do not throw", () => {
    const hardened = hardenPreviewDocument(
      `<!doctype html><html><body><script>localStorage.setItem("x","1")</script></body></html>`,
    );
    const shimAt = hardened.indexOf('install("localStorage"');
    const demoAt = hardened.indexOf('localStorage.setItem("x","1")');
    expect(shimAt).toBeGreaterThan(-1);
    expect(demoAt).toBeGreaterThan(-1);
    expect(shimAt).toBeLessThan(demoAt);
    expect(hardened).toContain('install("sessionStorage"');
  });

  it("injects CSP (CDN scripts allowed) and strips navigation gadgets", () => {
    const hardened = hardenPreviewDocument(
      `<!doctype html><html><head><base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test"><link rel="dns-prefetch" href="//evil.test"><link rel="preconnect stylesheet" href="https://evil.test/x.css"></head><body><map><area href="https://evil.test/phish"></map><img src="https://evil.test/t.gif"><script>fetch("https://evil.test")</script></body></html>`,
      { bridgeId: "model-a" },
    );

    expect(hardened).toContain(`content="${PREVIEW_CSP}"`);
    expect(PREVIEW_CSP).toContain("script-src");
    expect(PREVIEW_CSP).toMatch(/script-src[^;]*https:/);
    expect(PREVIEW_CSP).toMatch(/connect-src[^;]*https:/);
    expect(hardened).toContain("manifest-src 'none'");
    expect(hardened).toContain("form-action 'none'");
    expect(hardened).toContain("background:#080a08");
    expect(hardened).not.toMatch(/<base\b/i);
    expect(hardened).not.toMatch(/<area\b/i);
    expect(hardened).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
    expect(hardened).not.toMatch(/<link\b[^>]*\b(?:dns-prefetch|preconnect)\b/i);
    expect(hardened).toContain("blockedLink");
    expect(hardened).toContain('closest("a,area")');
    expect(hardened).toContain("getAttributeNS(XLINK");
    expect(hardened).toContain('href.charAt(0)!=="#"');
    expect(hardened.indexOf("Content-Security-Policy")).toBeLessThan(
      hardened.indexOf("fetch("),
    );
    expect(hardened).toContain("__ab");
  });

  it("wraps fragment HTML so CSP still applies", () => {
    const hardened = hardenPreviewDocument(`<h1>Hi</h1><script>alert(1)</script>`);
    expect(hardened).toMatch(/^<!DOCTYPE html>/i);
    expect(hardened).toContain(`content="${PREVIEW_CSP}"`);
    expect(hardened).toContain("<h1>Hi</h1>");
  });

  it("places CSP before attacker-controlled bytes and preserves complete documents", () => {
    const hardened = hardenPreviewDocument(
      `<script>fetch("https://evil.test/early")</script><!doctype html><html lang="en"><head><style>body{color:red}</style></head><body class="demo"><main>Safe</main></body></html>`,
    );

    expect(hardened).not.toContain("evil.test/early");
    expect(hardened).toContain('<html lang="en">');
    expect(hardened).toContain("<style>body{color:red}</style>");
    expect(hardened).toContain('<body class="demo">');
    expect(hardened).toContain("<main>Safe</main>");
  });

  it("renders previews in a scripts-only sandboxed iframe", () => {
    const html = doneContentHTML(
      {
        id: "gpt",
        key: "openai::gpt",
        raw: "",
        code: "<!doctype html><html><body>hi</body></html>",
        codeHtml: "",
      },
      "preview",
    );

    expect(html).toContain(`sandbox="${PREVIEW_SANDBOX}"`);
    expect(html).toContain(`src="${PREVIEW_FRAME_PATH}"`);
    expect(html).toContain("<textarea hidden data-preview-source>");
    expect(html).toContain(`allow="${PREVIEW_ALLOW}"`);
    expect(html).toContain('referrerpolicy="no-referrer"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).not.toContain("allow-modals");
    expect(html).not.toContain("allow-forms");
    expect(html).not.toContain("srcdoc=");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("bg-[var(--color-surface)] opacity-0");
    expect(html).toContain("transition-opacity duration-300");
    // Demo HTML is entity-escaped inside the textarea (safe for innerHTML).
    expect(html).toContain("&lt;!DOCTYPE html&gt;");
    expect(html).not.toMatch(/<textarea[^>]*>\s*<!DOCTYPE/i);
  });

  it("opens new-tab previews via a CSP-free wrapper and nested opaque iframe", () => {
    const wrapper = hardenedPreviewWrapperHTML(
      `<!doctype html><html><body><script>parent.localStorage.getItem("ab:key:openai")</script></body></html>`,
      'Title <">&',
    );

    // No wrapper CSP: srcdoc inherits parent policy, so script-src 'none'
    // would block the demo. Isolation is the nested sandbox (opaque origin).
    expect(wrapper).not.toMatch(/http-equiv="Content-Security-Policy"/i);
    expect(wrapper).not.toContain("script-src 'none'");
    expect(wrapper).toContain(`sandbox="${PREVIEW_SANDBOX}"`);
    expect(wrapper).not.toContain("allow-same-origin");
    expect(wrapper).toContain("Title &lt;&quot;&gt;&amp;");
    // Untrusted markup only appears inside the escaped srcdoc attribute.
    const srcdocMatch = wrapper.match(/srcdoc="([^"]*)"/);
    expect(srcdocMatch).toBeTruthy();
    expect(srcdocMatch![1]).toContain("localStorage.getItem");
    expect(wrapper.replace(srcdocMatch![0], "")).not.toContain("localStorage");
    // Nested preview still carries its own PREVIEW_CSP via meta (HTML-escaped).
    expect(srcdocMatch![1]).toContain("Content-Security-Policy");
    expect(srcdocMatch![1]).toContain("script-src &#39;unsafe-inline&#39;");
    expect(srcdocMatch![1]).toContain("https: http: blob:");
  });

  it("does not create an iframe until a deferred public preview is approved", () => {
    const html = doneContentHTML(
      {
        id: "gpt",
        key: "openai::gpt",
        raw: "",
        code: "<!doctype html><html><body>hi</body></html>",
        codeHtml: "",
      },
      "preview",
      { deferPreview: true },
    );

    expect(html).toContain('data-action="run-preview"');
    expect(html).toContain("untrusted code");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("srcdoc=");
  });
});

describe("history migration", () => {
  it("adds a stable composite key to legacy results", () => {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify([
        {
          id: "1",
          ts: 1,
          prompt: "test",
          system: "system",
          results: [
            {
              id: "gpt-test",
              provider: "openai",
              label: "GPT",
              raw: "ok",
              code: "",
              state: "done",
              error: "",
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
              cost: 0,
              durationMs: 100,
              genMs: 80,
            },
          ],
        },
      ]),
    );

    const [battle] = loadHistory();
    expect(battle.schemaVersion).toBe(3);
    expect(battle.results[0]).toMatchObject({
      key: "openai::gpt-test",
      ttftMs: 20,
      costKnown: false,
    });
  });

  it("persists the current schema version and blind-mode mapping", () => {
    const battle: Battle = {
      id: "1",
      ts: 1,
      prompt: "",
      system: "",
      results: [],
      blind: {
        enabled: true,
        revealed: false,
        order: ["openai::model"],
        aliases: { "openai::model": "Model A" },
      },
    };
    saveHistory([battle]);
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]")[0];
    expect(saved.schemaVersion).toBe(3);
    expect(saved.blind.aliases["openai::model"]).toBe("Model A");
  });
});

describe("metric timelines", () => {
  const samples: MetricSample[] = Array.from({ length: 120 }, (_, index) => ({
    tMs: index * 250,
    completionTokens: index * 10,
    cost: index * 0.0001,
    costKnown: true,
    estimated: index < 119,
  }));

  it("limits samples while preserving both endpoints", () => {
    const reduced = downsampleMetricSamples(samples, 20);
    expect(reduced).toHaveLength(20);
    expect(reduced[0]).toEqual(samples[0]);
    expect(reduced.at(-1)).toEqual(samples.at(-1));
  });

  it("renders an accessible SVG timeline and model legend", () => {
    const html = renderMetricsTimeline([
      {
        key: "openai::model",
        id: "model",
        provider: "openai",
        label: "Model A",
        state: "done",
        durationMs: 30_000,
        completionTokens: 1_190,
        cost: 0.0119,
        metrics: samples,
      },
    ]);
    expect(html).toContain("<svg");
    expect(html).toContain("Tokens and cost generated over time");
    expect(html).toContain("Model A");
    expect(html).toContain("<path");
    expect(html).toContain('stroke-dasharray="7 6"');
    expect(html).toContain("&quot;tMs&quot;:0");
    expect(html).toContain('data-timeline-plot');
    expect(html).toContain('data-timeline-tooltip');
    expect(html).toContain('data-timeline-hitbox');
  });

  it("keeps tokens visible when cost history is unavailable", () => {
    const html = renderMetricsTimeline([
      {
        key: "local::model",
        id: "model",
        label: "Local model",
        state: "done",
        durationMs: 1_000,
        completionTokens: 10,
        cost: 0,
        costKnown: false,
        metrics: samples.map((sample) => ({ ...sample, costKnown: false })),
      },
    ]);
    expect(html).toContain("Tokens and cost generated over time");
    expect(html).not.toContain('stroke-dasharray="7 6"');
  });

  it("renders compact battle insights beside the chart", () => {
    const html = renderBattleInsights([
      {
        key: "openai::model",
        id: "model",
        label: "Model A",
        state: "done",
        durationMs: 2_000,
        genMs: 1_500,
        completionTokens: 200,
        cost: 0.01,
        costKnown: true,
      },
    ]);
    expect(html).toContain("Battle at a glance");
    expect(html).toContain("200");
    expect(html).toContain("$0.0100");
    expect(html).toContain("Model A");
  });
});

describe("metric tooltips", () => {
  it("renders keyboard-focusable tooltip triggers with useful copy", () => {
    const html = statsRowHTML({
      durationMs: 2_000,
      ttftMs: 300,
      genMs: 1_700,
      promptTokens: 100,
      completionTokens: 200,
      cost: 0.01,
      costKnown: true,
    });
    expect(html).toContain('data-metric-tooltip="total time — request to finish"');
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain('title="total time');
  });
});
