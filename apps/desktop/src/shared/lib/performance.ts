type TimingValue = string | number | boolean | null | undefined;

export type TimingMetadata = Record<string, TimingValue>;

export function nowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function logTiming(
  label: string,
  startedAt: number,
  metadata: TimingMetadata = {},
): number {
  const durationMs = nowMs() - startedAt;
  const roundedDuration = Number(durationMs.toFixed(1));
  const payload = { durationMs: roundedDuration, ...metadata };

  console.info(`[perf] ${label}`, payload);

  return durationMs;
}
