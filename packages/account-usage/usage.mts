export type AllowanceWindow = { remainingPercent: number; resetsAt: number | null };
export type AccountUsage = { at: string; fiveHour?: AllowanceWindow; weekly?: AllowanceWindow };
const USAGE_FRESH_MS = 120_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function projectAccountUsage(input: unknown, now = Date.now()): AccountUsage | undefined {
  const response = record(input);
  if (!response) return;
  const buckets = record(response.rateLimitsByLimitId);
  const legacy = record(response.rateLimits);
  const bucket = record(buckets?.codex) ?? (legacy &&
    (legacy.limitId === "codex" || legacy.limitId === null || legacy.limitId === undefined) ? legacy : undefined);
  if (!bucket) return;
  const windows = [record(bucket.primary), record(bucket.secondary)];
  const windowFor = (duration: number): AllowanceWindow | undefined => {
    const window = windows.find((item) => item?.windowDurationMins === duration);
    if (!window || typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent)) return;
    return {
      remainingPercent: Math.floor(Math.max(0, Math.min(100, 100 - window.usedPercent))),
      resetsAt: typeof window.resetsAt === "number" && Number.isSafeInteger(window.resetsAt) && window.resetsAt > 0
        ? window.resetsAt : null,
    };
  };
  const fiveHour = windowFor(300);
  const weekly = windowFor(10080);
  if (!fiveHour && !weekly) return;
  return { at: new Date(now).toISOString(), ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) };
}

export function isAccountUsage(value: unknown): value is AccountUsage {
  const usage = record(value);
  if (!usage || typeof usage.at !== "string" || !Number.isFinite(Date.parse(usage.at))) return false;
  const isWindow = (item: unknown) => {
    const window = record(item);
    return Boolean(window && typeof window.remainingPercent === "number" && Number.isInteger(window.remainingPercent) &&
      window.remainingPercent >= 0 && window.remainingPercent <= 100 && (window.resetsAt === null ||
      (typeof window.resetsAt === "number" && Number.isSafeInteger(window.resetsAt) && window.resetsAt > 0)));
  };
  return (usage.fiveHour === undefined || isWindow(usage.fiveHour)) &&
    (usage.weekly === undefined || isWindow(usage.weekly)) &&
    (usage.fiveHour !== undefined || usage.weekly !== undefined);
}

export function usageExpiresAt(usage: AccountUsage, now = Date.now()): number {
  const at = Date.parse(usage.at);
  const deadlines = [at + USAGE_FRESH_MS, ...[usage.fiveHour, usage.weekly]
    .flatMap((window) => window?.resetsAt && window.resetsAt * 1000 > at ? [window.resetsAt * 1000] : [])];
  return Math.min(...deadlines.filter((deadline) => deadline > now));
}

export function availableWindow(usage: AccountUsage | undefined, window: AllowanceWindow | undefined, now: number) {
  if (!usage || !window || now < Date.parse(usage.at) || now >= Date.parse(usage.at) + USAGE_FRESH_MS ||
      (window.resetsAt !== null && now >= window.resetsAt * 1000)) return;
  return window;
}
