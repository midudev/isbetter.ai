/** Shared types for publish-time code security review. */

export type SecurityVerdict = "safe" | "suspicious" | "malicious" | "uncertain";
export type FindingSeverity = "low" | "medium" | "high" | "critical";

export interface SecurityFinding {
  type: string;
  severity: FindingSeverity;
  evidence: string;
  explanation: string;
  /** Origin of the finding. */
  source: "rules" | "llm";
}

export interface LlmSecurityReport {
  verdict: SecurityVerdict;
  risk: number;
  confidence: number;
  findings: Omit<SecurityFinding, "source">[];
  summary: string;
  model: string;
}

export interface CodeSecurityReview {
  allowed: boolean;
  verdict: SecurityVerdict;
  risk: number;
  confidence: number;
  findings: SecurityFinding[];
  summary: string;
  /** Models consulted, in order (e.g. qwen then gpt-oss). */
  models: string[];
  /** True when Workers AI was unavailable or failed; only rules applied. */
  llmSkipped: boolean;
}

export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}
