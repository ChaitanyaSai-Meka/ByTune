import test from "node:test";
import assert from "node:assert/strict";
import { activityDays, fmtHours } from "../.test-build/replay-format.mjs";
import { fmtTotal } from "../.test-build/format.mjs";

test("listening time reads naturally", () => {
  assert.equal(fmtHours(42 * 60_000), "42 min");
  assert.equal(fmtHours(3_600_000), "1 hr", "not 1.0 hrs");
  assert.equal(fmtHours(2.5 * 3_600_000), "2.5 hrs");
  assert.equal(fmtHours(1204 * 3_600_000), `${(1204).toLocaleString()} hrs`);
});

test("the activity chart keeps quiet days at zero", () => {
  const today = new Date(2026, 10, 5, 15, 0); // 5 Nov 2026
  const days = [{ date: "2026-11-02", ms: 600_000 }];
  assert.deepEqual(activityDays("month", days, today).map((d) => [d.date, d.ms]), [
    ["2026-11-01", 0],
    ["2026-11-02", 600_000],
    ["2026-11-03", 0],
    ["2026-11-04", 0],
    ["2026-11-05", 0],
  ]);
  const last = activityDays("lastMonth", [], today);
  assert.equal(last.length, 31, "every day of October");
  assert.equal(last[0].date, "2026-10-01");
  assert.equal(last.at(-1).date, "2026-10-31");
  const year = activityDays("year", [], today);
  assert.equal(year.length, 28, "the last four weeks for the long periods");
  assert.equal(year.at(-1).date, "2026-11-05");
});

test("a playlist's total length reads in words, not as a clock", () => {
  assert.equal(fmtTotal(45 * 60), "45 min");
  assert.equal(fmtTotal(62 * 60 + 20), "1 hr 2 min");
  assert.equal(fmtTotal(3 * 3600 + 10), "3 hr");
  assert.equal(fmtTotal(20), "1 min", "never 0 min");
});
