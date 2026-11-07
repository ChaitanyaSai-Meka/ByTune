// Whole lookups through fetchLyrics with the network replaced: every host answers from the table below, anything
// else is a 404. Its own file, so the stand-in fetch never reaches another test.
import test from "node:test";
import assert from "node:assert/strict";
import { fetchLyrics } from "../.test-build/lyrics.mjs";

const ttml = (text) =>
  `<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1.0" end="3.0">${text}</p><p begin="4.0" end="6.0">${text} again</p></div></body></tt>`;
const SRIVALLI_ALBUM = 'Srivalli [From "Pushpa - The Rise (Part - 01)"] - Single';
const DOCS = { INA092117754: ttml("Ninu choosthu"), INA092117758: ttml("Naan paakkuraen") };

globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const p = url.searchParams;
  const reply = (body, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  const asks = (s) => `${p.get("q") ?? ""} ${p.get("track") ?? ""} ${p.get("song") ?? ""} ${p.get("track_name") ?? ""}`.includes(s);
  if (url.host === "lrc.red" && url.pathname === "/search.json" && asks("Srivalli")) {
    // lrc.red's search answers first, its four language releases tied on every test; the Tamil one leads.
    return reply({
      hits: [
        { isrc: "INA092117758", title: "Srivalli", artist: "Sid Sriram", album: SRIVALLI_ALBUM, duration: 221 },
        { isrc: "INA092117754", title: 'Srivalli [From "Pushpa - The Rise (Part - 01)"]', artist: "Sid Sriram, Devi Sri Prasad", album: SRIVALLI_ALBUM, duration: 221 },
      ],
    });
  }
  if (url.host === "lyrics-api.binimum.org" && asks("Srivalli")) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return reply({
      results: [
        { isrc: "INA092117754", track_name: 'Srivalli [From "Pushpa - The Rise (Part - 01)"]', artist_name: "Sid Sriram, Devi Sri Prasad", album_name: SRIVALLI_ALBUM, duration: "221", timing_type: "line", lyricsUrl: "https://lrc.red/s/INA092117754.ttml" },
        { isrc: "INA092117758", track_name: "Srivalli", artist_name: "Sid Sriram", album_name: SRIVALLI_ALBUM, duration: "221", timing_type: "line", lyricsUrl: "https://lrc.red/s/INA092117758.ttml" },
      ],
    });
  }
  const doc = /^\/s\/([A-Z0-9]+)\.ttml$/.exec(url.pathname);
  if (url.host === "lrc.red" && doc && DOCS[doc[1]]) return reply(DOCS[doc[1]]);
  if (url.host === "unison.boidu.dev" && asks("Quiet Song")) {
    return reply({ success: true, data: { song: p.get("song"), artist: "Test Artist", format: "lrc", syncType: "linesync", lyrics: "[00:00.00]Instrumental only" } });
  }
  if (url.host === "lrclib.net" && url.pathname === "/api/get" && p.get("track_name") === "Quiet Song") {
    return reply({ trackName: "Quiet Song", artistName: "Test Artist", duration: 200, syncedLyrics: "[00:01.00]one\n[00:02.00]two\n[00:03.00]three" });
  }
  if (url.host === "lrclib.net" && url.pathname === "/api/get" && p.get("track_name") === "Ponni Nadhi") {
    return reply({ trackName: "Ponni Nadhi", artistName: "A.R. Rahman", duration: 300, plainLyrics: "only words", syncedLyrics: null });
  }
  if (url.host === "lrclib.net" && url.pathname === "/api/search" && p.get("track_name") === "Ponni Nadhi") {
    return reply([{ trackName: "Ponni Nadhi", artistName: "A.R. Rahman", duration: 301, syncedLyrics: "[00:01.00]x\n[00:02.00]y\n[00:03.00]z" }]);
  }
  if (url.host === "lyrics-api.boidu.dev" && url.pathname === "/qq/getLyrics" && p.get("s") === "벚꽃 엔딩") {
    // QQ's cache answers with another song's file: no "Title - Artist" opening line, still sung after this track ends.
    return reply("[ti:孤星泪]\n[ar:刘德华]\n[00:19.30]孤星泪 刘德华\n[00:30.00]我是一滴远方孤星的泪水\n[04:26.30]藏在你身上已几万年");
  }
  if (url.host === "lrclib.net" && url.pathname === "/api/get" && p.get("track_name") === "벚꽃 엔딩") {
    return reply({ trackName: "벚꽃 엔딩", artistName: "Busker Busker", duration: 261, syncedLyrics: "[00:20.00]그대여 그대여 그대여 그대여\n[00:25.00]오늘은 우리 같이 걸어요 이 거리를" });
  }
  // BetterLyrics' keyless cache knows each song under the credit BitChord asked with; anything else is uncached.
  if (url.host === "lyrics-api.boidu.dev" && url.pathname === "/getLyrics") {
    const cached = { "Raataan Lambiyan": "Jubin Nautiyal, Tanishk Bagchi, Asees Kaur", "The Boxer": "Simon & Garfunkel" };
    if (cached[p.get("s")] === p.get("a")) return reply({ ttml: ttml(`${p.get("s")} line`) });
    return reply({ error: "API key required" }, 401);
  }
  return reply("", 404);
};

const lookUp = (q) => fetchLyrics({ album: "", duration: 0, ...q }, { prioritizeWordSync: false }, {});

test("lrc.red takes the recording identify named before its own search's pick (BitChord's order)", async () => {
  const found = await lookUp({ id: "txHO7PLGE3o", title: "Srivalli (feat. Allu Arjun, Rashmika Mandanna)", artist: "Sid Sriram", album: "Pushpa - The Rise", duration: 221 });
  assert.equal(found?.source, "lrc.red");
  assert.equal(found?.synced?.[0]?.text, "Ninu choosthu", "the Telugu release identify named, not the Tamil one the search listed first");
});

test("a file stamped all at 0:00 is untimed text: a timed source below it still wins", async () => {
  const found = await lookUp({ id: "zeroStamps01", title: "Quiet Song", artist: "Test Artist", duration: 200 });
  assert.equal(found?.source, "LRCLIB");
  assert.deepEqual(found?.synced?.map((l) => l.text), ["one", "two", "three"]);
  const alone = await lookUp({ id: "zeroStamps02", title: "Quiet Song Two", artist: "Test Artist", duration: 200 });
  assert.deepEqual([alone?.source, alone?.plain], ["Unison", "Instrumental only"], "and on its own it shows as plain text");
});

test("LRCLIB's exact plain-only record waits for a synced sibling the search finds", async () => {
  const found = await lookUp({ id: "plainGet01", title: "Ponni Nadhi", artist: "A.R. Rahman", duration: 300 });
  assert.equal(found?.source, "LRCLIB");
  assert.deepEqual(found?.synced?.map((l) => l.text), ["x", "y", "z"]);
});

test("a Portato file still sung after the track has ended is another song's: the next source answers", async () => {
  const found = await lookUp({ id: "KvthiAoGTfo", title: "벚꽃 엔딩", artist: "Busker Busker", duration: 261 });
  assert.equal(found?.source, "LRCLIB");
  assert.equal(found?.synced?.[0]?.text, "그대여 그대여 그대여 그대여");
});

test("BetterLyrics is asked with BitChord's list credit first, then YouTube's own (a band named with &)", async () => {
  const list = await lookUp({ id: "Dm6YRJHy64c", title: "Raataan Lambiyan", artist: "Jubin Nautiyal, Tanishk Bagchi & Asees Kaur", duration: 231 });
  assert.deepEqual([list?.source, list?.synced?.[0]?.text], ["BetterLyrics", "Raataan Lambiyan line"]);
  const band = await lookUp({ id: "l3LFML_pxlY", title: "The Boxer", artist: "Simon & Garfunkel", duration: 308 });
  assert.equal(band?.source, "BetterLyrics");
});
