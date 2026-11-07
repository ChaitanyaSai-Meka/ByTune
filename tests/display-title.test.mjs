import test from "node:test";
import assert from "node:assert/strict";
import { shortTitle, titleSource, titleStep } from "../.test-build/format.mjs";

test("on screen, a song's title drops the film or series it comes from", () => {
  const cases = [
    ["Popular (From The Idol Vol. 1 (Music from the HBO Original Series)) (feat. Playboi Carti)", "Popular (feat. Playboi Carti)", "The Idol Vol. 1"],
    ['Aaya Sher (From "The Paradise") (Telugu)', "Aaya Sher (Telugu)", "The Paradise"],
    ['Baguntundhi Nuvvu Navvithe (From "Atithi Devobhava")', "Baguntundhi Nuvvu Navvithe", "Atithi Devobhava"],
    ["Lose My Mind [From F1® The Movie] (feat. Doja Cat)", "Lose My Mind (feat. Doja Cat)", "F1® The Movie"],
    ['Formula (From "Euphoria: Season 1" Soundtrack)', "Formula", "Euphoria: Season 1"],
    ['Ishq Jalakar - Karvaan (From "Dhurandhar")', "Ishq Jalakar - Karvaan", "Dhurandhar"],
    ['Naatu Naatu - From "RRR"', "Naatu Naatu", "RRR"],
    ['Hukum – From “Jailer”', "Hukum", "Jailer"],
    ["Shallow (From A Star Is Born)", "Shallow", "A Star Is Born"],
  ];
  for (const [full, short, source] of cases) {
    assert.equal(shortTitle(full), short, full);
    assert.equal(titleSource(full), source, full);
  }
});

test("video labels go too; credits, language and versions stay", () => {
  assert.equal(shortTitle("Kesariya (Official Video)"), "Kesariya");
  assert.equal(shortTitle("Blinding Lights (Official Music Video)"), "Blinding Lights");
  assert.equal(shortTitle("Levitating [Official Lyric Video]"), "Levitating");
  assert.equal(shortTitle("Srivalli (Lyrical) (Telugu)"), "Srivalli (Telugu)");
  assert.equal(shortTitle("Starboy (Full Video Song)"), "Starboy");
  for (const kept of [
    "One Kiss x I Was Never There (slowed + reverb)",
    "Never Say Never (Single Version) (feat. Jaden)",
    "Dancing With A Stranger (with Normani) (Bonus Track)",
    "No Church In The Wild (feat. Frank Ocean & The-Dream)",
    "Hotel California (Live) (2013 Remaster)",
    "Main Theme (Soundtrack Version)",
    "Fromage (Remix)",
    "Ocean's Eleven",
  ]) {
    assert.equal(shortTitle(kept), kept, kept);
    assert.equal(titleSource(kept), null, kept);
  }
});

test("a title that is nothing but a tag keeps its words; junk stays safe", () => {
  assert.equal(shortTitle('(From "Hridayam")'), '(From "Hridayam")');
  assert.equal(shortTitle("Unclosed (From the start"), "Unclosed (From the start");
  assert.equal(shortTitle(""), "");
  assert.equal(shortTitle("  Spaced   Out  (Official Video) "), "Spaced Out");
});

test("page titles step down in size as names grow, so the whole name fits", () => {
  assert.equal(titleStep("Starboy"), 0);
  assert.equal(titleStep("Black Panther The Album Music From"), 1);
  assert.equal(titleStep("Black Panther The Album Music From And Inspired By (Deluxe Edition)"), 2);
});
