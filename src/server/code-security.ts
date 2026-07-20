/**
 * Publish-time security review for shared battle code.
 *
 * Layers:
 * 1. Deterministic rules (always) — can hard-block alone.
 * 2. Cloudflare Workers AI: Qwen3 30B for every analysis.
 * 3. GPT-OSS 120B only when Qwen is uncertain or confidence < 0.8.
 *
 * LLM alone never hard-blocks without either high confidence + high/critical
 * findings, or corroborating deterministic signal (fail-open if AI is down,
 * except when rules alone already block).
 */

import { rulesAloneBlock, scanCodeWithRules } from "./code-security-rules";
import { classifyCodeWithAi } from "./code-security-llm";
import type {
  AiBinding,
  CodeSecurityReview,
  SecurityFinding,
  SecurityVerdict,
} from "./code-security-types";

export type { AiBinding, CodeSecurityReview, SecurityFinding } from "./code-security-types";

export interface ReviewableResult {
  label?: string;
  code: string;
}

const VERDICT_RANK: Record<SecurityVerdict, number> = {
  safe: 0,
  uncertain: 1,
  suspicious: 2,
  malicious: 3,
};

function worseVerdict(a: SecurityVerdict, b: SecurityVerdict): SecurityVerdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

/**
 * Decide whether to refuse publishing based on rules + LLM.
 * Prefer dual signal; never trust a low-confidence LLM alone.
 */
export function decidePublishAllowed(
  ruleFindings: SecurityFinding[],
  ruleRisk: number,
  llm: {
    verdict: SecurityVerdict;
    confidence: number;
    findings: Omit<SecurityFinding, "source">[];
    risk: number;
  } | null,
): { allowed: boolean; reason: string } {
  if (
    rulesAloneBlock({
      findings: ruleFindings,
      risk: ruleRisk,
      maxSeverity: ruleFindings.some((f) => f.severity === "critical")
        ? "critical"
        : ruleFindings.some((f) => f.severity === "high")
          ? "high"
          : null,
    })
  ) {
    return {
      allowed: false,
      reason: "Deterministic security rules flagged critical or high-risk patterns.",
    };
  }

  if (!llm) {
    // AI unavailable: only hard rule blocks (handled above). Soft findings pass.
    return { allowed: true, reason: "Rules only; no hard block." };
  }

  const hasRuleSignal = ruleFindings.length > 0;
  const llmHighFinding = llm.findings.some(
    (f) => f.severity === "critical" || f.severity === "high",
  );

  if (llm.verdict === "malicious" && llm.confidence >= 0.8) {
    if (hasRuleSignal || llmHighFinding || llm.confidence >= 0.95) {
      return {
        allowed: false,
        reason: "Model classified code as malicious with sufficient confidence.",
      };
    }
  }

  if (
    llm.verdict === "suspicious" &&
    llm.confidence >= 0.8 &&
    ruleFindings.some((f) => f.severity === "high" || f.severity === "medium")
  ) {
    return {
      allowed: false,
      reason: "Suspicious model verdict corroborated by static rules.",
    };
  }

  if (llm.risk >= 80 && llm.confidence >= 0.85 && hasRuleSignal) {
    return {
      allowed: false,
      reason: "Elevated combined risk from model and static rules.",
    };
  }

  return { allowed: true, reason: "Passed security review." };
}

function publicSummary(allowed: boolean, findings: SecurityFinding[]): string {
  if (allowed) {
    if (findings.length === 0) return "No security issues detected.";
    return `Allowed with ${findings.length} low-signal note(s).`;
  }
  const types = [...new Set(findings.map((f) => f.type))].slice(0, 5);
  return types.length
    ? `Blocked: ${types.join(", ")}.`
    : "Blocked by security review.";
}

/**
 * Review one or more result code blobs from a shared battle payload.
 * Scans each non-empty code string; blocks the whole publish if any is unsafe.
 */
export async function reviewSharedBattleCode(
  results: ReviewableResult[],
  ai?: AiBinding | null,
): Promise<CodeSecurityReview> {
  const snippets = results
    .map((r, index) => ({
      label: r.label?.trim() || `result-${index}`,
      code: typeof r.code === "string" ? r.code : "",
    }))
    .filter((s) => s.code.trim().length > 0);

  if (snippets.length === 0) {
    return {
      allowed: true,
      verdict: "safe",
      risk: 0,
      confidence: 1,
      findings: [],
      summary: "No code to review.",
      models: [],
      llmSkipped: true,
    };
  }

  // Deterministic pass over every snippet (full text, not truncated).
  const allRuleFindings: SecurityFinding[] = [];
  let ruleRisk = 0;
  for (const snippet of snippets) {
    const scan = scanCodeWithRules(snippet.code);
    allRuleFindings.push(...scan.findings);
    ruleRisk = Math.min(100, ruleRisk + scan.risk);
  }

  // Hard block from rules — skip AI cost when already refused.
  if (
    rulesAloneBlock({
      findings: allRuleFindings,
      risk: ruleRisk,
      maxSeverity: allRuleFindings.some((f) => f.severity === "critical")
        ? "critical"
        : null,
    })
  ) {
    return {
      allowed: false,
      verdict: "malicious",
      risk: Math.max(ruleRisk, 90),
      confidence: 1,
      findings: allRuleFindings,
      summary: publicSummary(false, allRuleFindings),
      models: [],
      llmSkipped: true,
    };
  }

  // Combine snippets for a single primary LLM call (cost + latency).
  const combined = snippets
    .map((snippet) => `--- ${snippet.label} ---\n${snippet.code}`)
    .join("\n\n");

  let llmReport: Awaited<ReturnType<typeof classifyCodeWithAi>>["report"] | null =
    null;
  let models: string[] = [];
  let llmSkipped = false;

  if (ai) {
    try {
      const classified = await classifyCodeWithAi(ai, combined);
      llmReport = classified.report;
      models = classified.models;
    } catch {
      llmSkipped = true;
    }
  } else {
    llmSkipped = true;
  }

  const llmFindings: SecurityFinding[] = (llmReport?.findings ?? []).map((f) => ({
    ...f,
    source: "llm" as const,
  }));

  const findings = [...allRuleFindings, ...llmFindings];
  const decision = decidePublishAllowed(
    allRuleFindings,
    ruleRisk,
    llmReport
      ? {
          verdict: llmReport.verdict,
          confidence: llmReport.confidence,
          findings: llmReport.findings,
          risk: llmReport.risk,
        }
      : null,
  );

  const verdict: SecurityVerdict = !decision.allowed
    ? "malicious"
    : llmReport
      ? worseVerdict(
          llmReport.verdict === "malicious" && decision.allowed
            ? "suspicious"
            : llmReport.verdict,
          allRuleFindings.length ? "suspicious" : "safe",
        )
      : allRuleFindings.length
        ? "suspicious"
        : "safe";

  const risk = Math.min(
    100,
    Math.max(ruleRisk, llmReport?.risk ?? 0),
  );
  const confidence = llmReport?.confidence ?? (llmSkipped ? 0.5 : 1);

  return {
    allowed: decision.allowed,
    verdict,
    risk,
    confidence,
    findings,
    summary: publicSummary(decision.allowed, findings),
    models,
    llmSkipped,
  };
}
