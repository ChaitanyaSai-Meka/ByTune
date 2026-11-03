/**
 * M4A tag writer — title, artist, album and cover go into the file as
 * iTunes-style moov/udta/meta/ilst items, where Windows, iTunes, phones and
 * other players look for them. No ffmpeg and no tagging dependency.
 *
 * Only moov is rebuilt; every other byte is copied through. moov changes size,
 * so the absolute file offsets that point past it move by the same amount:
 * stco/co64 chunk offsets (moov before mdat), tfhd base_data_offset and mfra's
 * tfra moof offsets (fragmented files). Relative offsets (sidx, trun data
 * offsets from the moof) move with their data and are left alone.
 */
import * as fs from "fs";

export interface M4aTags {
  title: string;
  artist: string;
  album?: string;
  cover?: { data: Uint8Array; mime: "image/jpeg" | "image/png" };
}

interface Box {
  type: string;
  start: number;
  header: number;
  end: number;
}

/** The items this writer owns: always rewritten from the tags, so an omitted album or cover drops the old one. */
const OWNED = new Set(["©nam", "©ART", "©alb", "covr"]);

/** hdlr that marks a meta box as iTunes metadata ("appl" in the first reserved word, as iTunes writes it). */
const HDLR_MDIR = box("hdlr", u32(0), u32(0), Buffer.from("mdirappl", "latin1"), u32(0), u32(0), Buffer.alloc(1));

export function tagM4a(file: Uint8Array, tags: M4aTags): Uint8Array {
  const buf = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (buf.length < 8 || fourcc(buf, 4) !== "ftyp") throw new Error("Not an MP4/M4A file (no ftyp box)");
  const moovs = readBoxes(buf, 0, buf.length).filter((b) => b.type === "moov");
  if (moovs.length !== 1) throw new Error(`Unsupported MP4: expected one moov box, found ${moovs.length}`);
  const moov = moovs[0];

  const kids = children(buf, moov);
  const udta = kids.find((b) => b.type === "udta");
  const newUdta = buildUdta(buf, udta, tags);
  const parts = kids.map((b) => (b === udta ? newUdta : buf.subarray(b.start, b.end)));
  const newMoov = box("moov", ...parts, ...(udta ? [] : [newUdta]));

  const out = Buffer.concat([buf.subarray(0, moov.start), newMoov, buf.subarray(moov.end)]);
  shiftOffsets(out, moov.end, newMoov.length - (moov.end - moov.start));
  return out;
}

/** Tags the file in place: the result goes to a temp file renamed over the song, so a crash leaves the old one whole. */
export async function writeM4aTags(path: string, tags: M4aTags): Promise<void> {
  const tagged = tagM4a(await fs.promises.readFile(path), tags);
  const tmp = `${path}.tagging`;
  try {
    const fh = await fs.promises.open(tmp, "w");
    try {
      await fh.writeFile(tagged);
      await fh.sync(); // on disk before the rename, or a power cut could swap in an empty file
    } finally {
      await fh.close();
    }
    await fs.promises.rename(tmp, path);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** udta with our meta in place of any old iTunes meta; its other children are kept byte for byte. */
function buildUdta(buf: Buffer, udta: Box | undefined, tags: M4aTags): Buffer {
  const parts: Buffer[] = [];
  const keptItems: Buffer[] = [];
  let metaAt = -1;
  for (const b of udta ? children(buf, udta) : []) {
    const items = itunesItems(buf, b);
    if (!items) {
      parts.push(buf.subarray(b.start, b.end));
      continue;
    }
    if (metaAt < 0) metaAt = parts.length;
    for (const item of items) if (!OWNED.has(item.type)) keptItems.push(buf.subarray(item.start, item.end));
  }

  const items = [item("©nam", 1, Buffer.from(tags.title)), item("©ART", 1, Buffer.from(tags.artist))];
  if (tags.album) items.push(item("©alb", 1, Buffer.from(tags.album)));
  if (tags.cover) items.push(item("covr", tags.cover.mime === "image/png" ? 14 : 13, tags.cover.data));
  const meta = box("meta", Buffer.alloc(4), HDLR_MDIR, box("ilst", ...items, ...keptItems));
  parts.splice(metaAt < 0 ? parts.length : metaAt, 0, meta);
  return box("udta", ...parts);
}

/** The ilst items of an iTunes metadata box (a meta whose hdlr is mdir), or null for any other udta child. */
function itunesItems(buf: Buffer, b: Box): Box[] | null {
  if (b.type !== "meta") return null;
  // ISO meta is a full box (version/flags before its children); QuickTime's isn't.
  const at = b.start + b.header;
  const kids = readBoxes(buf, fourcc(buf, at + 4) === "hdlr" ? at : at + 4, b.end);
  const hdlr = kids[0];
  if (hdlr?.type !== "hdlr" || fourcc(buf, body(hdlr, 12) + 8) !== "mdir") return null;
  const ilst = kids.find((k) => k.type === "ilst");
  return ilst ? children(buf, ilst) : [];
}

/** An ilst item: one data box whose type says how to read the value (1 UTF-8, 13 JPEG, 14 PNG), locale 0. */
function item(type: string, dataType: number, value: Uint8Array): Buffer {
  return box(type, box("data", u32(dataType), u32(0), value));
}

/** Adds `delta` to every absolute file offset at or past `from`, the old end of moov. */
function shiftOffsets(buf: Buffer, from: number, delta: number): void {
  if (delta === 0) return;
  const shift = (at: number, wide: boolean) => {
    const value = wide ? Number(buf.readBigUInt64BE(at)) : buf.readUInt32BE(at);
    if (value < from) return;
    if (wide) buf.writeBigUInt64BE(BigInt(value + delta), at);
    else buf.writeUInt32BE(value + delta, at); // throws rather than wrapping past 4 GB
  };
  const top = readBoxes(buf, 0, buf.length);

  for (const b of find(buf, top, ["moov", "trak", "mdia", "minf", "stbl"]).flatMap((stbl) => children(buf, stbl))) {
    // saio outside a fragment holds absolute offsets too; encrypted audio isn't worth supporting.
    if (b.type === "saio") throw new Error("Unsupported MP4: sample auxiliary info offsets (encrypted audio)");
    if (b.type !== "stco" && b.type !== "co64") continue;
    const width = b.type === "co64" ? 8 : 4;
    const p = body(b, 8);
    const count = buf.readUInt32BE(p + 4);
    body(b, 8 + count * width);
    for (let i = 0; i < count; i++) shift(p + 8 + i * width, width === 8);
  }

  for (const tfhd of find(buf, top, ["moof", "traf", "tfhd"])) {
    if (buf.readUInt32BE(body(tfhd, 4)) & 1) shift(body(tfhd, 16) + 8, true);
  }

  for (const tfra of find(buf, top, ["mfra", "tfra"])) {
    const p = body(tfra, 16);
    const wide = buf[p] === 1;
    const sizes = buf.readUInt32BE(p + 8);
    // time and moof_offset, then traf, trun and sample numbers of 1-4 bytes each
    const entry = (wide ? 16 : 8) + 3 + ((sizes >> 4) & 3) + ((sizes >> 2) & 3) + (sizes & 3);
    const count = buf.readUInt32BE(p + 12);
    body(tfra, 16 + count * entry);
    for (let i = 0; i < count; i++) shift(p + 16 + i * entry + (wide ? 8 : 4), wide);
  }
}

/** The boxes that tile buf[from, to); anything that doesn't tile exactly is refused. */
function readBoxes(buf: Buffer, from: number, to: number): Box[] {
  const boxes: Box[] = [];
  for (let pos = from; pos < to; ) {
    if (to - pos < 8) throw new Error(`Malformed MP4: stray bytes at ${pos}`);
    let size = buf.readUInt32BE(pos);
    let header = 8;
    if (size === 1) {
      header = 16;
      size = to - pos >= 16 ? Number(buf.readBigUInt64BE(pos + 8)) : 0;
    } else if (size === 0) {
      size = to - pos; // runs to the end of its parent
    }
    const type = fourcc(buf, pos + 4);
    if (size < header || size > to - pos) throw new Error(`Malformed MP4: bad size for "${type}" box at ${pos}`);
    boxes.push({ type, start: pos, header, end: pos + size });
    pos += size;
  }
  return boxes;
}

function children(buf: Buffer, b: Box): Box[] {
  return readBoxes(buf, b.start + b.header, b.end);
}

/** Boxes at `path` below `boxes`, e.g. ["moof", "traf", "tfhd"] from the top level. */
function find(buf: Buffer, boxes: Box[], [type, ...rest]: string[]): Box[] {
  const hits = boxes.filter((b) => b.type === type);
  return rest.length ? find(buf, hits.flatMap((b) => children(buf, b)), rest) : hits;
}

/** Where a box's payload starts, after checking it holds `need` bytes (so a bad count can't patch a neighbour). */
function body(b: Box, need: number): number {
  if (b.end - b.start - b.header < need) throw new Error(`Malformed MP4: "${b.type}" box is too short`);
  return b.start + b.header;
}

function box(type: string, ...parts: Uint8Array[]): Buffer {
  const out = Buffer.concat([Buffer.alloc(8), ...parts]);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, "latin1");
  return out;
}

function u32(n: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(n);
  return out;
}

function fourcc(buf: Buffer, at: number): string {
  return buf.toString("latin1", at, at + 4);
}
