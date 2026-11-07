import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";

// The shipped icons broke twice: PNGs written with a bad CRC table (generic
// Dock icon) and PNG data in the 16/32 px icns slots (scrambled small icon).
const read = (name) => readFileSync(new URL(`../build/${name}`, import.meta.url));

function assertPng(buf, label) {
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${label}: PNG signature`);
  for (let p = 8; p < buf.length; ) {
    const len = buf.readUInt32BE(p);
    const type = buf.subarray(p + 4, p + 8);
    assert.equal(buf.readUInt32BE(p + 8 + len), crc32(buf.subarray(p + 4, p + 8 + len)), `${label}: ${type} CRC`);
    p += 12 + len;
  }
}

/** icns PackBits stream for one RGB image: must expand to exactly 3·n bytes. */
function unpackedLength(buf) {
  let out = 0;
  let i = 0;
  while (i < buf.length) {
    const c = buf[i];
    out += c < 0x80 ? c + 1 : c - 0x80 + 3;
    i += c < 0x80 ? c + 2 : 2;
  }
  return i === buf.length ? out : -1; // -1: the last code ran past the payload
}

test("icon.icns: classic RLE at 16/32 px, valid PNGs above", () => {
  const icns = read("icon.icns");
  assert.equal(icns.toString("ascii", 0, 4), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  const entries = new Map();
  for (let off = 8; off < icns.length; off += icns.readUInt32BE(off + 4)) {
    entries.set(icns.toString("ascii", off, off + 4), icns.subarray(off + 8, off + icns.readUInt32BE(off + 4)));
  }
  for (const type of ["icp4", "icp5", "icp6"]) assert.ok(!entries.has(type), `${type} renders scrambled inside an .app`);
  for (const [rgb, mask, size] of [["is32", "s8mk", 16], ["il32", "l8mk", 32]]) {
    assert.equal(unpackedLength(entries.get(rgb)), 3 * size * size, `${rgb} expands to 3 planes`);
    assert.equal(entries.get(mask).length, size * size, `${mask} is a raw mask`);
  }
  for (const type of ["ic07", "ic08", "ic09", "ic10", "ic11", "ic12", "ic13", "ic14"]) assertPng(entries.get(type), type);
});

test("icon.ico and icon.png: every PNG CRC is valid", () => {
  const ico = read("icon.ico");
  const sizes = [];
  for (let k = 0; k < ico.readUInt16LE(4); k++) {
    const e = 6 + k * 16;
    const size = ico[e] || 256;
    const data = ico.subarray(ico.readUInt32LE(e + 12), ico.readUInt32LE(e + 12) + ico.readUInt32LE(e + 8));
    if (data[0] === 0x89) assertPng(data, `ico ${size}`);
    else assert.equal(data.readInt32LE(8), size * 2, `ico ${size}: BMP height covers XOR + AND`);
    sizes.push(size);
  }
  for (const size of [16, 24, 32, 48, 256]) assert.ok(sizes.includes(size), `ico has ${size}px`);
  assertPng(read("icon.png"), "icon.png");
});
