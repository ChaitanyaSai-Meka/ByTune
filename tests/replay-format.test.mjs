import test from "node:test";
import assert from "node:assert/strict";
import { activityDays, biggestDay, creditArtists, creditNames, fmtHours, journalReplay, peakHour, streaks } from "../.test-build/replay-format.mjs";
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

test("a week from the journal: minutes count everything heard, plays only real listens", () => {
  const now = new Date(2026, 10, 5, 15, 0).getTime(); // 5 Nov 2026, 3 PM
  const song = (id, artist, album) => ({ id, title: id, artist, ...(album ? { album } : {}), duration: 200, thumb: `t/${id}` });
  const at = (daysAgo, hour) => new Date(2026, 10, 5 - daysAgo, hour, 0).getTime();
  const a = song("a", "Sid Sriram", "Album A");
  const b = song("b", "Arijit Singh");
  const r = journalReplay(
    [
      { track: a, at: at(8, 10), heard: 200, out: "done" },
      { track: a, at: at(6, 9), heard: 200, out: "done" },
      { track: a, at: at(1, 21), heard: 180, out: "done" },
      { track: b, at: at(0, 14), heard: 12, out: "skip" },
      { track: b, at: at(0, 14) + 60_000, heard: 150, out: "part" },
    ],
    now
  );
  assert.equal(r.plays, 3, "eight days ago is outside the week, and a skip isn't a play");
  assert.equal(r.totalMs, (200 + 180 + 12 + 150) * 1000, "every second heard counts");
  assert.deepEqual(r.tracks.map((t) => [t.id, t.plays]), [["a", 2], ["b", 1]]);
  assert.deepEqual(r.artists.map((x) => x.name), ["Sid Sriram", "Arijit Singh"]);
  assert.deepEqual(r.albums.map((x) => x.name), ["Album A"]);
  assert.deepEqual(r.counts, { tracks: 2, artists: 2, albums: 1 });
  assert.deepEqual(r.days.map((d) => d.date), ["2026-10-30", "2026-11-04", "2026-11-05"]);
  assert.equal(peakHour(r.hours), 8, "a listen counts in the hour it started");
  assert.deepEqual(biggestDay(r.days), { date: "2026-10-30", ms: 200_000 });
  assert.deepEqual(streaks(r.days), { active: 3, longest: 2 });
  assert.equal(activityDays("week", r.days, new Date(now)).length, 7, "the week chart shows seven days");
});

test("streaks run across month ends and daylight-saving changes; quiet hours have no peak", () => {
  const day = (date, ms = 60_000) => ({ date, ms });
  assert.deepEqual(streaks([day("2026-10-30"), day("2026-10-31"), day("2026-11-01"), day("2026-11-03")]), { active: 4, longest: 3 });
  assert.deepEqual(streaks([day("2026-03-07"), day("2026-03-08"), day("2026-03-09")]), { active: 3, longest: 3 });
  assert.deepEqual(streaks([day("2026-11-01", 0)]), { active: 0, longest: 0 });
  assert.equal(peakHour(new Array(24).fill(0)), null);
  assert.equal(biggestDay([]), null);
});

test("cover colours turn poster-bright: same hue, richer, greys stay grey", async () => {
  const { vividRgb } = await import("../.test-build/replay-format.mjs");
  assert.equal(vividRgb("128 128 128", 0.5, 0.4), "102 102 102", "a grey gets no invented hue");
  assert.equal(vividRgb("255 0 0", 0.5, 0.5), "255 0 0");
  const [r, g, b] = vividRgb("120 100 90", 0.55, 0.38).split(" ").map(Number);
  assert.ok(r > g && g > b && r - b >= 70, `a dusty brown comes out a rich warm tone: ${r} ${g} ${b}`);
  assert.equal(vividRgb("not a colour", 0.5, 0.4), "102 102 102", "junk in, a neutral grey out");
});

test("a shared credit counts for every artist on it; a band the catalogue knows stays whole", () => {
  assert.deepEqual(creditNames("Luis Fonsi & Daddy Yankee"), ["Luis Fonsi", "Daddy Yankee"]);
  assert.deepEqual(creditNames("Anirudh Ravichander, Arijit Singh & Shilpa Rao"), ["Anirudh Ravichander", "Arijit Singh", "Shilpa Rao"]);
  assert.deepEqual(creditNames("Drake feat. Rihanna"), ["Drake", "Rihanna"]);
  assert.deepEqual(creditNames("Daft Punk"), ["Daft Punk"], "no 'ft' split inside a name");
  assert.deepEqual(creditNames("Florence + the Machine"), ["Florence + the Machine"]);

  const min = 60_000;
  const lines = [
    { name: "Luis Fonsi & Daddy Yankee", thumb: "t/dy", ms: 10 * min, plays: 5 },
    { name: "Tame Impala", thumb: "t/ti", ms: 8 * min, plays: 3 },
    { name: "Daddy Yankee", ms: 3 * min, plays: 1 },
    { name: "Mumford & Sons", ms: 2 * min, plays: 1 },
  ];
  const credited = creditArtists(lines, new Set(["mumford & sons"]));
  assert.deepEqual(
    credited.map((a) => [a.name, a.ms / min, a.plays]),
    [["Daddy Yankee", 13, 6], ["Luis Fonsi", 10, 5], ["Tame Impala", 8, 3], ["Mumford & Sons", 2, 1]],
    "each artist on the line gets its full time, added to their own lines"
  );
  assert.equal(credited.find((a) => a.name === "Luis Fonsi").thumb, undefined, "a shared line's photo isn't anyone's in particular");
  assert.equal(credited.find((a) => a.name === "Tame Impala").thumb, "t/ti");
  assert.deepEqual(creditArtists(lines).map((a) => a.name).slice(-2), ["Mumford", "Sons"], "unchecked, a band splits like any credit");

  const now = new Date(2026, 10, 5, 15, 0).getTime();
  const song = { id: "d", title: "Despacito", artist: "Luis Fonsi & Daddy Yankee", duration: 228, thumb: "t/d" };
  const week = journalReplay([{ track: song, at: now - 60_000, heard: 200, out: "done" }], now);
  assert.equal(week.counts.artists, 2, "the week counts artists the way the list shows them");
});

test("a streak lives through today until a day passes without music; the longest run keeps its dates", async () => {
  const { streakNow, shiftDay } = await import("../.test-build/replay-format.mjs");
  const day = (date, ms = 60_000) => ({ date, ms });
  const today = new Date(2026, 10, 3, 15, 0); // Tue 3 Nov 2026
  const october = Array.from({ length: 12 }, (_, i) => day(`2026-10-${String(10 + i).padStart(2, "0")}`));

  const waiting = streakNow([...october, day("2026-11-01"), day("2026-11-02")], today);
  assert.deepEqual(waiting, { current: 2, today: false, best: 12, bestFrom: "2026-10-10", bestTo: "2026-10-21" }, "yesterday's streak is still alive today");
  assert.equal(streakNow([day("2026-11-01"), day("2026-11-02"), day("2026-11-03")], today).current, 3, "today's listening adds to it");
  assert.equal(streakNow([day("2026-11-01")], today).current, 0, "a whole quiet day ends it");
  assert.equal(streakNow([day("2026-11-02"), day("2026-11-03", 0)], today).current, 1, "a zero-minute day isn't a listening day");

  const tie = streakNow([day("2026-10-01"), day("2026-10-02"), day("2026-11-02"), day("2026-11-03")], today);
  assert.deepEqual([tie.best, tie.bestFrom, tie.bestTo], [2, "2026-11-02", "2026-11-03"], "on a tie, the latest run is the one to beat");
  assert.deepEqual(streakNow([], today), { current: 0, today: false, best: 0, bestFrom: null, bestTo: null });

  assert.equal(shiftDay("2026-03-08", 1), "2026-03-09", "across a daylight-saving change");
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
  assert.equal(streakNow([day("2026-10-31"), day("2026-11-01"), day("2026-11-02")], today).current, 3, "across a month end");
});

test("the calendar: whole weeks from the locale's first weekday, days ahead marked, the rest blank", async () => {
  const { calendarWeeks, periodRange } = await import("../.test-build/replay-format.mjs");
  const now = new Date(2026, 10, 3, 15, 0); // Tue 3 Nov 2026
  assert.deepEqual(periodRange("month", now), { from: "2026-11-01", to: "2026-11-30" });
  assert.deepEqual(periodRange("lastMonth", now), { from: "2026-10-01", to: "2026-10-31" });
  assert.deepEqual(periodRange("week", now), { from: "2026-10-28", to: "2026-11-03" });
  assert.deepEqual(periodRange("year", now), { from: "2026-01-01", to: "2026-12-31" });
  assert.deepEqual(periodRange("all", now), { from: "2025-11-04", to: "2026-11-03" });

  const days = [{ date: "2026-11-01", ms: 3_480_000 }, { date: "2026-11-02", ms: 600_000 }];
  const monday = calendarWeeks("2026-11-01", "2026-11-30", days, "2026-11-03", 1);
  assert.equal(monday.length, 6, "Mon Oct 26 to Sun Dec 6");
  assert.ok(monday.every((w) => w.length === 7));
  assert.deepEqual(monday[0].slice(0, 6), [null, null, null, null, null, null], "the days before the 1st are blank");
  assert.deepEqual(monday[0][6], { date: "2026-11-01", ms: 3_480_000, ahead: false }, "Sunday the 1st closes a Monday week");
  assert.deepEqual(monday[1][1], { date: "2026-11-03", ms: 0, ahead: false }, "today, quiet so far");
  assert.equal(monday[1][2].ahead, true, "tomorrow is still to come");
  assert.deepEqual(monday[5].slice(1), [null, null, null, null, null, null], "after the 30th is blank");
  const sunday = calendarWeeks("2026-11-01", "2026-11-30", days, "2026-11-03", 0);
  assert.equal(sunday[0][0].date, "2026-11-01", "a Sunday week starts on the 1st");
  assert.equal(sunday.length, 5);
});
