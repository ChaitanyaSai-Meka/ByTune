import test from "node:test";
import assert from "node:assert/strict";
import { visibleLyricLines } from "../.test-build/lyrics-lines.mjs";

const line = (time, text, extra = {}) => ({ time, text, ...extra });

test("head credits go, mid-song (…) lines stay, [labels] go anywhere", () => {
  const shown = visibleLyricLines([
    line(0, "Lyrics by Someone"),
    line(1, "(Intro vocals)"),
    line(2, "", { gap: true }),
    line(5, "First real line"),
    line(9, "[Chorus]"),
    line(10, "(Ooh, ooh)"),
    line(12, "[I mean it] said the bridge"),
  ]);
  assert.deepEqual(
    shown.map((l) => [l.time, l.text]),
    [
      [2, ""],
      [5, "First real line"],
      [10, "(Ooh, ooh)"],
      [12, "[I mean it] said the bridge"],
    ],
  );
});
