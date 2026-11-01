/** Replay's numbers and days, worded and counted the same everywhere. */

export type ReplayPeriod = "month" | "lastMonth" | "year" | "all";

/** "42 min", "1 hr", "2.5 hrs", "1,204 hrs". */
export function fmtHours(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60000)} min`;
  const v = h < 10 ? Math.round(h * 10) / 10 : Math.round(h);
  return `${v.toLocaleString()} ${v === 1 ? "hr" : "hrs"}`;
}

/** Local "YYYY-MM-DD", the shape electron/stats.ts keys its days by. */
export const isoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The activity chart's days, quiet ones included at 0: the month so far, all
 *  of last month, or the last 28 days for the longer periods. */
export function activityDays(
  period: ReplayPeriod,
  days: { date: string; ms: number }[],
  today = new Date(),
): { date: string; ms: number }[] {
  const byDate = new Map(days.map((d) => [d.date, d.ms]));
  const y = today.getFullYear();
  const m = today.getMonth();
  const [start, end] =
    period === "month" ? [new Date(y, m, 1), today]
    : period === "lastMonth" ? [new Date(y, m - 1, 1), new Date(y, m, 0)]
    : [new Date(y, m, today.getDate() - 27), today];
  const out: { date: string; ms: number }[] = [];
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const date = isoDay(d);
    out.push({ date, ms: byDate.get(date) ?? 0 });
  }
  return out;
}
