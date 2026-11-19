export const DAY_MS = 86_400_000;

/** The UTC date of a timestamp as `YYYY-MM-DD`. */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
