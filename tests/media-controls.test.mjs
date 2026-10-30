import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const require = createRequire(import.meta.url);

// electron/media-controls.ts: ByTune's own Windows media session, so the
// flyout gets the full-size cover instead of Chromium's 150px copy.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../electron/media-controls.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", external: ["electron"], write: false,
});
const tick = () => new Promise((r) => setImmediate(r));
const image = (bytes) => ({ ok: true, headers: { get: () => "image/jpeg" }, arrayBuffer: async () => Uint8Array.from(bytes).buffer });
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

function load({ platform = "win32", helper = true, readLocalArt = () => null } = {}) {
  const switches = [], children = [], fetches = [], actions = [];
  const spawn = (file, args) => {
    const c = new EventEmitter();
    Object.assign(c, { file, args, sent: [], killed: false });
    c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.stdin.on("data", (d) => c.sent.push(...String(d).split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    c.kill = () => { c.killed = true; c.emit("exit", null, "SIGTERM"); };
    children.push(c);
    return c;
  };
  const module = { exports: {} };
  vm.runInNewContext(outputFiles[0].text, {
    module, exports: module.exports, console, Buffer, AbortSignal, setTimeout, clearTimeout,
    __dirname: "C:\\app\\dist-electron",
    process: { platform, resourcesPath: "C:\\app\\resources" },
    fetch: (url) => new Promise((resolve) => fetches.push({ url, resolve })),
    require: (name) =>
      name === "electron" ? { app: { isPackaged: false, commandLine: { appendSwitch: (...a) => switches.push(a) } } }
      : name === "child_process" ? { spawn }
      : name === "fs" ? { existsSync: () => helper }
      : require(name),
  });
  const api = module.exports;
  // { ...a }: actions are built inside the vm realm; copy them into this one for deepEqual.
  const boot = () => { api.init(); api.start({ onAction: (a) => actions.push({ ...a }), readLocalArt }); };
  return { api, boot, switches, children, fetches, actions };
}

test("off Windows, or without the helper, Chromium keeps the media controls", () => {
  for (const opts of [{ platform: "darwin" }, { platform: "win32", helper: false }]) {
    const h = load(opts);
    h.boot();
    h.api.setTrack({ title: "t", artist: "a", album: "b", thumb: "https://x/y.jpg" });
    assert.equal(h.api.init(), false);
    assert.deepEqual(h.switches, []);
    assert.equal(h.children.length, 0);
  }
});

test("on Windows the helper takes over and Chromium's own session is switched off", () => {
  const h = load();
  assert.equal(h.api.init(), true);
  assert.deepEqual(h.switches, [["disable-features", "HardwareMediaKeyHandling"]]);
  h.api.start({ onAction() {}, readLocalArt: () => null });
  assert.equal(h.children.length, 1);
  assert.match(h.children[0].file, /ByTuneMedia\.exe$/);
});

test("the title shows at once and the full-size cover follows", async () => {
  const h = load();
  h.boot();
  h.api.setTrack({ title: "Sailor Song", artist: "Gigi Perez", album: "Sailor Song", thumb: "https://lh3.googleusercontent.com/abc=w120-h120-l90-rj" });
  await tick();
  const c = h.children[0];
  assert.deepEqual(c.sent.at(-1), { type: "display", title: "Sailor Song", artist: "Gigi Perez", album: "Sailor Song", cover: "" });
  assert.equal(h.fetches[0].url, "https://lh3.googleusercontent.com/abc=w1200-h1200-l90-rj");
  h.fetches[0].resolve(image([1, 2, 3]));
  await tick(); await tick();
  assert.deepEqual(c.sent.at(-1), { type: "display", title: "Sailor Song", artist: "Gigi Perez", album: "Sailor Song", cover: b64([1, 2, 3]) });
});

test("a slow cover never lands on the next track", async () => {
  const h = load();
  h.boot();
  h.api.setTrack({ title: "A", artist: "x", album: "x", thumb: "https://i.ytimg.com/vi/aaa/hqdefault.jpg" });
  h.api.setTrack({ title: "B", artist: "x", album: "x", thumb: "https://i.ytimg.com/vi/bbb/hqdefault.jpg" });
  h.fetches[1].resolve(image([2]));
  await tick(); await tick();
  h.fetches[0].resolve(image([1]));
  await tick(); await tick();
  const c = h.children[0];
  assert.deepEqual(c.sent.at(-1), { type: "display", title: "B", artist: "x", album: "x", cover: b64([2]) });
  assert.ok(!c.sent.some((m) => m.cover === b64([1])), "track A's cover was shown");
});

test("local covers come from the art cache; other schemes get no cover and no request", async () => {
  const h = load({ readLocalArt: (t) => (t === "localart://0123456789abcdef.jpg" ? Buffer.from([9]) : null) });
  h.boot();
  h.api.setTrack({ title: "L", artist: "x", album: "x", thumb: "localart://0123456789abcdef.jpg" });
  await tick(); await tick();
  assert.equal(h.children[0].sent.at(-1).cover, b64([9]));
  for (const thumb of ["http://192.168.0.1/x.jpg", "file:///C:/x.jpg", "javascript:alert(1)"]) {
    h.api.setTrack({ title: "R", artist: "x", album: "x", thumb });
    await tick();
    assert.equal(h.children[0].sent.at(-1).cover, "");
  }
  assert.equal(h.fetches.length, 0);
});

test("flyout buttons, media keys and seeks reach the renderer as media-session actions", async () => {
  const h = load();
  h.boot();
  const lines = [
    { type: "button", button: "play" }, { type: "button", button: "pause" },
    { type: "button", button: "next" }, { type: "button", button: "previous" },
    { type: "seek", position: 42.5 }, { type: "seek", position: -1 }, { type: "button", button: "rewind" },
  ];
  h.children[0].stdout.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
  await tick(); await tick();
  assert.deepEqual(h.actions, [
    { action: "play" }, { action: "pause" }, { action: "nexttrack" }, { action: "previoustrack" },
    { action: "seekto", seekTime: 42.5 },
  ]);
});

test("a crashed helper is restarted and shown the current track again, up to a limit", async () => {
  const h = load();
  h.boot();
  h.api.setTrack({ title: "S", artist: "x", album: "x", thumb: "https://i.ytimg.com/vi/sss/hqdefault.jpg" });
  h.fetches[0].resolve(image([7]));
  h.api.setPlaying(true);
  h.api.setPosition(30, 200);
  await tick(); await tick();
  h.children[0].emit("exit", 1, null);
  await tick();
  assert.equal(h.children.length, 2);
  assert.deepEqual(h.children[1].sent, [
    { type: "display", title: "S", artist: "x", album: "x", cover: b64([7]) },
    { type: "status", playing: true },
    { type: "timeline", position: 30, duration: 200 },
  ]);
  for (let i = 0; i < 5; i++) h.children.at(-1).emit("exit", 1, null);
  assert.equal(h.children.length, 4, "a crash loop must stop respawning");
});

test("quitting stops the helper for good", () => {
  const h = load();
  h.boot();
  h.api.stop();
  assert.equal(h.children[0].killed, true);
  assert.equal(h.children.length, 1);
});

test("hostile renderer input never throws", async () => {
  const h = load();
  h.boot();
  const hostile = [undefined, null, 42, "", [], { title: { toString: null } }, JSON.parse('{"__proto__":{"x":1}}'),
    { title: "A".repeat(1_000_000), artist: 7, album: null, thumb: { toString: null } }];
  for (const v of hostile) assert.doesNotThrow(() => h.api.setTrack(v));
  for (const v of hostile) assert.doesNotThrow(() => { h.api.setPosition(v, v); h.api.setPlaying(v); });
  await tick();
  const display = h.children[0].sent.filter((m) => m.type === "display");
  assert.ok(display.every((m) => typeof m.title === "string" && m.title.length <= 500 && m.cover === ""));
  const timelines = h.children[0].sent.filter((m) => m.type === "timeline");
  assert.ok(timelines.every((m) => m.duration > 0 && m.position >= 0 && m.position <= m.duration));
});
