/**
 * Cover bytes fetched by main for a page that can't read a cover's pixels itself
 * (electron/remote-art.ts): YouTube's thumbnail host (i.ytimg.com) sends no CORS header, so a page
 * can show its playlist and video covers but never read their colours. Main fetches only from that
 * host, only https, only images, only so much.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const mod = build({
  entryPoints: [fileURLToPath(new URL("../electron/remote-art.ts", import.meta.url))],
  bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
}).then((r) => import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString("base64")}`));

const COVER = "https://i.ytimg.com/pl_c/PLwR1545A9Prh/studio_square_thumbnail.jpg?sqp=abc&rs=def";

/** Swaps in a fetch that records what it was asked and answers with `respond`. */
function fakeFetch(respond) {
  const asked = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    asked.push({ url: String(url), init });
    return respond(String(url));
  };
  return { asked, restore: () => (globalThis.fetch = real) };
}
const image = (bytes, type = "image/jpeg", extra = {}) =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type, ...extra } });

test("a YouTube cover's bytes come back for the page to read", async () => {
  const { remoteArtBytes } = await mod;
  const f = fakeFetch(() => image([1, 2, 3]));
  try {
    const bytes = await remoteArtBytes(COVER);
    assert.deepEqual([...bytes], [1, 2, 3]);
    assert.equal(f.asked.length, 1);
    assert.equal(f.asked[0].init.redirect, "error", "a redirect could lead anywhere: refused");
    assert.ok(await remoteArtBytes("https://i9.ytimg.com/vi/abc/hqdefault.jpg"), "the numbered thumbnail hosts too");
  } finally {
    f.restore();
  }
});

test("anything but https from YouTube's thumbnail host is never fetched", async () => {
  const { remoteArtBytes } = await mod;
  const f = fakeFetch(() => image([1]));
  try {
    for (const url of [
      "http://i.ytimg.com/vi/abc/hqdefault.jpg",
      "https://example.com/cover.jpg",
      "https://i.ytimg.com.evil.example/cover.jpg",
      "https://evil.example/i.ytimg.com/cover.jpg",
      "https://user:pass@i.ytimg.com/cover.jpg",
      "https://i.ytimg.com:8443/cover.jpg",
      "https://127.0.0.1/cover.jpg",
      "file:///C:/Windows/win.ini",
      "localart://abc.jpg",
      "not a url",
      "",
    ]) {
      assert.equal(await remoteArtBytes(url), null, url);
    }
    assert.equal(f.asked.length, 0, "not one request went out");
  } finally {
    f.restore();
  }
});

test("only images, only up to 4 MB, and a failed or slow answer is just no cover", async () => {
  const { remoteArtBytes } = await mod;
  for (const [answer, why] of [
    [() => image([1], "text/html"), "not an image"],
    [() => image([1], "image/jpeg", { "content-length": String(5 * 1024 * 1024) }), "says it's too big"],
    [() => image(new Uint8Array(4 * 1024 * 1024 + 1)), "is too big"],
    [() => new Response("nope", { status: 404 }), "not found"],
    [() => { throw new TypeError("fetch failed"); }, "offline"],
  ]) {
    const f = fakeFetch(answer);
    try {
      assert.equal(await remoteArtBytes(COVER), null, why);
    } finally {
      f.restore();
    }
  }
});
