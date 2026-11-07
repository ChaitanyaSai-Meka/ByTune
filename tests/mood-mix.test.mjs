import test from "node:test";
import assert from "node:assert/strict";
import { buildMix, isUploadTitle } from "../.test-build/moodMix.mjs";

let n = 0;
const t = (title, artist) => ({ id: `id${String(n++).padStart(9, "0")}`, title, artist, duration: 200, thumb: "" });
const titles = (mix) => mix.map((x) => x.title);

test("the mix takes the playlists in turns, so no one list leads", () => {
  const a = [t("A1", "Ann"), t("A2", "Ann")];
  const b = [t("B1", "Bob"), t("B2", "Bob")];
  const c = [t("C1", "Cy")];
  assert.deepEqual(titles(buildMix([a, b, c])), ["A1", "B1", "C1", "A2", "B2"]);
});

test("one copy of each recording, its video and lyric cuts included", () => {
  const a = [t("Srivalli", "Sid Sriram")];
  const b = [t("Srivalli (Official Video)", "Sid Sriram"), t("Saami Saami", "Mounika Yadav")];
  assert.deepEqual(titles(buildMix([a, b])), ["Srivalli", "Saami Saami"]);
});

test("at most three songs per artist, and never a video upload", () => {
  const a = Array.from({ length: 6 }, (_, i) => t(`Song ${i}`, "Thaman S"));
  const b = [t("Maala Lyrical Video - Aadarsha Kutumbam", "Aditya Music"), t("Ruku Ruku Rukmini | Alias Rukmini | Nithiin", "Saregama"), t("Godari Gattu", "Ramana Gogula")];
  // Turns go by position: Godari Gattu is third in its list, so it comes after the third round.
  assert.deepEqual(titles(buildMix([a, b])), ["Song 0", "Song 1", "Song 2", "Godari Gattu"]);
  assert.equal(isUploadTitle("Video Games"), false, "a song merely named with the word stays");
  assert.equal(isUploadTitle("Oo Antava (Full Video Song)"), true);
});

test("the mix stops at its size, and an episode never joins it", () => {
  const long = Array.from({ length: 100 }, (_, i) => t(`T${i}`, `Artist ${i}`));
  assert.equal(buildMix([long]).length, 60);
  assert.equal(buildMix([long], 5).length, 5);
  assert.deepEqual(buildMix([[{ ...t("Ep 1", "Show"), episode: true }]]), []);
  assert.deepEqual(buildMix([]), []);
});
