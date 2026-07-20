/**
 * Deterministic static checks for untrusted frontend code published to shared battles.
 * These run fully offline (no AI) and are the only hard fail-closed path when AI is down.
 */

import type { FindingSeverity, SecurityFinding } from "./code-security-types";

export interface RuleMatch {
  type: string;
  severity: FindingSeverity;
  pattern: RegExp;
  explanation: string;
  /** Cap evidence length extracted from a match. */
  evidenceMax?: number;
}

/** Patterns that indicate abuse intent in shared HTML/JS previews. */
export const SECURITY_RULES: RuleMatch[] = [
  {
    type: "dynamic_execution",
    severity: "critical",
    pattern: /\beval\s*\(/i,
    explanation: "Uses eval() which enables arbitrary code execution from strings.",
  },
  {
    type: "dynamic_execution",
    severity: "critical",
    pattern: /\bnew\s+Function\s*\(/i,
    explanation: "Constructs a Function from a string (dynamic code execution).",
  },
  {
    type: "dynamic_execution",
    severity: "high",
    pattern: /\b(?:setTimeout|setInterval)\s*\(\s*(['"`])[\s\S]*?\1/i,
    explanation: "Schedules a string as code via setTimeout/setInterval.",
  },
  {
    type: "remote_script_loading",
    severity: "critical",
    pattern:
      /<script\b[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\/[^"']+["'][^>]*>/i,
    explanation: "Loads a remote script, which can bypass preview isolation intent.",
  },
  {
    type: "remote_script_loading",
    severity: "high",
    pattern:
      /\bimport\s*\(\s*['"`](?:https?:)?\/\/[^'"`]+['"`]\s*\)|\bimportScripts\s*\(/i,
    explanation: "Dynamically imports or importScripts remote/untrusted code.",
  },
  {
    type: "credential_theft",
    severity: "critical",
    pattern: /\bdocument\.cookie\b/i,
    explanation: "Reads or writes document.cookie (credential/session theft risk).",
  },
  {
    type: "credential_theft",
    severity: "high",
    pattern: /\b(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem|key|clear|removeItem)\b/i,
    explanation: "Accesses browser storage APIs often used for token or key theft.",
  },
  {
    type: "credential_theft",
    severity: "high",
    pattern: /\bindexedDB\b|\bwebkitRequestFileSystem\b|\bopenDatabase\s*\(/i,
    explanation: "Uses browser persistence APIs that can store or harvest data.",
  },
  {
    type: "data_exfiltration",
    severity: "high",
    pattern: /\bnavigator\.sendBeacon\s*\(/i,
    explanation: "Uses sendBeacon, a common exfiltration channel.",
  },
  {
    type: "data_exfiltration",
    severity: "medium",
    pattern: /\b(?:fetch|XMLHttpRequest|axios)\s*\(/i,
    explanation: "Performs network I/O; review whether data is being sent out.",
  },
  {
    type: "data_exfiltration",
    severity: "high",
    pattern: /\bnew\s+WebSocket\s*\(\s*['"`](?:wss?:)?\/\//i,
    explanation: "Opens an outbound WebSocket to a remote host.",
  },
  {
    type: "keylogging",
    severity: "high",
    pattern:
      /\b(?:addEventListener|on(?:key(?:down|up|press)|input|change))\b[\s\S]{0,120}\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket|Image\s*\()/i,
    explanation: "Hooks input events in proximity to network or beacon APIs.",
  },
  {
    type: "malicious_redirect",
    severity: "high",
    pattern:
      /\b(?:location|window\.location)(?:\.href|\.replace|\.assign)?\s*=\s*['"`](?:https?:)?\/\//i,
    explanation: "Redirects the browsing context to an external URL.",
  },
  {
    type: "malicious_redirect",
    severity: "medium",
    pattern: /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/i,
    explanation: "Uses meta refresh, often for drive-by redirects.",
  },
  {
    type: "cryptomining",
    severity: "critical",
    pattern:
      /\b(?:coinhive|cryptonight|coin-hive|webmine|miner\.start|CryptoNight|wasm_miner|stratum\+tcp)\b/i,
    explanation: "Matches known cryptomining library or protocol markers.",
  },
  {
    type: "obfuscated_execution",
    severity: "high",
    pattern: /\batob\s*\(\s*['"`][A-Za-z0-9+/=]{80,}['"`]\s*\)/i,
    explanation: "Decodes a large base64 payload (common obfuscation step).",
  },
  {
    type: "obfuscated_execution",
    severity: "critical",
    pattern:
      /\b(?:eval|Function)\s*\(\s*(?:atob|unescape|decodeURIComponent)\s*\(/i,
    explanation: "Chains decode helpers into eval/Function (classic packer pattern).",
  },
  {
    type: "browser_api_abuse",
    severity: "critical",
    pattern:
      /\b(?:chrome|browser)\s*\.\s*(?:runtime|tabs|cookies|storage|webRequest|extension)\b/i,
    explanation: "Touches browser extension APIs (not legitimate in shared demos).",
  },
  {
    type: "persistence",
    severity: "medium",
    pattern: /\bserviceWorker\b|\bnavigator\.serviceWorker\b|\b caches\.open\s*\(/i,
    explanation: "Registers or uses service workers / Cache API for persistence.",
  },
  {
    type: "form_interception",
    severity: "high",
    pattern:
      /\b(?:password|creditcard|ssn|cardnumber)\b[\s\S]{0,200}\b(?:fetch|XMLHttpRequest|sendBeacon|WebSocket)\b/i,
    explanation: "Mentions sensitive form fields near network APIs.",
  },
  {
    type: "remote_script_loading",
    severity: "high",
    pattern:
      /<iframe\b[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\/[^"']+["'][^>]*>/i,
    explanation: "Embeds a remote iframe that can load untrusted third-party content.",
  },
  {
    type: "suspicious_network",
    severity: "medium",
    pattern: /\bnew\s+Image\s*\([^)]*\)[\s\S]{0,40}\.src\s*=/i,
    explanation: "Uses Image beacon pattern often employed for silent exfiltration.",
  },
];

const SEVERITY_SCORE: Record<FindingSeverity, number> = {
  low: 10,
  medium: 25,
  high: 50,
  critical: 90,
};

function clipEvidence(text: string, max = 160): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

export interface DeterministicScan {
  findings: SecurityFinding[];
  risk: number;
  /** Highest severity seen, or null if clean. */
  maxSeverity: FindingSeverity | null;
}

export function scanCodeWithRules(code: string): DeterministicScan {
  if (!code || !code.trim()) {
    return { findings: [], risk: 0, maxSeverity: null };
  }

  const findings: SecurityFinding[] = [];
  const seen = new Set<string>();

  for (const rule of SECURITY_RULES) {
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(code);
    if (!match) continue;
    const key = `${rule.type}:${rule.severity}:${match[0].slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      type: rule.type,
      severity: rule.severity,
      evidence: clipEvidence(match[0], rule.evidenceMax ?? 160),
      explanation: rule.explanation,
      source: "rules",
    });
  }

  // Heuristic: high density of hex/unicode escapes often means packing.
  const escapeHits = code.match(/\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}/g);
  if (escapeHits && escapeHits.length >= 40) {
    findings.push({
      type: "obfuscated_execution",
      severity: "high",
      evidence: clipEvidence(escapeHits.slice(0, 12).join("")),
      explanation: `Dense escape sequences (${escapeHits.length} hits) suggest packed or obfuscated code.`,
      source: "rules",
    });
  }

  const risk = Math.min(
    100,
    findings.reduce((sum, f) => sum + SEVERITY_SCORE[f.severity], 0),
  );

  const order: FindingSeverity[] = ["critical", "high", "medium", "low"];
  const maxSeverity =
    order.find((severity) => findings.some((f) => f.severity === severity)) ?? null;

  return { findings, risk, maxSeverity };
}

/** True when rules alone are enough to refuse publish (no LLM required). */
export function rulesAloneBlock(scan: DeterministicScan): boolean {
  if (scan.findings.some((f) => f.severity === "critical")) return true;
  if (scan.risk >= 80) return true;
  const highs = scan.findings.filter((f) => f.severity === "high").length;
  return highs >= 2;
}
