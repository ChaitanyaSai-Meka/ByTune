import { test } from "node:test";
import assert from "node:assert/strict";
import { pickAudio, formatLufs, streamTtlMs } from "../.test-build/audio-format.mjs";

/* Format fixtures mirror the live youtubei.js v18 responses captured by
 * .lufs-probe.cjs for "Shape of You" (VISIONOS client): every format carries
 * loudnessDb=6.35 / track_absolute_loudness_lkfs=-7.65. */
const mk = (itag, mime, bitrate, extra = {}) => ({
  itag,
  mime_type: mime,
  bitrate,
  has_audio: true,
  has_video: false,
  url: `https://example/${itag}`,
  loudness_db: 6.35,
  track_absolute_loudness_lkfs: -7.65,
  ...extra,
});

const VISIONOS_SET = {
  streaming_data: {
    adaptive_formats: [
      mk(139, 'audio/mp4; codecs="mp4a.40.5"', 50213),
      mk(140, 'audio/mp4; codecs="mp4a.40.2"', 130613),
      mk(249, 'audio/webm; codecs="opus"', 60224),
      mk(250, 'audio/webm; codecs="opus"', 78320),
      mk(251, 'audio/webm; codecs="opus"', 151105),
    ],
  },
};

test("streaming picks Opus 251, not the mp4/AAC downgrade", async () => {
  const picked = await pickAudio(VISIONOS_SET, {}, undefined, false);
  assert.equal(picked.url, "https://example/251");
  assert.match(picked.mime, /webm/);
  assert.equal(picked.lufs, -7.65);
});

test("downloads keep mp4/AAC for portability", async () => {
  const picked = await pickAudio(VISIONOS_SET, {}, undefined, true);
  assert.equal(picked.url, "https://example/140");
  assert.match(picked.mime, /mp4/);
});

test("256k AAC (141) outranks Opus 251 when present", async () => {
  const info = {
    streaming_data: {
      adaptive_formats: [...VISIONOS_SET.streaming_data.adaptive_formats, mk(141, 'audio/mp4; codecs="mp4a.40.2"', 256000)],
    },
  };
  const stream = await pickAudio(info, {}, undefined, false);
  assert.equal(stream.url, "https://example/141");
  const download = await pickAudio(info, {}, undefined, true);
  assert.equal(download.url, "https://example/141");
});

test("low-quality ceiling picks Opus 249 over HE-AAC 139", async () => {
  const picked = await pickAudio(VISIONOS_SET, {}, 64, false);
  assert.equal(picked.url, "https://example/249");
});

test("ceiling with no under-cap format still streams the best", async () => {
  const picked = await pickAudio(VISIONOS_SET, {}, 10, false);
  assert.equal(picked.url, "https://example/251");
});

test("mp4Only falls back to best overall when no mp4 exists", async () => {
  const info = {
    streaming_data: {
      adaptive_formats: [mk(249, 'audio/webm; codecs="opus"', 60224), mk(251, 'audio/webm; codecs="opus"', 151105)],
    },
  };
  const picked = await pickAudio(info, {}, undefined, true);
  assert.equal(picked.url, "https://example/251");
});

test("unknown itags order by raw bitrate", async () => {
  const info = {
    streaming_data: {
      adaptive_formats: [
        mk(998, 'audio/webm; codecs="opus"', 90000),
        mk(999, 'audio/webm; codecs="opus"', 200000),
      ],
    },
  };
  const picked = await pickAudio(info, {}, undefined, false);
  assert.equal(picked.url, "https://example/999");
});

test("formatLufs prefers absolute LKFS, derives it from loudnessDb, else null", () => {
  assert.equal(formatLufs({ track_absolute_loudness_lkfs: -10.66, loudness_db: 3.34 }), -10.66);
  assert.equal(formatLufs({ loudness_db: 3.34 }), 3.34 - 14);
  assert.equal(formatLufs({}), null);
  assert.equal(formatLufs({ track_absolute_loudness_lkfs: "x", loudness_db: null }), null);
});

test("progressive-only streams still resolve", async () => {
  const info = { streaming_data: { formats: [mk(140, 'audio/mp4; codecs="mp4a.40.2"', 130613)] } };
  const picked = await pickAudio(info, {}, undefined, false);
  assert.equal(picked.url, "https://example/140");
});

test("a 128 kbps download ceiling keeps 128k AAC, whose peak bitrate reads ~130k", async () => {
  const standard = await pickAudio(VISIONOS_SET, {}, 128, true);
  assert.equal(standard.url, "https://example/140", "not the 48k HE-AAC fallback");
  const withAverage = {
    streaming_data: {
      adaptive_formats: [
        mk(139, 'audio/mp4; codecs="mp4a.40.5"', 50213, { average_bitrate: 48000 }),
        mk(140, 'audio/mp4; codecs="mp4a.40.2"', 145000, { average_bitrate: 129000 }),
      ],
    },
  };
  assert.equal((await pickAudio(withAverage, {}, 128, true)).url, "https://example/140", "the average decides when present");
});

test("the plain track wins over its stable-volume and dubbed copies that share the itag", async () => {
  const info = {
    streaming_data: {
      adaptive_formats: [
        mk(251, 'audio/webm; codecs="opus"', 160000, { is_drc: true, url: "https://example/251-drc" }),
        mk(251, 'audio/webm; codecs="opus"', 158000, { is_original: false, url: "https://example/251-dub" }),
        mk(251, 'audio/webm; codecs="opus"', 151105, { is_original: true, url: "https://example/251-plain" }),
      ],
    },
  };
  assert.equal((await pickAudio(info, {}, undefined, false)).url, "https://example/251-plain");
});

test("a pinned file wins outright, and a missing one falls back to the usual pick", async () => {
  const set = {
    streaming_data: {
      adaptive_formats: [
        mk(140, 'audio/mp4; codecs="mp4a.40.2"', 130613, { content_length: "3400000" }),
        mk(251, 'audio/webm; codecs="opus"', 151105, { content_length: "3900000" }),
      ],
    },
  };
  const first = await pickAudio(set, {}, undefined, false);
  assert.equal(first.itag, 251);
  assert.equal(first.clen, 3900000);
  const pinned = await pickAudio(set, {}, undefined, false, { itag: 140, clen: 3400000 });
  assert.equal(pinned.url, "https://example/140", "the file the player opened, though 251 ranks higher");
  const capped = await pickAudio(set, {}, 64, false, { itag: 251, clen: 3900000 });
  assert.equal(capped.url, "https://example/251", "the pin beats the quality cap mid-song");
  const gone = await pickAudio(set, {}, undefined, false, { itag: 251, clen: 1234 });
  assert.equal(gone.url, "https://example/251", "another file under the same itag isn't the pinned one");
  assert.equal(gone.clen, 3900000);
  const missing = await pickAudio(set, {}, undefined, false, { itag: 999 });
  assert.equal(missing.itag, 251, "a pin no client has falls back to the ranking");
});

test("a stream URL is reused until a little before its own expiry", () => {
  const now = 1_700_000_000_000;
  const at = (s) => Math.floor((now + s * 1000) / 1000);
  assert.equal(streamTtlMs(`https://rr1.googlevideo.com/videoplayback?expire=${at(6 * 3600)}&itag=251`, now), 6 * 3600_000 - 5 * 60_000);
  assert.equal(streamTtlMs(`https://rr1.googlevideo.com/videoplayback/expire/${at(3600)}/itag/251`, now), 3600_000 - 5 * 60_000, "path style");
  assert.equal(streamTtlMs(`https://x/videoplayback?expire=${at(60)}`, now), 0, "about to expire: don't reuse it");
  assert.equal(streamTtlMs(`https://x/videoplayback?expire=${at(30 * 3600)}`, now), 6 * 3600_000, "capped at 6 h");
  assert.equal(streamTtlMs("https://pipedproxy.example/audio.m4a", now), 10 * 60_000, "no expiry: 10 minutes");
});
