interface RateLimitWindow {
  readonly remainingPercent: number;
  readonly resetsAt: string | null;
}

interface NormalizedRateLimits {
  readonly fiveHour: RateLimitWindow | null;
  readonly weekly: RateLimitWindow | null;
}

const PERCENT = 100;
const SECONDS_TO_MILLISECONDS = 1000;
const MILLISECOND_TIMESTAMP_THRESHOLD = 1e12;
const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 10_080;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeReset = (value: unknown): string | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const milliseconds =
    value > MILLISECOND_TIMESTAMP_THRESHOLD ? value : value * SECONDS_TO_MILLISECONDS;
  return new Date(milliseconds).toISOString();
};

const rateLimitWindow = (value: unknown): RateLimitWindow | null => {
  if (!isObject(value) || typeof value['usedPercent'] !== 'number') {
    return null;
  }
  return {
    remainingPercent: Math.max(0, PERCENT - value['usedPercent']),
    resetsAt: normalizeReset(value['resetsAt']),
  };
};

const windowDuration = (value: unknown): number =>
  isObject(value) && typeof value['windowDurationMins'] === 'number'
    ? value['windowDurationMins']
    : 0;

const snapshots = (value: unknown): readonly Record<string, unknown>[] => {
  if (!isObject(value)) {
    return [];
  }
  const current = isObject(value['rateLimits']) ? [value['rateLimits']] : [value];
  const byId = isObject(value['rateLimitsByLimitId'])
    ? Object.values(value['rateLimitsByLimitId']).filter((item) => isObject(item))
    : [];
  return [...current, ...byId];
};

const readRateLimits = (value: unknown): NormalizedRateLimits => {
  const candidates = snapshots(value);
  const windows = candidates.flatMap((snapshot) => [snapshot['primary'], snapshot['secondary']]);
  const fiveHour = windows.find((window) => windowDuration(window) === FIVE_HOUR_MINUTES);
  const weekly = windows.find((window) => windowDuration(window) === WEEKLY_MINUTES);
  return { fiveHour: rateLimitWindow(fiveHour), weekly: rateLimitWindow(weekly) };
};

export { readRateLimits };
export type { NormalizedRateLimits, RateLimitWindow };
