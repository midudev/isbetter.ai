import type {
  Battle,
  BlindBattleState,
  HistoryResult,
} from "./lib";
import {
  MAX_METRIC_SAMPLES,
  downsampleMetricSamples,
  type MetricSample,
} from "./metrics";

export const SHARED_BATTLE_SCHEMA_VERSION = 1;
export const MAX_SHARED_BATTLE_BYTES = 1_500_000;
export const MAX_SHARED_RESULTS = 16;

export interface SharedBattleResult {
  id: string;
  key: string;
  provider: string;
  label: string;
  raw: string;
  code: string;
  state: "done";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  costKnown: boolean;
  usageEstimated: boolean;
  durationMs: number;
  ttftMs?: number;
  genMs?: number;
  metrics: MetricSample[];
}

export interface SharedBattleData {
  schemaVersion: typeof SHARED_BATTLE_SCHEMA_VERSION;
  ts: number;
  prompt: string;
  results: SharedBattleResult[];
  blind?: BlindBattleState;
}

export interface SharedBattle extends SharedBattleData {
  id: string;
}

export class SharedBattleValidationError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function stringField(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string")
    throw new SharedBattleValidationError(`${name} must be a string`);
  if (value.length > maxLength)
    throw new SharedBattleValidationError(`${name} is too long`);
  return value;
}

function numberField(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new SharedBattleValidationError(`${name} must be a finite number`);
  return Math.max(0, value);
}

function optionalNumberField(value: unknown, name: string): number | undefined {
  return value == null ? undefined : numberField(value, name);
}

function booleanField(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseMetric(value: unknown, index: number): MetricSample {
  if (!isRecord(value))
    throw new SharedBattleValidationError(`metrics[${index}] must be an object`);
  return {
    tMs: numberField(value.tMs, `metrics[${index}].tMs`),
    completionTokens: numberField(
      value.completionTokens,
      `metrics[${index}].completionTokens`,
    ),
    cost: numberField(value.cost, `metrics[${index}].cost`),
    costKnown: booleanField(value.costKnown),
    estimated: booleanField(value.estimated),
  };
}

function parseResult(value: unknown, index: number): SharedBattleResult {
  if (!isRecord(value))
    throw new SharedBattleValidationError(`results[${index}] must be an object`);
  if (value.state !== "done")
    throw new SharedBattleValidationError(`results[${index}] must be successful`);

  const id = stringField(value.id, `results[${index}].id`, 300);
  const provider = stringField(value.provider, `results[${index}].provider`, 50);
  const metrics = Array.isArray(value.metrics)
    ? downsampleMetricSamples(
        value.metrics.map((sample, sampleIndex) => parseMetric(sample, sampleIndex)),
        MAX_METRIC_SAMPLES,
      )
    : [];

  return {
    id,
    key: stringField(value.key || `${provider}::${id}`, `results[${index}].key`, 400),
    provider,
    label: stringField(value.label, `results[${index}].label`, 200),
    raw: stringField(value.raw, `results[${index}].raw`, 650_000),
    code: stringField(value.code, `results[${index}].code`, 650_000),
    state: "done",
    promptTokens: numberField(value.promptTokens, `results[${index}].promptTokens`),
    completionTokens: numberField(
      value.completionTokens,
      `results[${index}].completionTokens`,
    ),
    totalTokens: numberField(value.totalTokens, `results[${index}].totalTokens`),
    cost: numberField(value.cost, `results[${index}].cost`),
    costKnown: booleanField(value.costKnown),
    usageEstimated: booleanField(value.usageEstimated),
    durationMs: numberField(value.durationMs, `results[${index}].durationMs`),
    ttftMs: optionalNumberField(value.ttftMs, `results[${index}].ttftMs`),
    genMs: optionalNumberField(value.genMs, `results[${index}].genMs`),
    metrics,
  };
}

function parseBlind(value: unknown, resultKeys: Set<string>): BlindBattleState | undefined {
  if (!isRecord(value) || value.enabled !== true) return undefined;
  const sourceOrder = Array.isArray(value.order) ? value.order : [];
  const order = sourceOrder
    .filter((key): key is string => typeof key === "string" && resultKeys.has(key))
    .filter((key, index, values) => values.indexOf(key) === index);
  const sourceAliases = isRecord(value.aliases) ? value.aliases : {};
  const aliases = Object.fromEntries(
    order.map((key) => [
      key,
      typeof sourceAliases[key] === "string"
        ? stringField(sourceAliases[key], `blind.aliases.${key}`, 80)
        : "Model ?",
    ]),
  );
  return {
    enabled: true,
    revealed: booleanField(value.revealed),
    order,
    aliases,
  };
}

export function parseSharedBattleData(value: unknown): SharedBattleData {
  if (!isRecord(value))
    throw new SharedBattleValidationError("battle must be an object");
  if (value.schemaVersion !== SHARED_BATTLE_SCHEMA_VERSION)
    throw new SharedBattleValidationError("unsupported shared battle schema");
  if (!Array.isArray(value.results) || value.results.length === 0)
    throw new SharedBattleValidationError("battle needs at least one successful result");
  if (value.results.length > MAX_SHARED_RESULTS)
    throw new SharedBattleValidationError("battle has too many results");

  const results = value.results.map(parseResult);
  const keys = new Set(results.map((result) => result.key));
  return {
    schemaVersion: SHARED_BATTLE_SCHEMA_VERSION,
    ts: numberField(value.ts, "ts"),
    prompt: stringField(value.prompt, "prompt", 20_000),
    results,
    blind: parseBlind(value.blind, keys),
  };
}

export function parseSharedBattle(value: unknown): SharedBattle {
  if (!isRecord(value))
    throw new SharedBattleValidationError("battle must be an object");
  return {
    id: stringField(value.id, "id", 100),
    ...parseSharedBattleData(value),
  };
}

export function toSharedBattleData(battle: Battle): SharedBattleData {
  return parseSharedBattleData({
    schemaVersion: SHARED_BATTLE_SCHEMA_VERSION,
    ts: battle.ts,
    prompt: battle.prompt,
    results: battle.results
      .filter((result) => result.state === "done")
      .map((result) => ({
        id: result.id,
        key: result.key || `${result.provider || "openrouter"}::${result.id}`,
        provider: result.provider || "openrouter",
        label: result.label,
        raw: result.raw,
        code: result.code,
        state: "done",
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        totalTokens: result.totalTokens,
        cost: result.cost,
        costKnown: result.costKnown !== false,
        usageEstimated: result.usageEstimated === true,
        durationMs: result.durationMs,
        ttftMs: result.ttftMs,
        genMs: result.genMs,
        metrics: result.metrics || [],
      })),
    blind: battle.blind,
  });
}

export function sharedBattleToBattle(shared: SharedBattle): Battle {
  const results: HistoryResult[] = shared.results.map((result) => ({
    ...result,
    error: "",
  }));
  return {
    id: shared.id,
    schemaVersion: 3,
    ts: shared.ts,
    prompt: shared.prompt,
    system: "",
    results,
    blind: shared.blind,
  };
}
