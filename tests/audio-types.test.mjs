/**
 * The one table of audio files ByTune plays (electron/audio-types.ts), and the two lists that must
 * repeat it outside the code: macOS's document types in package.json and the Windows installer's
 * "Open with" entries in build/installer.nsh.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { PLAYABLE_AUDIO, audioMime, isKnownAudio, isPlayableAudio, unplayableFormat } from "../.test-build/audio-types.mjs";

const playable = Object.keys(PLAYABLE_AUDIO).map((e) => e.slice(1)).sort();

test("what plays, and what is only recognised to say why it can't", () => {
  for (const f of ["a.mp3", "b.M4A", "c.flac", "d.opus", "e.webm", "f.wav", "g.ogg", "h.aac"]) assert.equal(isPlayableAudio(f), true, f);
  for (const f of ["a.wma", "b.aiff", "c.txt", "d", "e.mp4", "f.alac"]) assert.equal(isPlayableAudio(f), false, f);
  assert.equal(isKnownAudio("song.WMA"), true, "an unplayable format is still one the scan names");
  assert.equal(isKnownAudio("notes.txt"), false);
  assert.equal(audioMime("x.opus"), "audio/ogg");
  assert.equal(audioMime("x.m4a"), "audio/mp4");
});

test("unplayable formats are named by extension, and ALAC by its codec inside .m4a", () => {
  assert.equal(unplayableFormat("a.wma"), "WMA");
  assert.equal(unplayableFormat("a.aif"), "AIFF");
  assert.equal(unplayableFormat("a.aifc"), "AIFF");
  assert.equal(unplayableFormat("a.m4a", "alac"), "ALAC");
  assert.equal(unplayableFormat("a.m4a", "mpeg-4/aac"), null);
  assert.equal(unplayableFormat("a.mp3"), null);
});

test("macOS document types list exactly the files ByTune plays, offered but never claimed as default", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const [docs] = pkg.build.mac.extendInfo.CFBundleDocumentTypes;
  assert.deepEqual([...docs.CFBundleTypeExtensions].sort(), playable);
  assert.equal(docs.LSHandlerRank, "Alternate");
  assert.equal(pkg.build.nsis.include, "build/installer.nsh");
});

test("the Windows installer offers Open with for exactly those files, without taking their default", () => {
  const nsh = fs.readFileSync(new URL("../build/installer.nsh", import.meta.url), "utf8");
  const listed = [...nsh.matchAll(/!insertmacro \$\{MACRO\} "([a-z0-9]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, playable);
  // Only OpenWithProgids under each extension: writing the extension key's own default would take it over.
  assert.doesNotMatch(nsh, /Software\\Classes\\\.\$\{EXT\}" ""/);
});
