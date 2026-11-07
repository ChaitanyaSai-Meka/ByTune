import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseBuffer } from "music-metadata";
import { tagM4a, writeM4aTags } from "../.test-build/m4a-tags.mjs";

// Made once with ffmpeg 9 from a 1.5 s 440 Hz tone, AAC 64 kbps (tests never need ffmpeg):
//   faststart.m4a         -movflags +faststart, moov first. Two interleaved audio tracks (66 chunks each)
//                         plus a chapter text track; udta holds a chpl and an old ©nam/©alb/©too.
//   moov-last.m4a         ffmpeg's default: mdat, then moov.
//   dash.m4a              +frag_keyframe+empty_moov+default_base_moof+dash+global_sidx: sidx, moof/mdat, mfra.
//   frag-base-offset.m4a  +frag_keyframe+empty_moov: every tfhd carries an absolute base_data_offset.
const fixture = (name) => readFileSync(new URL(`./fixtures/m4a/${name}`, import.meta.url));
const JPEG = { data: fixture("cover.jpg"), mime: "image/jpeg" };
const PNG = { data: fixture("cover.png"), mime: "image/png" };
const TAGS = { title: "Halo Drive", artist: "ByTune", album: "Fixtures" };

const tag = (input, tags = TAGS) => Buffer.from(tagM4a(input, tags));

// A reader of our own, so the checks don't trust the code under test.
function boxes(buf, from = 0, to = buf.length) {
  const out = [];
  for (let pos = from; pos < to; ) {
    let size = buf.readUInt32BE(pos);
    let body = pos + 8;
    if (size === 1) [size, body] = [Number(buf.readBigUInt64BE(pos + 8)), pos + 16];
    else if (size === 0) size = to - pos;
    out.push({ type: buf.toString("latin1", pos + 4, pos + 8), start: pos, body, end: pos + size });
    pos += size;
  }
  return out;
}

const childrenOf = (buf, b) => boxes(buf, b.type === "meta" ? b.body + 4 : b.body, b.end);
const bytes = (buf, b) => buf.subarray(b.start, b.end);

/** Boxes at a path from the top level, e.g. find(buf, "moof", "traf", "tfhd"). */
function find(buf, ...path) {
  let level = boxes(buf).filter((b) => b.type === path[0]);
  for (const type of path.slice(1)) level = level.flatMap((b) => childrenOf(buf, b)).filter((b) => b.type === type);
  return level;
}

function chunkOffsets(buf) {
  return find(buf, "moov", "trak", "mdia", "minf", "stbl", "stco").flatMap((b) =>
    Array.from({ length: buf.readUInt32BE(b.body + 4) }, (_, i) => buf.readUInt32BE(b.body + 8 + 4 * i)),
  );
}

function baseOffsets(buf) {
  return find(buf, "moof", "traf", "tfhd")
    .filter((b) => buf.readUInt32BE(b.body) & 1)
    .map((b) => Number(buf.readBigUInt64BE(b.body + 8)));
}

function tfraOffsets(buf) {
  return find(buf, "mfra", "tfra").flatMap((b) => {
    // ffmpeg writes version 1 (64-bit time and offset) with 1-byte traf/trun/sample numbers: 19-byte entries
    assert.equal(buf[b.body], 1);
    assert.equal(buf.readUInt32BE(b.body + 8), 0);
    return Array.from({ length: buf.readUInt32BE(b.body + 12) }, (_, i) => Number(buf.readBigUInt64BE(b.body + 24 + 19 * i)));
  });
}

/** Where each fragment's samples start: its base (tfhd base_data_offset, else the moof) plus trun's data_offset. */
function sampleStarts(buf) {
  return find(buf, "moof").map((moof) => {
    const traf = childrenOf(buf, moof).find((b) => b.type === "traf");
    const tfhd = childrenOf(buf, traf).find((b) => b.type === "tfhd");
    const trun = childrenOf(buf, traf).find((b) => b.type === "trun");
    const base = buf.readUInt32BE(tfhd.body) & 1 ? Number(buf.readBigUInt64BE(tfhd.body + 8)) : moof.start;
    return base + buf.readInt32BE(trun.body + 8);
  });
}

/** The audio as a demuxer finds it: every mdat/sidx whole, and the bytes behind every stored offset. */
function audio(buf) {
  const at = (offsets) => offsets.map((o) => buf.toString("hex", o, o + 32));
  return {
    boxes: boxes(buf).filter((b) => b.type === "mdat" || b.type === "sidx").map((b) => bytes(buf, b)),
    chunks: at(chunkOffsets(buf)),
    fragments: at(sampleStarts(buf)),
    tfra: at(tfraOffsets(buf)),
  };
}

async function readTags(buf) {
  const { common, native } = await parseBuffer(buf, { mimeType: "audio/mp4" });
  const picture = common.picture?.[0];
  return {
    title: common.title,
    artist: common.artist,
    album: common.album,
    cover: picture && { data: Buffer.from(picture.data), mime: picture.format },
    items: native.iTunes.map((t) => t.id),
  };
}

test("moov before mdat: every stco entry of every track moves with the audio", async () => {
  const before = fixture("faststart.m4a");
  const pristine = Buffer.from(before);
  const after = tag(before);
  assert.deepEqual(before, pristine, "the input is left alone");

  const delta = after.length - before.length;
  assert.ok(delta > 0);
  assert.equal(chunkOffsets(before).length, 66 + 66 + 1);
  assert.deepEqual(chunkOffsets(after), chunkOffsets(before).map((o) => o + delta));
  assert.deepEqual(audio(after), audio(before));

  // The old title and album are replaced; the encoder item and the udta's chapter list stay.
  assert.deepEqual(await readTags(after), { ...TAGS, cover: undefined, items: ["©nam", "©ART", "©alb", "©too"] });
  assert.deepEqual(find(after, "moov", "udta").flatMap((b) => childrenOf(after, b)).map((b) => b.type), ["meta", "chpl"]);
  assert.deepEqual(bytes(after, find(after, "moov", "udta", "chpl")[0]), bytes(before, find(before, "moov", "udta", "chpl")[0]));
});

test("moov after mdat: no offset changes, and a file without udta gets one", async () => {
  const src = fixture("moov-last.m4a");
  const moov = boxes(src).at(-1);
  assert.equal(moov.type, "moov");
  // Dropping udta from a moov that ends the file moves nothing else: an untagged file, like a raw download.
  const udta = childrenOf(src, moov).find((b) => b.type === "udta");
  const bare = Buffer.concat([src.subarray(0, udta.start), src.subarray(udta.end)]);
  bare.writeUInt32BE(moov.end - moov.start - (udta.end - udta.start), moov.start);
  assert.equal(find(bare, "moov", "udta").length, 0);

  for (const before of [src, bare]) {
    const after = tag(before);
    assert.deepEqual(after.subarray(0, moov.start), before.subarray(0, moov.start));
    assert.deepEqual(chunkOffsets(after), chunkOffsets(before));
    assert.deepEqual(audio(after), audio(before));
    assert.deepEqual(await readTags(after), { ...TAGS, cover: undefined, items: ["©nam", "©ART", "©alb"] });
  }
});

test("fragmented DASH (default-base-is-moof): sidx, moofs and mdats untouched, tfra re-pointed", async () => {
  const before = fixture("dash.m4a");
  const after = tag(before);
  const delta = after.length - before.length;

  const untouched = (buf) => boxes(buf).filter((b) => b.type !== "moov" && b.type !== "mfra").map((b) => bytes(buf, b));
  assert.deepEqual(untouched(after), untouched(before));
  assert.deepEqual(boxes(after).map((b) => b.type), boxes(before).map((b) => b.type));
  assert.equal(baseOffsets(before).length, 0);
  assert.deepEqual(tfraOffsets(after), tfraOffsets(before).map((o) => o + delta));
  assert.deepEqual(tfraOffsets(after), find(after, "moof").map((b) => b.start));
  assert.deepEqual(audio(after), audio(before));
  assert.deepEqual(await readTags(after), { ...TAGS, cover: undefined, items: ["©nam", "©ART", "©alb"] });
});

test("fragmented with tfhd base_data_offset: every base moves with its moof", async () => {
  const before = fixture("frag-base-offset.m4a");
  const after = tag(before);
  const delta = after.length - before.length;

  assert.equal(baseOffsets(before).length, 3);
  assert.deepEqual(baseOffsets(after), baseOffsets(before).map((o) => o + delta));
  assert.deepEqual(baseOffsets(after), find(after, "moof").map((b) => b.start));
  assert.deepEqual(tfraOffsets(after), find(after, "moof").map((b) => b.start));
  assert.deepEqual(audio(after), audio(before));
  assert.deepEqual(await readTags(after), { ...TAGS, cover: undefined, items: ["©nam", "©ART", "©alb"] });
});

test("re-tagging replaces our items without a second udta, meta or ilst", async () => {
  for (const [name, kept] of [["faststart.m4a", ["©too"]], ["dash.m4a", []]]) {
    const original = fixture(name);
    const once = tag(original, { ...TAGS, cover: JPEG });
    assert.deepEqual(tag(once, { ...TAGS, cover: JPEG }), once, "same tags again change nothing");

    const twice = tag(once, { title: "Second Title", artist: "Second Artist", cover: PNG });
    for (const path of [["moov", "udta"], ["moov", "udta", "meta"], ["moov", "udta", "meta", "ilst"]]) {
      assert.equal(find(twice, ...path).length, 1, `${name}: one ${path.join("/")}`);
    }
    assert.deepEqual(await readTags(twice), {
      title: "Second Title",
      artist: "Second Artist",
      album: undefined,
      cover: PNG,
      items: ["©nam", "©ART", "covr", ...kept],
    });
    assert.deepEqual(audio(twice), audio(original));
  }
});

test("covers: JPEG is written as data type 13, PNG as 14", async () => {
  for (const cover of [JPEG, PNG]) {
    const after = tag(fixture("moov-last.m4a"), { ...TAGS, cover });
    assert.deepEqual((await readTags(after)).cover, cover);
    const [covr] = find(after, "moov", "udta", "meta", "ilst", "covr");
    const [data] = childrenOf(after, covr);
    assert.equal(after.readUInt32BE(data.body), cover === PNG ? 14 : 13);
  }
});

test("without an album no ©alb is written, and an old one is dropped", async () => {
  const after = tag(fixture("faststart.m4a"), { title: "No Album", artist: "Someone" });
  assert.deepEqual(await readTags(after), {
    title: "No Album",
    artist: "Someone",
    album: undefined,
    cover: undefined,
    items: ["©nam", "©ART", "©too"],
  });
});

test("Telugu, Hindi and Japanese titles round-trip as UTF-8", async () => {
  for (const [title, artist, album] of [
    ["నా పాట", "గాయని", "తెలుగు పాటలు"],
    ["मेरा गीत", "गायिका", "हिंदी गाने"],
    ["夜の歌", "歌手", "アルバム"],
  ]) {
    const tags = await readTags(tag(fixture("dash.m4a"), { title, artist, album }));
    assert.deepEqual([tags.title, tags.artist, tags.album], [title, artist, album]);
  }
});

test("64-bit box sizes and a last box that runs to the end of the file", async () => {
  const src = fixture("faststart.m4a");
  const [free, mdat] = boxes(src).slice(-2);
  assert.deepEqual([free.type, free.end - free.start, mdat.type], ["free", 8, "mdat"]);
  // ffmpeg's 8-byte free box before mdat is room for a 64-bit mdat header; every offset stays valid.
  const wide = Buffer.from(src);
  wide.writeUInt32BE(1, free.start);
  wide.write("mdat", free.start + 4, "latin1");
  wide.writeBigUInt64BE(BigInt(mdat.end - free.start), free.start + 8);
  const toEnd = Buffer.from(src);
  toEnd.writeUInt32BE(0, mdat.start);

  for (const before of [wide, toEnd]) {
    const after = tag(before);
    assert.deepEqual(chunkOffsets(after), chunkOffsets(before).map((o) => o + after.length - before.length));
    assert.deepEqual(audio(after), audio(before));
    assert.equal((await readTags(after)).title, TAGS.title);
  }
});

test("anything that isn't an MP4 it understands is refused, not rewritten", () => {
  assert.throws(() => tagM4a(Buffer.alloc(0), TAGS), /not an mp4/i);
  assert.throws(() => tagM4a(Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x0aTIT2"), TAGS), /not an mp4/i);
  assert.throws(() => tagM4a(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]), TAGS), /not an mp4/i);
  const song = fixture("dash.m4a");
  assert.throws(() => tagM4a(song.subarray(0, song.length - 100), TAGS), /malformed/i);
  assert.throws(() => tagM4a(song.subarray(0, boxes(song)[0].end), TAGS), /one moov box, found 0/);
});

test("writeM4aTags swaps the tagged file in and leaves a file it can't tag alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bytune-m4a-"));
  try {
    const song = join(dir, "song.m4a");
    writeFileSync(song, fixture("dash.m4a"));
    await writeM4aTags(song, { ...TAGS, cover: JPEG });
    assert.deepEqual(readdirSync(dir), ["song.m4a"]);
    assert.deepEqual(readFileSync(song), tag(fixture("dash.m4a"), { ...TAGS, cover: JPEG }));

    writeFileSync(song, "not audio");
    await assert.rejects(writeM4aTags(song, TAGS), /not an mp4/i);
    assert.equal(readFileSync(song, "utf8"), "not audio");
    assert.deepEqual(readdirSync(dir), ["song.m4a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
