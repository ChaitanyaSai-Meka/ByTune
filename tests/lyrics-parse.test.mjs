import test from "node:test";
import assert from "node:assert/strict";
import { parseTtml, pickLrcRedRow } from "../.test-build/lyrics.mjs";

// Apple Music shape: syllable spans, a background-vocal wrapper with no timing
// of its own, an inline translation, and a line that is only background vocals.
const APPLE = [
  '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div>',
  '<p begin="1.000" end="4.500" ttm:agent="v1"><span begin="1.000" end="1.400">Hel</span><span begin="1.400" end="1.900">lo </span><span begin="2.000" end="2.600">world</span><span ttm:role="x-bg"><span begin="3.000" end="3.500">(oh</span> <span begin="3.500" end="4.200">yeah)</span></span></p>',
  '<p begin="5.000" end="7.000"><span begin="5.000" end="5.500">Second</span> <span begin="5.600" end="6.000">line</span><span ttm:role="x-translation" xml:lang="es">segunda línea</span></p>',
  '<p begin="0:07.500" end="0:09.000"><span ttm:role="x-bg" begin="7.400" end="9.000"><span begin="7.500" end="8.000">(Ooh</span> <span begin="8.000" end="8.900">ooh)</span></span></p>',
  "</div></body></tt>",
].join("");

test("background vocals keep their own timing instead of corrupting the line", () => {
  const lines = parseTtml(APPLE);
  assert.equal(lines.length, 3);
  const [first] = lines;
  assert.equal(first.time, 1);
  assert.equal(first.end, 4.5);
  assert.equal(first.text, "Hello world");
  assert.deepEqual(
    first.words.map((w) => [w.text, w.start, w.end]),
    [
      ["Hello", 1, 1.9],
      ["world", 2, 2.6],
    ],
  );
  assert.equal(first.bg.text, "(oh yeah)", "background vocals are their own part");
  assert.deepEqual(
    first.bg.words.map((w) => [w.text, w.start, w.end]),
    [
      ["(oh", 3, 3.5],
      ["yeah)", 3.5, 4.2],
    ],
  );
});

test("romanized readings come through; singer tags change nothing", () => {
  const ttml = [
    '<tt xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal">',
    '<head><metadata><ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/><ttm:agent type="group" xml:id="v1000"/>',
    '<iTunesMetadata><transliterations><transliteration xml:lang="ko-Latn">',
    '<text for="L1"><span begin="1">saranghae</span></text><text for="L2">neoreul</text>',
    "</transliteration></transliterations></iTunesMetadata></metadata></head>",
    '<body><div><p begin="1" end="2" ttm:agent="v1" itunes:key="L1"><span begin="1" end="2">사랑해</span></p>',
    '<p begin="3" end="4" ttm:agent="v2" itunes:key="L2"><span begin="3" end="4">너를</span></p>',
    '<p begin="5" end="6" ttm:agent="v1000"><span begin="5" end="6">Together</span></p></div></body></tt>',
  ].join("");
  assert.deepEqual(
    parseTtml(ttml).map((l) => [l.text, l.roman ?? null, "voice" in l]),
    [
      ["사랑해", "saranghae", false],
      ["너를", "neoreul", false],
      ["Together", null, false],
    ],
  );
  const inline = parseTtml('<tt><body><p begin="1"><span begin="1" end="2">東京</span><span ttm:role="x-roman">Tokyo</span></p></body></tt>');
  assert.equal(inline[0].text, "東京");
  assert.equal(inline[0].roman, "Tokyo");
});

test("a timed background wrapper hands timing to its own syllables", () => {
  const bgOnly = parseTtml(APPLE)[2];
  assert.equal(bgOnly.time, 7.5);
  assert.equal(bgOnly.text, "(Ooh ooh)");
  assert.deepEqual(bgOnly.words.map((w) => w.start), [7.5, 8]);
});

test("inline translations stay out of the sung line", () => {
  const second = parseTtml(APPLE)[1];
  assert.equal(second.text, "Second line");
  assert.equal(second.words.length, 2);
});

test("a line break between two timed words still separates them", () => {
  const [l] = parseTtml(
    '<tt><body><p begin="1" end="3"><span begin="1" end="1.4">one </span><span begin="1.4" end="2">two</span><br/><span begin="2" end="2.6">three</span></p></body></tt>',
  );
  assert.deepEqual(l.words.map((w) => w.text), ["one", "two", "three"]);
});

test("line-synced TTML with untimed spans keeps the line's own start", () => {
  const lines = parseTtml(
    '<tt><body><p begin="10.000" end="12.000"><span>Plain line &amp; more</span></p><p begin="12.5"><span>Next</span></p></body></tt>',
  );
  assert.deepEqual(
    lines.map((l) => [l.time, l.text, l.words]),
    [
      [10, "Plain line & more", undefined],
      [12.5, "Next", undefined],
    ],
  );
  assert.equal(lines[0].end, 12);
});

// lrc.red ranks on runtime alone; these rows are real answers it gave.
const row = (isrc, track_name, artist_name, duration, timing_type) => ({
  isrc,
  track_name,
  artist_name,
  duration: String(duration),
  timing_type,
  lyricsUrl: `https://lrc.red/s/${isrc}.ttml`,
});
const BABY_ROWS = [
  row("USUM71027043", "Baby (Acoustic)", "Justin Bieber", 215, "line"),
  row("USUM71001767", "Baby", "Justin Bieber", 217, "line"),
  row("USUM70919263", "Baby (feat. Ludacris)", "Justin Bieber", 217, "word"),
  row("US23A9124065", "Baby (feat. Ludacris) [Mixed]", "Justin Bieber", 137, "none"),
  row("USUM71007621", "Baby (Chipmunk Remix) [feat. Chipmunk]", "Justin Bieber", 222, "line"),
];
const DESPACITO_ROWS = [
  row("USUM71713833", "Despacito (Mandarin Version) [feat. JJ Lin]", "Luis Fonsi", 229, "line"),
  row("USUM71705955", "Despacito (Versión Portugués)", "Luis Fonsi, Israel Novaes", 228, "line"),
  row("USUM71607007", "Despacito", "Luis Fonsi, Daddy Yankee", 230, "word"),
  row("USUM71703825", "Despacito (feat. Justin Bieber) [Remix]", "Luis Fonsi, Daddy Yankee", 231, "word"),
];

test("lrc.red: the playing recording wins over a closer-running rendition", () => {
  const pick = (rows, title, artist, duration) => pickLrcRedRow(rows, { title, artist, duration })?.isrc ?? null;
  assert.equal(pick(BABY_ROWS, "Baby (feat. Ludacris)", "Justin Bieber, Ludacris", 215), "USUM70919263");
  assert.equal(pick(BABY_ROWS, "Baby", "Justin Bieber", 215), "USUM70919263");
  assert.equal(pick(BABY_ROWS, "Justin Bieber - Baby ft. Ludacris", "Justin Bieber", 218), "USUM70919263");
  assert.equal(pick(BABY_ROWS, "Baby (Acoustic)", "Justin Bieber", 215), "USUM71027043");
  assert.equal(pick(DESPACITO_ROWS, "Despacito (feat. Daddy Yankee)", "Luis Fonsi", 229), "USUM71607007");
  assert.equal(pick(DESPACITO_ROWS, "Despacito", "Daddy Yankee", 229), "USUM71607007");
  // Words from the playing song only: another artist, another length or no timed words is no answer.
  assert.equal(pick(BABY_ROWS, "Baby", "Glee Cast", 215), null);
  assert.equal(pick(BABY_ROWS, "Baby", "Justin Bieber", 137), null);
  assert.equal(pick([row("INS172203702", "Kesariya (From \"Brahmastra\")", "Pritam, Arijit Singh", 268, "word")], "Kesariya", "Arijit Singh", 268), "INS172203702");
  assert.equal(pick([row("INS172412993", "Kesariya (Slowed and Reverb)", "Pritam, Arijit Singh", 284, "none")], "Kesariya (Slowed and Reverb)", "Arijit Singh", 284), null);
});

test("TTML times in seconds, milliseconds and clock forms all read", () => {
  const doc = [
    '<tt xmlns="http://www.w3.org/ns/ttml"><body><div>',
    '<p begin="12.5s" end="13.5s">one</p>',
    '<p begin="800ms" end="1200ms">two</p>',
    '<p begin="02:39" end="02:41">three</p>',
    '<p begin="1:3.188" end="1:4">four</p>',
    "</div></body></tt>",
  ].join("");
  const times = Object.fromEntries(parseTtml(doc).map((l) => [l.text, l.time]));
  assert.deepEqual(times, { one: 12.5, two: 0.8, three: 159, four: 63.188 });
});
