import test from "node:test";
import assert from "node:assert/strict";
import { parseTtml } from "../.test-build/lyrics.mjs";

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
