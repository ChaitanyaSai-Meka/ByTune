/**
 * The song matcher (electron/track-match.ts) against real YouTube Music Songs searches
 * (tests/fixtures/match/yt-songs.json): the right recording wins over covers, karaoke rows,
 * live takes and dubs; nothing is better than the wrong song.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { artistNames, bestMatch, languageOf, searchQueries, similarity, titleWords, versionMarks } from "../.test-build/track-match.mjs";

const { searches } = JSON.parse(readFileSync(new URL("./fixtures/match/yt-songs.json", import.meta.url), "utf8"));
const rows = (q) => {
  assert.ok(searches[q], `fixture has "${q}"`);
  return searches[q];
};
const pick = (target, q, prefer) => {
  const hit = bestMatch(target, rows(q), prefer);
  return hit ? `${hit.title} | ${hit.artist} | ${hit.album ?? ""}` : null;
};

test("the original, not covers, karaoke rows or a different song with the same first word", () => {
  assert.equal(pick({ title: "Yellow", artist: "Coldplay", duration: 266 }, "Yellow Coldplay"), "Yellow | Coldplay | Parachutes");
  assert.equal(
    pick({ title: "Bohemian Rhapsody - Remastered 2011", artist: "Queen", album: "A Night At The Opera (2011 Remaster)", duration: 355 }, "Bohemian Rhapsody Queen"),
    "Bohemian Rhapsody | Queen | A Night At The Opera",
  );
  assert.equal(pick({ title: "Loser", artist: "Tame Impala", duration: 223 }, "Loser Tame Impala")?.split(" | ")[1], "Tame Impala");
});

test("packaging differs between catalogues and still matches", () => {
  // Spotify: "Clarity", Zedd + Foxes. YouTube: "Clarity (feat. Foxes)", Zedd.
  assert.equal(pick({ title: "Clarity", artist: "Zedd, Foxes", duration: 271 }, "Clarity Zedd"), "Clarity (feat. Foxes) | Zedd | Clarity");
  assert.match(
    pick({ title: 'Kesariya (From "Brahmastra")', artist: "Pritam, Arijit Singh, Amitabh Bhattacharya", duration: 268 }, "Kesariya Arijit Singh"),
    /^Kesariya \(From "Brahmastra"\).* \| Arijit Singh \|/,
  );
  assert.equal(pick({ title: "Samajavaragamana", artist: "Thaman S, Sid Sriram", duration: 220 }, "Samajavaragamana Sid Sriram"), "Samajavaragamana | Sid Sriram | Ala Vaikunthapurramuloo");
});

test("a version must agree both ways", () => {
  assert.equal(pick({ title: "Yellow - Live at Glastonbury", artist: "Coldplay", duration: 280 }, "Yellow Coldplay"), null, "no live take in the results: nothing");
  assert.equal(pick({ title: "Samajavaragamana (cover)", artist: "Curry" }, "Samajavaragamana Sid Sriram"), "Samajavaragamana (cover) | Curry | Samajavaragamana (cover)");
  assert.equal(versionMarks("Urike Urike - Chill Lofi"), "lofi");
  assert.equal(versionMarks("Song (Lo-Fi Flip) [Slowed + Reverb]"), "lofi reverb slowed");
  assert.equal(versionMarks("Bohemian Rhapsody - Remastered 2011"), "");
});

test("a dub with the same title and length is not the song", () => {
  // The Telugu "Srivalli" (Sid Sriram) isn't in these results; the Hindi one (Javed Ali) is, same title, same length.
  assert.equal(pick({ title: "Srivalli", artist: "Sid Sriram, Devi Sri Prasad", duration: 224 }, "Srivalli Sid Sriram"), null);
  assert.equal(pick({ title: "Srivalli", artist: "Sid Sriram, Devi Sri Prasad", duration: 224 }, "Srivalli Sid Sriram Telugu"), null);
  assert.equal(pick({ title: "Srivalli", artist: "Javed Ali, Devi Sri Prasad", duration: 225 }, "Srivalli Javed Ali"), "Srivalli | Javed Ali | Pushpa The Rise Part - 01");
});

test("the language preference picks between versions and falls back to the best overall", () => {
  const rowdy = { title: "Rowdy Baby", artist: "Dhanush, Yuvan Shankar Raja", duration: 282 };
  assert.match(pick(rowdy, "Rowdy Baby Dhanush"), /Maari 2 \(Original/, "no preference: the first full match");
  assert.match(pick(rowdy, "Rowdy Baby Dhanush", "telugu"), /Maari 2 \[Telugu\]/);
  assert.match(pick(rowdy, "Rowdy Baby Dhanush", "hindi"), /Maari 2 \(Original/, "no Hindi version: the best overall");
  // The song's own words beat the preference.
  assert.match(pick({ ...rowdy, album: "Maari 2 [Telugu]" }, "Rowdy Baby Dhanush", "tamil"), /\[Telugu\]/);
  assert.equal(languageOf("Pushpa 2 The Rule - Hindi"), "hindi");
  assert.equal(languageOf("UNDEAD (English Version)"), "english");
  assert.equal(languageOf("Telugucentral"), null);
});

test("non-Latin titles keep their letters and match", () => {
  assert.equal(pick({ title: "夜に駆ける", artist: "YOASOBI", duration: 261 }, "夜に駆ける YOASOBI"), "夜に駆ける | YOASOBI | 夜に駆ける");
  assert.equal(titleWords("సామజవరగమన (From \"Ala Vaikunthapurramuloo\")"), "సామజవరగమన");
  assert.equal(titleWords("केसरिया - From \"Brahmastra\""), "केसरिया");
  assert.ok(similarity("केसरिया", "केसरिया") === 1 && similarity("సామజవరగమన", "సామజవరగమనా") > 0.85);
});

test("artists are split, folded and compared without spaces or dots", () => {
  assert.deepEqual(artistNames("A. R. Rahman, Shreya Ghoshal & Sonu Nigam"), ["arrahman", "shreyaghoshal", "sonunigam"]);
  assert.deepEqual(artistNames("AR Rahman feat. Tanvi Shah"), ["arrahman", "tanvishah"]);
  assert.deepEqual(artistNames("Dhanush x Dhee"), ["dhanush", "dhee"]);
});

test("a song with no artist (a pasted title) matches on title and length", () => {
  assert.equal(pick({ title: "Yellow", artist: "", duration: 267 }, "Yellow Coldplay"), "Yellow | Coldplay | Parachutes");
});

test("search queries drop the packaging and keep the version", () => {
  assert.deepEqual(searchQueries({ title: "Yellow - Live at Glastonbury", artist: "Coldplay" }), ["Yellow live Coldplay", "Yellow live"]);
  assert.deepEqual(searchQueries({ title: 'Kesariya (From "Brahmastra")', artist: "Pritam, Arijit Singh" }), ["Kesariya Pritam", "Kesariya"]);
  assert.deepEqual(searchQueries({ title: "Clarity", artist: "" }), ["Clarity"]);
});
