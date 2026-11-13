const DAY_MS = 86_400_000;

/** The length of a day in milliseconds. */
export function dayMs(): number {
  return DAY_MS;
}

/** The UTC date of a timestamp as `YYYY-MM-DD`. */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
