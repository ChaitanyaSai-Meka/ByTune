import test from "node:test";
import assert from "node:assert/strict";
import { embeddedLrc, kugouLines, namesRecording, pickLrcRedHit, pickLrcRedRow, takeInPriorityOrder } from "../.test-build/lyrics.mjs";

const q = (title, artist = "") => ({ title, artist });

test("a catalogue entry names the playing recording: same song, same version words, a shared artist", () => {
  const yes = [
    ["Baby (feat. Ludacris)", "Justin Bieber", q("Baby", "Justin Bieber")],
    ["Despacito", "Luis Fonsi、Daddy Yankee", q("Despacito ft. Daddy Yankee", "Luis Fonsi")],
    ["Despacito (feat. Justin Bieber) [Remix]", "Luis Fonsi, Daddy Yankee", q("Despacito (Remix) (feat. Justin Bieber)", "Luis Fonsi & Daddy Yankee")],
    ['Kesariya (From "Brahmastra")', "Pritam, Arijit Singh, Amitabh Bhattacharya", q("Kesariya", "Arijit Singh")],
    ["Bohemian Rhapsody (Remastered 2011)", "Queen", q("Bohemian Rhapsody", "Queen")],
    ["Bohemian Rhapsody - 2011 Remaster", "Queen", q("Bohemian Rhapsody", "Queen")],
    ["HUMBLE. (Explicit)", "Kendrick Lamar", q("HUMBLE.", "Kendrick Lamar")],
    ["Kesariya (Slowed and Reverb)", "Pritam, Arijit Singh", q("Kesariya (Slowed + Reverb)", "Arijit Singh")],
    // Translations in brackets, accents, Traditional vs Simplified Chinese.
    ["Échame La Culpa (把错都推给我吧)", "Luis Fonsi、Demi Lovato", q("Échame La Culpa", "Luis Fonsi & Demi Lovato")],
    ["봄날 (Spring Day)", "BTS", q("Spring Day", "BTS")],
    ["Señorita", "Shawn Mendes & Camila Cabello", q("Senorita", "Shawn Mendes")],
    ["告白气球", "周杰伦", q("告白氣球", "周杰倫")],
    // An "Artist - Song" upload with no credit of its own.
    ["Shape of You", "Ed Sheeran", q("Ed Sheeran - Shape of You (Official Music Video)", "Unknown artist")],
    // Someone else's "Artist - Song" upload, with nothing but labels after the song.
    ["Wake Me Up", "Avicii (Ft. Aloe Blacc)", q("Avicii - Wake Me Up (Lyrics)", "7clouds")],
    ["Seven", "Jung Kook & Latto", q("Jung Kook (정국) - Seven (Lyrics) ft. Latto", "Lyrical Genius")],
    ["Dynamite", "BTS", q("BTS - Dynamite (Lyrics)", "Cakes & Eclairs")],
    ["Despacito", "Luis Fonsi, Daddy Yankee", q("Luis Fonsi - Despacito (Letra/Lyrics) ft. Daddy Yankee", "Unique Sound")],
    ["告白气球", "周杰伦", q("周杰倫 - 告白氣球 歌詞", "音樂歌詞MusicLyrics")],
    ["Video Games", "Lana Del Rey", q("Lana Del Rey - Video Games (Lyrics)", "Lana Del Rey")],
    ["Gangnam Style", "PSY", q("PSY - GANGNAM STYLE(강남스타일) M/V", "officialpsy")],
    // A bracket's names: a credit, or the same artist in another script.
    ["벚꽃 엔딩", "Busker Busker", q("벚꽃 엔딩", "버스커 버스커 (Busker Busker)")],
    ["Chaleya", "Anirudh Ravichander (Ft. Arijit Singh & Shilpa Rao)", q("Chaleya", "Arijit Singh & Shilpa Rao")],
    ["Queencard", "(G)I-DLE", q("Queencard", "i-dle")],
    // Traditional and Simplified Chinese with no character in common, and Japanese forms.
    ["后来", "刘若英", q("後來", "劉若英")],
    ["轨迹", "周杰伦", q("軌跡", "周杰倫")],
    ["龙卷风", "周杰伦", q("龍捲風", "周杰倫")],
    ["为什么你背着我爱别人", "许志安", q("為什麼你背著我愛別人", "許志安")],
    ["奇迹", "张宇", q("奇蹟", "張宇")],
    ["灶门炭治郎のうた", "椎名豪", q("竈門炭治郎のうた", "椎名豪")],
    ["说好不哭", "周杰伦", q("說好不哭", "周杰倫 和 五月天 阿信")],
    ["爱着你", "陈奕迅", q("愛著你", "陳奕迅")],
    ["千本樱", "初音ミク", q("千本桜", "初音ミク")],
    // Labels, not versions: nested brackets, release tags, one kind of version in other words.
    ["Waka Waka", "Shakira", q("Waka Waka (This Time for Africa) [The Official 2010 FIFA World Cup (TM) Song] (feat. Freshlyground)", "Shakira")],
    ["So What (Main Version - Clean)", "P!nk", q("So What", "P!NK")],
    ["Hold Tight (Single Version)", "Justin Bieber", q("Hold Tight", "Justin Bieber")],
    ["大鱼", "周深", q("大魚（唱片版）", "周深")],
    ["Boy With Luv (Japanese Version)", "BTS", q("Boy With Luv (Japanese ver.)", "BTS")],
    ["Song (Live Version)", "Band", q("Song (Live)", "Band")],
    ["Song (Live in Concert)", "Band", q("Song (En Vivo)", "Band")],
    ["小幸运 (演唱会版)", "田馥甄", q("小幸運 (演唱會版)", "田馥甄")],
    ["Song (Lofi)", "Band", q("Song (Lo-Fi)", "Band")],
  ];
  for (const [name, artist, playing] of yes) assert.equal(namesRecording(name, artist, playing), true, `${name} for ${playing.title}`);

  const no = [
    ["Baby (Acoustic)", "Justin Bieber", q("Baby", "Justin Bieber")],
    ["Despacito (Versión Pop)", "Luis Fonsi", q("Despacito", "Luis Fonsi & Daddy Yankee")],
    ["Despacito 缓缓 (Mandarin Version)", "Luis Fonsi、林俊杰", q("Despacito", "Luis Fonsi")],
    ["Despacito (DJ Tech Supreme Hype Intro)", "Luis Fonsi、Daddy Yankee、Justin Bieber", q("Despacito ft. Daddy Yankee", "Luis Fonsi")],
    ["Despacito", "Luis Fonsi", q("Despacito (Remix) (feat. Justin Bieber)", "Luis Fonsi")],
    ["Bohemian Rhapsody (Live Aid - Remastered)", "Queen", q("Bohemian Rhapsody", "Queen")],
    ["Shape Of You (Live At Yokohama Arena)", "Ed Sheeran/ONE OK ROCK", q("Shape of You", "Ed Sheeran")],
    ["Love Story", "Taylor Swift", q("Love Story (Taylor's Version)", "Taylor Swift")],
    ["Stay (feat. Mikky Ekko)", "Rihanna", q("Stay", "Kygo")],
    ["Hello", "Adele", q("Hello", "Pritam, Shaan & Sunidhi Chauhan")],
    ["晴天", "周杰伦", q("彩虹", "周杰倫")],
    // Another singer whose name shares a character; another song that shares one.
    ["爱你", "王贰浪", q("愛你", "王心凌")],
    ["当你", "王心凌", q("愛你", "王心凌")],
    // A bracket that describes the credit names nobody.
    ["벚꽃 엔딩", "Jane Doe (Busker Busker Cover)", q("벚꽃 엔딩", "버스커 버스커 (Busker Busker)")],
    ["Hello", "Sing2Piano (Originally Performed by Adele)", q("Hello", "Adele")],
    ["Sunday", "Jason (5)", q("Sunday", "Maroon 5")],
    // Someone else's upload that is another recording: a tutorial, a slowed edit, a festival set, a loop.
    ["Believer", "Imagine Dragons", q("Imagine Dragons - Believer | Piano tutorial | Sheets", "PianoX")],
    ["Hello", "Adele", q("adele - hello ( s l o w e d )", "lunatic")],
    ["Someone You Loved", "Lewis Capaldi", q("Lewis Capaldi - Someone You Loved (Glastonbury 2019)", "BBC Music")],
    ["Wake Me Up", "Avicii", q("Avicii - Wake Me Up ft. Aloe Blacc - Glastonbury 2019", "BBC Music")],
    ["Wake Me Up", "Avicii", q("Avicii - Wake Me Up ft. Aloe Blacc - Piano Tutorial", "PianoX")],
    ["Perfect", "Ed Sheeran", q("[ 1 HOUR ] Ed Sheeran - Perfect (Lyrics)", "SoulLines")],
    ["Despacito (Remix)", "Luis Fonsi, Daddy Yankee, Justin Bieber", q("Luis Fonsi - Despacito (Letra/Lyrics) ft. Daddy Yankee", "Unique Sound")],
    ["Dynamite", "Taio Cruz", q("BTS - Dynamite (Lyrics)", "Cakes & Eclairs")],
    ["告白气球", "周杰伦", q("周杰倫 - 告白氣球 (钢琴版)", "PianoCat")],
    // Versions that differ by their qualifier, or in another language's words.
    ["Bailando (English Version)", "Enrique Iglesias", q("Bailando (Spanish Version)", "Enrique Iglesias")],
    ["红日 (粤语版)", "李克勤", q("红日 (国语版)", "李克勤")],
    ["大鱼 (DJ版)", "周深", q("大魚（唱片版）", "周深")],
    ["Seven (feat. Latto) [Band Ver.]", "Jung Kook", q("Seven - Explicit Ver. (feat. Latto)", "Jung Kook")],
    ["Corazón partío (Maqueta)", "Alejandro Sanz", q("Corazón partío", "Alejandro Sanz")],
    ["Bailar Pegados (En Concierto)", "Sergio Dalma", q("Bailar Pegados", "Sergio Dalma")],
    ["Kisses (Lo-Fi)", "Band", q("Kisses", "Band")],
    ["Yellow", "Coldplay", q("Yellow (Coldplay) [Sped Up Version]", "Various Artists")],
  ];
  for (const [name, artist, playing] of no) assert.equal(namesRecording(name, artist, playing), false, `${name} for ${playing.title}`);
});

test("credits in scripts that can't be compared rest on the entry's own length; plain text ignores tempo", () => {
  const eason = { title: "孤勇者 (《英雄聯盟：雙城之戰》動畫劇集中文主題曲) - Warrior of the Darkness", artist: "Eason Chan", duration: 256 };
  assert.equal(namesRecording("孤勇者", "陈奕迅", eason, { length: 256 }), true);
  assert.equal(namesRecording("孤勇者", "陈奕迅", eason), false, "no length, nothing to stand in for the credit");
  const hongdou = { title: "红豆 (还没跟你牵着手)", artist: "Ran Yue", duration: 204 };
  assert.equal(namesRecording("红豆", "岳燃", hongdou, { length: 203 }), true);
  assert.equal(namesRecording("红豆", "半吨兄弟", hongdou, { length: 197 }), false, "another singer's version, 7 s off");

  const sped = q("Yellow (Coldplay) [Sped Up Version]", "Various Artists");
  assert.equal(namesRecording("Yellow", "Coldplay", sped, { plainText: true }), true, "Genius's page reads the same words");
  assert.equal(namesRecording("Lose Yourself", "Eminem", q("Lose Yourself (Instrumental) [Slowed]", "Eminem"), { plainText: true }), false);
});

test("a music video takes the identify step's recording at the album length; nothing else runs long", () => {
  const hello = [
    { isrc: "GBBKS1500214", track_name: "Hello", artist_name: "Adele", duration: "295.5", timing_type: "word", lyricsUrl: "https://lrc.red/s/GBBKS1500214.ttml" },
  ];
  const pick = (playing) => pickLrcRedRow(hello, playing)?.isrc ?? null;
  assert.equal(pick({ title: "Hello (Official Music Video)", artist: "Adele", duration: 367 }), "GBBKS1500214");
  assert.equal(pick({ title: "Hello", artist: "Adele", duration: 297 }), "GBBKS1500214");
  assert.equal(pick({ title: "Hello", artist: "Adele", album: "25", duration: 367 }), null, "a catalogue song keeps the 3 s rule");
  assert.equal(pick({ title: "Hello (Official Music Video)", artist: "Unknown artist", duration: 367 }), null, "no credit, no stretch");
  assert.equal(pick({ title: "Hello (Official Music Video)", artist: "Adele", duration: 60 }), null, "nothing repairs a shorter clip");
  assert.equal(pick({ title: "Hello (Live)", artist: "Adele", duration: 367 }), null);
});

test("the playing release's own entry answers for its title track: Despacito (Versión Pop)", () => {
  const playing = { title: "Despacito", artist: "Luis Fonsi", album: "Despacito (Versión Pop)", duration: 229 };
  const pop = {
    isrc: "USUM71700112", track_name: "Despacito (Versión Pop)", artist_name: "Luis Fonsi", album_name: "Despacito (Versión Pop) - Single",
    duration: "229", timing_type: "line", lyricsUrl: "https://lrc.red/s/USUM71700112.ttml",
  };
  assert.equal(pickLrcRedRow([pop], playing)?.isrc, "USUM71700112");
  assert.equal(pickLrcRedRow([pop], { ...playing, album: "Despacito (Remixes)" }), null, "another release lends no version");
  const hits = [
    { isrc: "USUM71607007", title: "Despacito", artist: "Luis Fonsi, Daddy Yankee", album: "VIDA", duration: 229.5 },
    { isrc: "USUM71704567", title: "Despacito 缓缓 (Mandarin Version)", artist: "Luis Fonsi, JJ Lin", album: "Despacito 缓缓 - Single", duration: 229 },
    { isrc: "USUM71700112", title: "Despacito (Versión Pop)", artist: "Luis Fonsi", album: "Despacito (Versión Pop) - Single", duration: 229 },
  ];
  assert.equal(pickLrcRedHit(hits, playing)?.isrc, "USUM71700112", "not the original from VIDA");
  assert.equal(pickLrcRedHit(hits, { ...playing, album: "VIDA" })?.isrc, "USUM71607007");
});

test("a local file's own timed lyrics answer; untimed text doesn't", () => {
  const line = embeddedLrc("[00:01.00]Hello\n[00:03.50]World");
  assert.deepEqual([line?.source, line?.wordSynced, line?.synced?.map((l) => l.text)], ["this file", false, ["Hello", "World"]]);
  assert.equal(embeddedLrc("[00:01.00]<00:01.00>Hel<00:01.40>lo\n[00:03.00]<00:03.00>World")?.wordSynced, true);
  assert.equal(embeddedLrc("Hello\nWorld"), null);
  assert.equal(embeddedLrc("[00:00.00]Hello\n[00:00.00]World"), null, "every stamp at 0:00 is untimed text");
});

test("lrc.red keeps BitChord's 3-second rule, prefers the playing album, and needs a length or a credit", () => {
  const row = (isrc, track_name, duration, extra = {}) => ({
    isrc, track_name, artist_name: "Queen", duration: String(duration), timing_type: "word", lyricsUrl: `https://lrc.red/s/${isrc}.ttml`, ...extra,
  });
  const bohemian = [row("GBUM71029604", "Bohemian Rhapsody (Remastered 2011)", 356.5), row("GBCEG0100046", "Bohemian Rhapsody (Live Aid)", 352)];
  const pick = (rows, playing) => pickLrcRedRow(rows, playing)?.isrc ?? null;
  assert.equal(pick(bohemian, { title: "Bohemian Rhapsody", artist: "Queen", duration: 352 }), null, "the live cut is not the studio song, and 4.5 s is too far");
  assert.equal(pick(bohemian, { title: "Bohemian Rhapsody", artist: "Queen", duration: 355 }), "GBUM71029604");
  const releases = [
    row("GBUM71100001", "Under Pressure", 248, { album_name: "Under Pressure - Single", timing_type: "line" }),
    row("GBUM71100002", "Under Pressure", 248, { album_name: "Hot Space", timing_type: "line" }),
  ];
  assert.equal(pick(releases, { title: "Under Pressure", artist: "Queen", duration: 248, album: "Hot Space" }), "GBUM71100002");
  assert.equal(pick(bohemian, { title: "Bohemian Rhapsody", artist: "Unknown artist", duration: 0 }), null, "a name alone is not a recording");
});

test("a KuGou file must not name another recording, and its name line, credits and notices are not lyrics", () => {
  const original = [
    "[ti:Despacito]", "[ar:Luis Fonsi]",
    "[00:00.00]Luis Fonsi、Daddy Yankee - Despacito", "[00:01.00]作词：Luis Fonsi", "[00:02.00]作曲：Erika Ender",
    "[00:10.00]Ay", "[00:12.00]Fonsi", "[00:14.00]DY",
  ].join("\n");
  const playing = { id: "x", title: "Despacito", artist: "Luis Fonsi & Daddy Yankee", duration: 229 };
  assert.deepEqual(kugouLines(original, playing, true)?.map((l) => l.text), ["Ay", "Fonsi", "DY"]);

  const djEdit = ["[ti:Shape Of You (PULLER & Calgos Remix)]", "[ar:PULLER]", "[00:00.50]Shape of You (DJ PULLER版) - Puller/Ed Sheeran", "[00:10.00]The club isn't the best place"].join("\n");
  assert.equal(kugouLines(djEdit, { id: "y", title: "Shape of You", artist: "Ed Sheeran", duration: 234 }, false), null);

  assert.equal(kugouLines("[00:00.00]纯音乐，请欣赏", playing, false), null, "the pure-music notice");
  const unnamed = "[00:10.00]Hello\n[00:12.00]World";
  assert.equal(kugouLines(unnamed, playing, true), null, "an unchecked keyword hit must name itself");
  assert.equal(kugouLines(unnamed, playing, false)?.length, 2);
});

test("lrc.red's search: free-text hits are matched, not trusted in order (BitChord's rule)", () => {
  const hit = (isrc, title, duration, artist = "Queen", album = "") => ({ isrc, title, artist, duration, album });
  const hits = [
    hit("GBUM71029605", "Bohemian Rhapsody (Operatic Section / 2011 A Cappella Mix)", 120.4),
    hit("GBCEG0100046", "Bohemian Rhapsody (Live Aid)", 352.0),
    hit("GBUM71029604", "Bohemian Rhapsody (Remastered 2011)", 356.5),
    hit("../search", "Bohemian Rhapsody", 355.0),
  ];
  const pick = (playing) => pickLrcRedHit(hits, playing)?.isrc ?? null;
  assert.equal(pick({ title: "Bohemian Rhapsody", artist: "Queen", duration: 355 }), "GBUM71029604", "skips the a cappella mix the search ranks first, and a bad code");
  assert.equal(pick({ title: "Bohemian Rhapsody", artist: "Queen", duration: 352 }), null, "a live cut close in length is still not the studio recording");
  assert.equal(pick({ title: "Bohemian Rhapsody (Live Aid)", artist: "Queen", duration: 352 }), "GBCEG0100046");
  assert.equal(pick({ title: "Bohemian Rhapsody", artist: "Panic! At The Disco", duration: 355 }), null, "the same title by somebody else");
  assert.equal(pick({ title: "Bohemian Rhapsody", artist: "Unknown artist", duration: 0 }), null);
});

test("answers are taken in priority order, the way BitChord's loop takes them", async () => {
  const later = (value, ms) => () => new Promise((resolve) => setTimeout(() => resolve(value), ms));
  const timed = (source, word = false) => ({ source, wordSynced: word, lines: [{ time: 1, text: "la" }] });
  const plain = (source) => ({ source, wordSynced: false, lines: [], plainText: "la" });
  const none = [false, false, false];

  // A slower source above beats a quicker one below.
  let { pick } = await takeInPriorityOrder([later(timed("top"), 60), later(timed("below", true), 5)], [false, false], false, 1000);
  assert.equal(pick.source, "top");

  // BitChord's default: the first timed answer wins, word or line timing.
  ({ pick } = await takeInPriorityOrder([later(null, 5), later(timed("line"), 10), later(timed("word", true), 5)], none, false, 1000));
  assert.equal(pick.source, "line");
  // Preferring word timing, the line answer is only the fallback.
  ({ pick } = await takeInPriorityOrder([later(null, 5), later(timed("line"), 10), later(timed("word", true), 5)], none, true, 1000));
  assert.equal(pick.source, "word");

  // Plain text waits for every timed source; a lazy source runs only when nothing at all answered.
  let asked = false;
  const genius = () => { asked = true; return Promise.resolve(plain("genius")); };
  ({ pick } = await takeInPriorityOrder([later(plain("tab"), 5), later(timed("kugou"), 30), genius], [false, false, true], false, 1000));
  assert.equal(pick.source, "kugou");
  assert.equal(asked, false);
  ({ pick } = await takeInPriorityOrder([later(null, 5), later(null, 5), genius], [false, false, true], false, 1000));
  assert.equal(pick.source, "genius");
  assert.equal(asked, true);

  // A source that never answers is passed over at the ceiling.
  ({ pick } = await takeInPriorityOrder([() => new Promise(() => {}), later(timed("next"), 5)], [false, false], false, 80));
  assert.equal(pick.source, "next");
});
