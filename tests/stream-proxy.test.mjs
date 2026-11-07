/**
 * The real stream proxy (electron/stream-proxy.ts) on a loopback port. Stream resolution and
 * googlevideo are stubs the test steers: `resolve` says which file a resolution lands on, and the
 * upstream answers each file with its own bytes, so a body shows which file was served.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const ID = "dQw4w9WgXcQ";
const FILES = { a: { itag: 251, clen: 4000 }, b: { itag: 140, clen: 3000 } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let code = null;
async function startProxy() {
  code ??= build({
    entryPoints: [fileURLToPath(new URL("../electron/stream-proxy.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false,
    external: ["./music-service", "./local-library"],
  }).then((r) => r.outputFiles[0].text);
  const state = { file: "a", forbidOnce: false, resolves: [], upstream: [] };
  let server = null;
  const module = { exports: {} };
  vm.runInNewContext(await code, {
    module, exports: module.exports, URL, AbortController, setTimeout, clearTimeout,
    console: { log() {}, warn() {} },
    // googlevideo: a file answers any range with its own letter, an expired URL answers 403 once
    fetch: async (url, init) => {
      const name = new URL(url).pathname.slice(1);
      state.upstream.push(`${name} ${init.headers.Range ?? "-"}`);
      if (state.forbidOnce) {
        state.forbidOnce = false;
        return new Response(null, { status: 403 });
      }
      const start = Number(/^bytes=(\d+)-/.exec(init.headers.Range ?? "")?.[1] ?? 0);
      return new Response(name.repeat(8), {
        status: init.headers.Range ? 206 : 200,
        headers: { "content-type": "audio/webm", "content-range": `bytes ${start}-${start + 7}/${FILES[name].clen}` },
      });
    },
    require(name) {
      if (name === "./music-service") return {
        resolveStream: async (id, refresh, maxKbps) => {
          state.resolves.push(`${id} refresh=${refresh} kbps=${maxKbps}`);
          return { url: `https://upstream.invalid/${state.file}`, mime: "audio/webm", lufs: null, ...FILES[state.file] };
        },
        evictOldest: (map, max) => { while (map.size > max) map.delete(map.keys().next().value); },
      };
      if (name === "./local-library") return { localStreamPath: () => null };
      if (name === "http") return { ...http, createServer: (...args) => (server = http.createServer(...args)) };
      return require(name);
    },
  });
  const proxy = module.exports;
  await proxy.startStreamProxy();
  const get = async (url, range) => {
    const res = await fetch(url, { headers: range ? { Range: range } : {} });
    return { status: res.status, body: await res.text() };
  };
  const close = () => new Promise((r) => { server.closeAllConnections(); server.close(r); });
  return { proxy, state, get, close };
}

test("a mid-file range from a different file is refused (409); a fresh retry URL is served", async () => {
  const p = await startProxy();
  try {
    const url = p.proxy.proxyUrlFor(ID);
    assert.equal((await p.get(url, "bytes=0-")).body, "aaaaaaaa", "the player opens file a");
    assert.equal((await p.get(url, "bytes=1000-")).status, 206, "its own ranges are served");
    p.state.file = "b"; // a later resolution lands on another file
    const refused = await p.get(url, "bytes=2000-");
    assert.equal(refused.status, 409, "offsets into file a mean nothing in file b");
    assert.equal(refused.body, "", "not one byte of the other file");
    const retry = p.proxy.proxyUrlFor(ID, true);
    assert.notEqual(retry, url, "a retry is a new URL, so Chromium can't answer it from the old one's cache");
    const resumed = await p.get(retry, "bytes=2000-");
    assert.equal(resumed.status, 206, "the player's reload at its position is served");
    assert.equal(resumed.body, "bbbbbbbb");
    assert.equal((await p.get(url, "bytes=0-")).status, 206, "the old URL from the start is served again...");
    assert.equal((await p.get(url, "bytes=2000-")).status, 206, "...and its ranges now follow file b");
  } finally {
    await p.close();
  }
});

test("a range with no record, or from the start, is never refused", async () => {
  const p = await startProxy();
  try {
    p.state.file = "b";
    assert.equal((await p.get(p.proxy.proxyUrlFor(ID), "bytes=500-")).status, 206, "first request of a URL");
    p.state.file = "a";
    assert.equal((await p.get(p.proxy.proxyUrlFor(ID))).status, 200, "no Range at all");
  } finally {
    await p.close();
  }
});

test("a 403 heals on a fresh resolution; the guard still checks which file it landed on", async () => {
  const p = await startProxy();
  try {
    const url = p.proxy.proxyUrlFor(ID);
    await p.get(url, "bytes=0-");
    p.state.forbidOnce = true; // the URL expired; the refresh pins the same file
    const healed = await p.get(url, "bytes=1000-");
    assert.equal(healed.status, 206);
    assert.equal(healed.body, "aaaaaaaa");
    assert.equal(p.state.resolves.at(-1), `${ID} refresh=true kbps=undefined`, "the heal asks for a fresh URL");
    p.state.forbidOnce = true;
    p.state.file = "b"; // the refresh could not pin it
    assert.equal((await p.get(url, "bytes=1500-")).status, 409);
  } finally {
    await p.close();
  }
});

test("the retry token only renames the URL: seeks reuse the cached resolution, kbps rides along", async () => {
  const p = await startProxy();
  try {
    const plain = p.proxy.proxyUrlFor(ID);
    assert.equal(new URL(plain).search, `?id=${ID}`);
    const url = p.proxy.proxyUrlFor(ID, true, 64);
    const q = new URL(url).searchParams;
    assert.deepEqual([q.get("id"), q.get("kbps")], [ID, "64"]);
    assert.match(q.get("retry") ?? "", /^[0-9a-z]+$/);
    await p.get(url, "bytes=0-");
    await p.get(url, "bytes=900-");
    assert.deepEqual(p.state.resolves, [`${ID} refresh=false kbps=64`, `${ID} refresh=false kbps=64`], "no fresh resolution per seek");
    const first = p.proxy.proxyUrlFor(ID, true);
    await sleep(3);
    assert.notEqual(p.proxy.proxyUrlFor(ID, true), first, "each retry gets its own URL");
  } finally {
    await p.close();
  }
});
