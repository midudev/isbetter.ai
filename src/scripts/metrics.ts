export interface MetricSample {
  tMs: number;
  completionTokens: number;
  cost: number;
  costKnown: boolean;
  estimated: boolean;
}

export const MAX_METRIC_SAMPLES = 80;

export function downsampleMetricSamples(
  samples: MetricSample[],
  maxPoints = MAX_METRIC_SAMPLES,
): MetricSample[] {
  if (samples.length <= maxPoints || maxPoints < 2)
    return samples.slice(0, Math.max(1, maxPoints));
  const result = [samples[0]];
  const step = (samples.length - 1) / (maxPoints - 1);
  for (let index = 1; index < maxPoints - 1; index++)
    result.push(samples[Math.round(index * step)]);
  result.push(samples[samples.length - 1]);
  return result;
}
